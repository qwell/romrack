import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import { sendServerError } from '../routes.js';
import { broadcastAppSocketEvent } from '../socket.js';
import {
    classifyTitleId,
    clearTitleScanCache,
    scanWiiUTitleRoots,
    validateWiiUTitleRoots,
} from '../wiiu.js';
import { convertWudImagesInRoots } from '../wud.js';
import { getStringQuery } from '../request.js';
import { clearAllTitleVerificationResults } from './title.js';
import {
    type LibraryResponse,
    type LibraryValidateResponse,
} from '../../shared/api.js';
import { getConfig } from '../../shared/config.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/shared.js';
import {
    LIBRARY_CONVERT_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_EVENT,
    LIBRARY_VALIDATE_SOCKET_COMMAND,
    LIBRARY_VALIDATE_SOCKET_EVENT,
    type LibraryConvertSocketCommand,
    type LibraryConvertItem,
    type LibraryValidateSocketCommand,
    type LibraryValidateStatusEvent,
} from '../../shared/socket.js';
import { TitleGroup, TitleKinds } from '../../shared/titles.js';

let latestLibraryValidateStatus: LibraryValidateStatusEvent | null = null;
let activeLibraryValidateAbortController: AbortController | null = null;
let libraryValidateStatusTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLibraryValidateStatus: LibraryValidateStatusEvent | null = null;
let libraryConversions: LibraryConvertItem[] = [];
let activeLibraryConvertId: string | null = null;
let activeLibraryConvertAbortController: AbortController | null = null;

let libraryGroups: TitleGroup[] = [];

export function setLibraryCacheGroups(groups: TitleGroup[]): void {
    libraryGroups = groups;
}

export function getLibraryCacheEntry(
    titleId: string
): { name: string; version: number | null; kind: TitleKinds | null } | null {
    const normalized = titleId.toLowerCase();
    const family = normalized.slice(8);
    const group = libraryGroups.find((g) => g.family === family);
    if (!group || !group.name) {
        return null;
    }
    const entry =
        group.entries.find((e) => e.titleId.toLowerCase() === normalized) ??
        null;
    return {
        name: group.name,
        version: entry?.version ?? null,
        kind: entry?.kind ?? null,
    };
}

export function getLatestLibraryValidateStatus(): LibraryValidateStatusEvent | null {
    return latestLibraryValidateStatus;
}

export function getLibraryConversions(): LibraryConvertItem[] {
    return libraryConversions;
}

function broadcastLibraryValidateStatus(
    event: LibraryValidateStatusEvent
): void {
    clearScheduledLibraryValidateStatus();
    latestLibraryValidateStatus = event;
    broadcastAppSocketEvent(event);
}

function scheduleLibraryValidateStatus(
    event: LibraryValidateStatusEvent
): void {
    pendingLibraryValidateStatus = event;

    if (libraryValidateStatusTimer !== null) {
        return;
    }

    libraryValidateStatusTimer = setTimeout(() => {
        libraryValidateStatusTimer = null;

        if (!pendingLibraryValidateStatus) {
            return;
        }

        const nextEvent = pendingLibraryValidateStatus;
        pendingLibraryValidateStatus = null;
        latestLibraryValidateStatus = nextEvent;
        broadcastAppSocketEvent(nextEvent);
    }, 200);
}

function clearScheduledLibraryValidateStatus(): void {
    if (libraryValidateStatusTimer !== null) {
        clearTimeout(libraryValidateStatusTimer);
        libraryValidateStatusTimer = null;
    }

    pendingLibraryValidateStatus = null;
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
            clearAllTitleVerificationResults();
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

    router.get('/validate', async (_req, res) => {
        const abortController = new AbortController();
        activeLibraryValidateAbortController = abortController;

        try {
            broadcastLibraryValidateStatus({
                type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                state: 'in-progress',
                status: 'started',
            });

            const titles = await validateWiiUTitleRoots(
                getConfig().wiiuRoots,
                (progress) => {
                    const event: LibraryValidateStatusEvent = {
                        type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                        state: 'in-progress',
                        ...progress,
                    };

                    if (
                        progress.status === 'validated' &&
                        progress.result === 'failed'
                    ) {
                        broadcastLibraryValidateStatus(event);
                    } else {
                        scheduleLibraryValidateStatus(event);
                    }
                },
                abortController.signal
            );
            const failed = titles.filter(
                (title) => title.status !== 'ok'
            ).length;

            clearTitleScanCache();
            broadcastLibraryValidateStatus({
                type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                state: failed === 0 ? 'complete' : 'failed',
                status: 'complete',
                total: titles.length,
                failed,
            });

            const response: LibraryValidateResponse = {
                status: failed === 0 ? 'ok' : 'failed',
                total: titles.length,
                failed,
                titles,
            };
            res.json(response);
        } catch (error) {
            if (abortController.signal.aborted) {
                broadcastLibraryValidateStatus({
                    type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                    state: 'cancelled',
                    status: 'cancelled',
                });
                const response: LibraryValidateResponse = {
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
            broadcastLibraryValidateStatus({
                type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                state: 'failed',
                status: 'failed',
                error: message,
            });

            logger.warn(
                'server',
                `Failed to validate library: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to validate library', error, {
                includeDetails: true,
            });
        } finally {
            if (activeLibraryValidateAbortController === abortController) {
                activeLibraryValidateAbortController = null;
            }
        }
    });

    router.get('/convert', (req, res) => {
        const titleId = getStringQuery(req, 'titleId');

        if (!titleId) {
            res.status(400).json({
                error: 'Missing titleId',
            });
            return;
        }

        const normalizedTitleId = titleId.toLowerCase();
        const cached = getLibraryCacheEntry(normalizedTitleId);
        const item: LibraryConvertItem = {
            id: randomUUID(),
            titleId: normalizedTitleId,
            name: cached?.name ?? null,
            kind: classifyTitleId(normalizedTitleId).kind,
            version: cached?.version ?? null,
            state: 'queued',
            currentFileName: null,
            current: null,
            total: null,
            currentFileSizeBytes: null,
            converted: null,
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
            if (activeLibraryConvertId === command.id) {
                cancelLibraryConversion(command.id);
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

    item.state = 'cancelled';
    item.currentFileName = null;
    item.currentFileSizeBytes = null;
    if (activeLibraryConvertId === id) {
        activeLibraryConvertAbortController?.abort();
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
    item.state = 'in-progress';
    broadcastLibraryConversions();

    try {
        const result = await convertWudImagesInRoots(
            getConfig().wiiuRoots,
            item.titleId,
            {
                onProgress: (progress) => {
                    if (
                        activeLibraryConvertId !== item.id ||
                        item.state !== 'in-progress'
                    ) {
                        return;
                    }
                    item.currentFileName = progress.currentFileName;
                    item.current = progress.completedFiles + 1;
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
        broadcastLibraryConversions();
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
    } finally {
        if (activeLibraryConvertId === item.id) {
            activeLibraryConvertId = null;
            activeLibraryConvertAbortController = null;
        }
        void processLibraryConvertQueue();
    }
}

export function handleLibraryValidateSocketCommand(
    command: LibraryValidateSocketCommand
): void {
    switch (command.type) {
        case LIBRARY_VALIDATE_SOCKET_COMMAND.cancel:
            activeLibraryValidateAbortController?.abort();
            return;
    }
}
