import { randomUUID } from 'node:crypto';

import { broadcastAppSocketEvent } from '../socket.js';
import {
    clearTitleScanCache,
    logTitleVerificationCompleted,
    logTitleVerificationStarted,
    type PreparedTitleVerification,
} from '../library.js';
import {
    findMissingExpectedWiiUVerifications,
    findWudImagePaths,
    prepareWiiUTitleVerifications,
    verifyPreparedWiiUTitle,
} from '../platforms/wiiu.js';
import {
    prepareGameCubeTitleVerifications,
    verifyPreparedGameCubeTitle,
} from '../platforms/gamecube.js';
import {
    prepareWiiTitleVerifications,
    verifyPreparedWiiTitle,
} from '../platforms/wii.js';
import {
    prepareThreeDSTitleVerifications,
    verifyPreparedThreeDSTitle,
} from '../platforms/3ds.js';
import { convertWudImages } from '../platforms/wiiu.js';
import { markTitleCopiesValidating, revalidateTitleCopies } from './titles.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyResponse,
} from '../../shared/api.js';
import { getConfig } from '../routes/config.js';
import logger from '../../shared/logger.js';
import { isTerminalActionState } from '../../shared/action.js';
import { formatLogError } from '../../shared/utils.js';
import {
    getTitlePlatformKey,
    type TitleIdentity,
} from '../../shared/titles.js';
import {
    LIBRARY_CONVERT_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_EVENT,
    LIBRARY_VERIFY_SOCKET_COMMAND,
    LIBRARY_VERIFY_SOCKET_EVENT,
    type LibraryConvertSocketCommand,
    type LibraryConvertItem,
    type LibraryVerifySocketCommand,
    type LibraryVerifyEvent,
} from '../../shared/socket.js';

let latestLibraryVerifyEvent: LibraryVerifyEvent | null = null;
const libraryVerifyFailures = new Map<string, LibraryVerifyEvent>();
let activeLibraryVerifyAbortController: AbortController | null = null;
type PendingLibraryTitleVerification = {
    platform: TitleIdentity['platform'];
    titleId: string;
    resolve: () => void;
};
const pendingLibraryTitleVerifications: PendingLibraryTitleVerification[] = [];
let libraryVerifyEventTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLibraryVerifyEvent: LibraryVerifyEvent | null = null;
let libraryVerifyProgressPlatform: LibraryVerifyProgress['platform'] | null =
    null;
let libraryConversions: LibraryConvertItem[] = [];
let activeLibraryConvertId: string | null = null;
let activeLibraryConvertAbortController: AbortController | null = null;
let activeLibraryConvertSourcePaths = new Map<string, Set<string>>();

export function getLibraryVerifyEvents(): LibraryVerifyEvent[] {
    return [
        ...(latestLibraryVerifyEvent ? [latestLibraryVerifyEvent] : []),
        ...libraryVerifyFailures.values(),
    ];
}

export function getLibraryConversions(): LibraryConvertItem[] {
    return libraryConversions;
}

function broadcastLibraryVerifyEvent(event: LibraryVerifyEvent): void {
    clearScheduledLibraryVerifyEvent();
    latestLibraryVerifyEvent = event;
    broadcastAppSocketEvent(event);
}

function scheduleLibraryVerifyEvent(event: LibraryVerifyEvent): void {
    pendingLibraryVerifyEvent = event;
    if (libraryVerifyEventTimer !== null) {
        return;
    }
    libraryVerifyEventTimer = setTimeout(() => {
        libraryVerifyEventTimer = null;
        if (!pendingLibraryVerifyEvent) {
            return;
        }
        const nextEvent = pendingLibraryVerifyEvent;
        pendingLibraryVerifyEvent = null;
        latestLibraryVerifyEvent = nextEvent;
        broadcastAppSocketEvent(nextEvent);
    }, 200);
}

function clearScheduledLibraryVerifyEvent(): void {
    if (libraryVerifyEventTimer !== null) {
        clearTimeout(libraryVerifyEventTimer);
        libraryVerifyEventTimer = null;
    }
    pendingLibraryVerifyEvent = null;
}

function handleLibraryVerifyProgress(progress: LibraryVerifyProgress): void {
    const platformChanged = libraryVerifyProgressPlatform !== progress.platform;
    if (platformChanged) {
        libraryVerifyProgressPlatform = progress.platform;
    }
    const event: LibraryVerifyEvent = {
        type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
        state: 'in-progress',
        ...progress,
    };
    if (progress.result === 'failed') {
        clearScheduledLibraryVerifyEvent();
        libraryVerifyFailures.set(
            getTitlePlatformKey(progress.platform, progress.titleId),
            event
        );
        broadcastAppSocketEvent(event);
    } else if (platformChanged) {
        broadcastLibraryVerifyEvent(event);
    } else {
        scheduleLibraryVerifyEvent(event);
    }
}

function broadcastLibraryConversions(): void {
    broadcastAppSocketEvent({
        type: LIBRARY_CONVERT_SOCKET_EVENT.changed,
        items: libraryConversions,
    });
}

export async function verifyLibrary(): Promise<LibraryVerifyResponse> {
    if (activeLibraryVerifyAbortController) {
        throw new Error('Library verification already in progress');
    }
    const abortController = new AbortController();
    activeLibraryVerifyAbortController = abortController;
    try {
        broadcastLibraryVerifyEvent({
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'in-progress',
            reset: true,
        });
        libraryVerifyFailures.clear();
        libraryVerifyProgressPlatform = null;
        const config = getConfig();
        const prepared = (
            await Promise.all([
                prepareThreeDSTitleVerifications(
                    config['3dsRoots'],
                    abortController.signal
                ),
                prepareGameCubeTitleVerifications(
                    config.gamecubeRoots,
                    abortController.signal
                ),
                prepareWiiTitleVerifications(
                    config.wiiRoots,
                    abortController.signal
                ),
                prepareWiiUTitleVerifications(
                    config.wiiuRoots,
                    abortController.signal
                ),
            ])
        )
            .flat()
            .sort((a, b) => {
                const options: Intl.CollatorOptions = {
                    sensitivity: 'base',
                };
                return (
                    a.name.localeCompare(b.name, undefined, options) ||
                    (a.region ?? '').localeCompare(
                        b.region ?? '',
                        undefined,
                        options
                    ) ||
                    a.directory.localeCompare(b.directory, undefined, options)
                );
            });
        const titles = await verifyPreparedLibraryTitles(
            prepared,
            abortController.signal,
            runPendingLibraryTitleVerifications
        );
        titles.push(
            ...(await findMissingExpectedWiiUVerifications(
                config.wiiuRoots,
                titles
            ))
        );
        const failed = titles.filter((title) => title.status !== 'ok').length;
        clearTitleScanCache();
        broadcastLibraryVerifyEvent({
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'complete',
            total: titles.length,
            failed,
        });
        return {
            status: failed === 0 ? 'ok' : 'failed',
            total: titles.length,
            failed,
            titles,
        };
    } catch (error) {
        if (abortController.signal.aborted) {
            broadcastLibraryVerifyEvent({
                type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
                state: 'cancelled',
            });
            return { status: 'cancelled', total: 0, failed: 0, titles: [] };
        }
        broadcastLibraryVerifyEvent({
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'failed',
            error: formatLogError(error),
        });
        throw error;
    } finally {
        if (activeLibraryVerifyAbortController === abortController) {
            activeLibraryVerifyAbortController = null;
        }
        void processPendingLibraryTitleVerifications();
    }
}

export async function verifyLibraryTitle(
    platform: TitleIdentity['platform'],
    titleId: string
): Promise<void> {
    if (activeLibraryVerifyAbortController) {
        return new Promise((resolve) => {
            pendingLibraryTitleVerifications.push({
                platform,
                titleId,
                resolve,
            });
        });
    }

    await runStandaloneLibraryTitleVerification(platform, titleId);
}

async function runStandaloneLibraryTitleVerification(
    platform: TitleIdentity['platform'],
    titleId: string
): Promise<void> {
    const abortController = new AbortController();
    activeLibraryVerifyAbortController = abortController;
    try {
        broadcastLibraryVerifyEvent({
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'in-progress',
            reset: true,
        });
        libraryVerifyProgressPlatform = null;

        await runLibraryTitleVerification(
            platform,
            titleId,
            abortController.signal,
            true
        );
    } catch (error) {
        if (abortController.signal.aborted) {
            broadcastLibraryVerifyEvent({
                type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
                state: 'cancelled',
            });
            return;
        }
        broadcastLibraryVerifyEvent({
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'failed',
            error: formatLogError(error),
        });
        logger.warn(
            'server',
            `Copied title verification failed: ${formatLogError(error)}`
        );
    } finally {
        if (activeLibraryVerifyAbortController === abortController) {
            activeLibraryVerifyAbortController = null;
        }
        void processPendingLibraryTitleVerifications();
    }
}

async function runLibraryTitleVerification(
    platform: TitleIdentity['platform'],
    titleId: string,
    signal: AbortSignal,
    broadcastCompletion: boolean
): Promise<void> {
    const prepared = (
        await preparePlatformTitleVerifications(platform, signal)
    ).filter((item) => item.titleId === titleId);
    const titles = await verifyPreparedLibraryTitles(prepared, signal);

    if (broadcastCompletion) {
        broadcastLibraryVerifyEvent({
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'complete',
            total: prepared.length,
            failed: titles.filter((title) => title.status !== 'ok').length,
        });
    }
}

async function runPendingLibraryTitleVerifications(): Promise<void> {
    while (pendingLibraryTitleVerifications.length > 0) {
        const pending = pendingLibraryTitleVerifications.shift();
        if (!pending) {
            return;
        }
        try {
            await runLibraryTitleVerification(
                pending.platform,
                pending.titleId,
                new AbortController().signal,
                false
            );
        } catch (error) {
            logger.warn(
                'server',
                `Priority title verification failed: ${formatLogError(error)}`
            );
        } finally {
            pending.resolve();
        }
    }
}

async function processPendingLibraryTitleVerifications(): Promise<void> {
    if (
        activeLibraryVerifyAbortController ||
        pendingLibraryTitleVerifications.length === 0
    ) {
        return;
    }

    const pending = pendingLibraryTitleVerifications.shift();
    if (!pending) {
        return;
    }
    try {
        await runStandaloneLibraryTitleVerification(
            pending.platform,
            pending.titleId
        );
    } finally {
        pending.resolve();
    }
}

async function preparePlatformTitleVerifications(
    platform: TitleIdentity['platform'],
    signal: AbortSignal
) {
    const config = getConfig();
    switch (platform) {
        case '3ds':
            return prepareThreeDSTitleVerifications(config['3dsRoots'], signal);
        case 'gamecube':
            return prepareGameCubeTitleVerifications(
                config.gamecubeRoots,
                signal
            );
        case 'wii':
            return prepareWiiTitleVerifications(config.wiiRoots, signal);
        case 'wiiu':
            return prepareWiiUTitleVerifications(config.wiiuRoots, signal);
    }
}

async function verifyPreparedPlatformTitle(
    item: PreparedTitleVerification,
    index: number,
    total: number,
    signal: AbortSignal
) {
    const args = [
        item,
        index,
        total,
        handleLibraryVerifyProgress,
        signal,
    ] as const;
    switch (item.platform) {
        case '3ds':
            return verifyPreparedThreeDSTitle(...args);
        case 'gamecube':
            return verifyPreparedGameCubeTitle(...args);
        case 'wii':
            return verifyPreparedWiiTitle(...args);
        case 'wiiu':
            return verifyPreparedWiiUTitle(...args);
    }
}

async function verifyPreparedLibraryTitles(
    prepared: PreparedTitleVerification[],
    signal: AbortSignal,
    afterEach?: () => Promise<void>
) {
    const titles = [];
    for (const [index, item] of prepared.entries()) {
        signal.throwIfAborted();
        logTitleVerificationStarted({
            logNamespace: item.platform,
            platform: item.platform,
            name: item.name,
            titleId: item.titleId,
            version: item.version,
            sizeText: item.sizeText,
        });
        const verifiedTitles = await verifyPreparedPlatformTitle(
            item,
            index,
            prepared.length,
            signal
        );
        titles.push(...verifiedTitles);
        for (const verifiedTitle of verifiedTitles) {
            logTitleVerificationCompleted({
                logNamespace: item.platform,
                platform: item.platform,
                name: item.name,
                titleId: item.titleId,
                version: item.version,
                status: verifiedTitle.status,
            });
        }
        await afterEach?.();
    }
    return titles;
}

export function queueLibraryConversion(
    input: Pick<LibraryConvertItem, 'titleId' | 'name' | 'kind' | 'version'>
): LibraryConvertItem {
    const item: LibraryConvertItem = {
        id: randomUUID(),
        ...input,
        state: 'queued',
        currentFileName: null,
        current: null,
        total: null,
        currentFileSizeBytes: null,
        converted: null,
        convertedTitles: null,
        error: null,
    };
    libraryConversions = [...libraryConversions, item];
    broadcastLibraryConversions();
    void processLibraryConvertQueue();
    return item;
}

export function handleLibraryConvertSocketCommand(
    command: LibraryConvertSocketCommand
): void {
    switch (command.type) {
        case LIBRARY_CONVERT_SOCKET_COMMAND.cancel:
            cancelLibraryConversion(command.id);
            return;
        case LIBRARY_CONVERT_SOCKET_COMMAND.clear:
            if (
                !libraryConversions.some(
                    (item) =>
                        item.id === command.id &&
                        isTerminalActionState(item.state)
                )
            ) {
                return;
            }
            libraryConversions = libraryConversions.filter(
                (item) => item.id !== command.id
            );
            broadcastLibraryConversions();
            void processLibraryConvertQueue();
            return;
        case LIBRARY_CONVERT_SOCKET_COMMAND.retry: {
            const item = libraryConversions.find(
                (candidate) => candidate.id === command.id
            );
            if (!item || item.state !== 'failed') {
                return;
            }
            const update: Partial<LibraryConvertItem> = {
                state: 'queued',
                currentFileName: null,
                current: null,
                total: null,
                currentFileSizeBytes: null,
                converted: null,
                convertedTitles: null,
                error: null,
            };
            Object.assign(item, update);
            broadcastLibraryConversions();
            void processLibraryConvertQueue();
            return;
        }
    }
}

function cancelLibraryConversion(id: string): void {
    const item = libraryConversions.find((candidate) => candidate.id === id);
    if (!item || (item.state !== 'queued' && item.state !== 'in-progress')) {
        return;
    }

    const isActive = activeLibraryConvertId === id;
    item.state = 'cancelled';
    item.currentFileName = null;
    item.currentFileSizeBytes = null;
    if (isActive) {
        activeLibraryConvertAbortController?.abort();
        clearTitleScanCache();
        markTitleCopiesValidating(
            [...activeLibraryConvertSourcePaths.keys()].map((titleId) => ({
                platform: 'wiiu',
                titleId,
            }))
        );
    }
    broadcastLibraryConversions();
    void processLibraryConvertQueue();
}

async function processLibraryConvertQueue(): Promise<void> {
    if (activeLibraryConvertId) {
        return;
    }

    const item = libraryConversions.find(
        (candidate) => candidate.state === 'queued'
    );
    if (!item) {
        broadcastLibraryConversions();
        return;
    }

    activeLibraryConvertId = item.id;
    const abortController = new AbortController();
    activeLibraryConvertAbortController = abortController;
    activeLibraryConvertSourcePaths = new Map();
    item.state = 'in-progress';
    broadcastLibraryConversions();

    try {
        const result = await convertWudImages(
            await findWudImagePaths(getConfig().wiiuRoots),
            item.titleId,
            {
                onProgress: (progress) => {
                    const sourcePaths =
                        activeLibraryConvertSourcePaths.get(progress.titleId) ??
                        new Set<string>();
                    sourcePaths.add(progress.outputDir);
                    activeLibraryConvertSourcePaths.set(
                        progress.titleId,
                        sourcePaths
                    );
                    if (
                        activeLibraryConvertId !== item.id ||
                        item.state !== 'in-progress'
                    ) {
                        return;
                    }
                    item.currentFileName = progress.currentFileName;
                    item.current = progress.completedFiles;
                    item.total = progress.totalFiles;
                    item.currentFileSizeBytes = progress.currentFileSizeBytes;
                    broadcastLibraryConversions();
                },
                signal: abortController.signal,
            }
        );
        if (
            activeLibraryConvertId !== item.id ||
            abortController.signal.aborted
        ) {
            return;
        }
        clearTitleScanCache();
        item.state = 'complete';
        item.currentFileName = null;
        item.currentFileSizeBytes = null;
        item.current = item.total;
        item.converted = result.converted.reduce(
            (total, image) => total + image.titles.length,
            0
        );
        item.convertedTitles = result.converted.flatMap((image) =>
            image.titles.map((title) => ({
                titleId: title.titleId,
                name: title.name,
                kind: title.kind,
                version: title.titleVersion,
                sizeBytes: title.sizeBytes,
            }))
        );
        broadcastLibraryConversions();
        revalidateTitleCopies(
            result.converted.flatMap((image) =>
                image.titles.map((title) => ({
                    platform: 'wiiu' as const,
                    titleId: title.titleId,
                    sourcePaths: [title.outputDir],
                }))
            )
        );
    } catch (error) {
        if (
            activeLibraryConvertId !== item.id ||
            abortController.signal.aborted
        ) {
            return;
        }
        item.state = 'failed';
        item.error = formatLogError(error);
        logger.warn(
            'server',
            `Failed to convert WUD/WUX library entries: ${formatLogError(error)}`
        );
        broadcastLibraryConversions();
        clearTitleScanCache();
        revalidateTitleCopies(
            [...activeLibraryConvertSourcePaths].map(
                ([titleId, sourcePaths]) => ({
                    platform: 'wiiu' as const,
                    titleId,
                    sourcePaths: [...sourcePaths],
                })
            )
        );
    } finally {
        if (abortController.signal.aborted) {
            clearTitleScanCache();
            revalidateTitleCopies(
                [...activeLibraryConvertSourcePaths].map(
                    ([titleId, sourcePaths]) => ({
                        platform: 'wiiu' as const,
                        titleId,
                        sourcePaths: [...sourcePaths],
                    })
                )
            );
        }
        if (activeLibraryConvertId === item.id) {
            activeLibraryConvertId = null;
            activeLibraryConvertAbortController = null;
            activeLibraryConvertSourcePaths = new Map();
        }
        void processLibraryConvertQueue();
    }
}

export function handleLibraryVerifySocketCommand(
    command: LibraryVerifySocketCommand
): void {
    switch (command.type) {
        case LIBRARY_VERIFY_SOCKET_COMMAND.cancel:
            activeLibraryVerifyAbortController?.abort();
            return;
        case LIBRARY_VERIFY_SOCKET_COMMAND.clear:
            libraryVerifyFailures.delete(command.id);
            return;
    }
}
