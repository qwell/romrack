import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import { broadcastAppSocketEvent } from '../socket.js';
import {
    clearTitleScanCache,
    getLibraryCacheEntry,
    scanWiiUTitleRoots,
    setLibraryCacheGroups,
    verifyWiiUTitleRoots,
} from '../wiiu.js';
import { convertWudImagesInRoots } from '../wud.js';
import { requireTitleIdQuery, sendServerError } from '../request.js';
import {
    abortAndClearTitleValidations,
    markTitleCopiesValidating,
    revalidateTitleCopies,
} from './title.js';
import {
    type LibraryResponse,
    type LibraryVerifyResponse,
} from '../../shared/api.js';
import { getConfig } from './config.js';
import logger from '../../shared/logger.js';
import { isTerminalActionState } from '../../shared/action.js';
import { formatLogError } from '../../shared/shared.js';
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
import { classifyTitleId } from '../../shared/titles.js';

let latestLibraryVerifyEvent: LibraryVerifyEvent | null = null;
const libraryVerifyFailures = new Map<string, LibraryVerifyEvent>();
let activeLibraryVerifyAbortController: AbortController | null = null;
let libraryVerifyEventTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLibraryVerifyEvent: LibraryVerifyEvent | null = null;
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

function broadcastLibraryConversions(): void {
    broadcastAppSocketEvent({
        type: LIBRARY_CONVERT_SOCKET_EVENT.changed,
        items: libraryConversions,
    });
}

export function createLibraryRouter(): Router {
    const router = Router();

    router.get('/', async (req, res) => {
        try {
            abortAndClearTitleValidations();
        } catch (error) {
            logger.warn(
                'server',
                `Failed to clear title verification cache: ${String(error)}`
            );
        }
        try {
            const groups = await scanWiiUTitleRoots(getConfig().wiiuRoots);

            setLibraryCacheGroups(groups);

            const response: LibraryResponse = {
                groups,
            };
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to scan library: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to scan library', error);
        }
    });

    router.get('/verify', async (_req, res) => {
        if (activeLibraryVerifyAbortController) {
            res.status(409).json({
                error: 'Library verification already in progress',
            });
            return;
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

            const titles = await verifyWiiUTitleRoots(
                getConfig().wiiuRoots,
                (progress) => {
                    const event: LibraryVerifyEvent = {
                        type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
                        state: 'in-progress',
                        ...progress,
                    };

                    if (progress.result === 'failed') {
                        clearScheduledLibraryVerifyEvent();
                        libraryVerifyFailures.set(progress.titleId, event);
                        broadcastAppSocketEvent(event);
                    } else {
                        scheduleLibraryVerifyEvent(event);
                    }
                },
                abortController.signal
            );
            const failed = titles.filter(
                (title) => title.status !== 'ok'
            ).length;

            clearTitleScanCache();
            broadcastLibraryVerifyEvent({
                type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
                state: 'complete',
                total: titles.length,
                failed,
            });

            const response: LibraryVerifyResponse = {
                status: failed === 0 ? 'ok' : 'failed',
                total: titles.length,
                failed,
                titles,
            };
            res.json(response);
        } catch (error) {
            if (abortController.signal.aborted) {
                broadcastLibraryVerifyEvent({
                    type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
                    state: 'cancelled',
                });
                const response: LibraryVerifyResponse = {
                    status: 'cancelled',
                    total: 0,
                    failed: 0,
                    titles: [],
                };
                res.json(response);
                return;
            }

            const message =
                error instanceof Error ? error.message : String(error);
            broadcastLibraryVerifyEvent({
                type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
                state: 'failed',
                error: message,
            });

            logger.warn(
                'server',
                `Failed to verify library: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to verify library', error, {
                includeDetails: true,
            });
        } finally {
            if (activeLibraryVerifyAbortController === abortController) {
                activeLibraryVerifyAbortController = null;
            }
        }
    });

    router.get('/convert', (req, res) => {
        const titleId = requireTitleIdQuery(req, res);
        if (titleId === null) {
            return;
        }

        const cached = getLibraryCacheEntry(titleId);
        const item: LibraryConvertItem = {
            id: randomUUID(),
            titleId,
            name: cached?.name ?? null,
            kind: classifyTitleId(titleId).kind,
            version: cached?.version ?? null,
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
        res.status(202).json({ conversionId: item.id, item });
    });

    return router;
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
            Object.assign(item, {
                state: 'queued',
                currentFileName: null,
                current: null,
                total: null,
                currentFileSizeBytes: null,
                converted: null,
                convertedTitles: null,
                error: null,
            } satisfies Partial<LibraryConvertItem>);
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
        markTitleCopiesValidating([...activeLibraryConvertSourcePaths.keys()]);
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
        const result = await convertWudImagesInRoots(
            getConfig().wiiuRoots,
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
        item.error = error instanceof Error ? error.message : String(error);
        logger.warn(
            'server',
            `Failed to convert WUD/WUX library entries: ${formatLogError(error)}`
        );
        broadcastLibraryConversions();
        clearTitleScanCache();
        revalidateTitleCopies(
            [...activeLibraryConvertSourcePaths].map(
                ([titleId, sourcePaths]) => ({
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
    }
}
