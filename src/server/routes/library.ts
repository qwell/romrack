import { Router } from 'express';

import { sendServerError } from '../routes.js';
import { broadcastAppSocketEvent } from '../socket.js';
import {
    clearTitleScanCache,
    scanWiiUTitleRoots,
    validateWiiUTitleRoots,
} from '../wiiu.js';
import { convertWudImagesInRoots } from '../wud.js';
import { getStringQuery } from '../request.js';
import { clearAllTitleVerificationResults } from './title.js';
import {
    type LibraryConvertResponse,
    type LibraryResponse,
    type LibraryValidateResponse,
} from '../../shared/api.js';
import { getConfig } from '../../shared/config.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/shared.js';
import {
    LIBRARY_CONVERT_SOCKET_EVENT,
    LIBRARY_VALIDATE_SOCKET_COMMAND,
    LIBRARY_VALIDATE_SOCKET_EVENT,
    type LibraryConvertStatusEvent,
    type LibraryValidateSocketCommand,
    type LibraryValidateStatusEvent,
} from '../../shared/socket.js';
import { TitleGroup, TitleKinds } from '../../shared/titles.js';

let latestLibraryValidateStatus: LibraryValidateStatusEvent | null = null;
let activeLibraryValidateAbortController: AbortController | null = null;
let libraryValidateStatusTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLibraryValidateStatus: LibraryValidateStatusEvent | null = null;

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

function broadcastLibraryConvertStatus(event: LibraryConvertStatusEvent): void {
    broadcastAppSocketEvent(event);
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
                status: 'started',
            });

            const titles = await validateWiiUTitleRoots(
                getConfig().wiiuRoots,
                (progress) => {
                    const event: LibraryValidateStatusEvent = {
                        type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
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
            const message =
                error instanceof Error ? error.message : String(error);
            broadcastLibraryValidateStatus({
                type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
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

    router.get('/convert', async (req, res) => {
        const titleId = getStringQuery(req, 'titleId');

        if (!titleId) {
            res.status(400).json({
                error: 'Missing titleId',
            });
            return;
        }

        try {
            broadcastLibraryConvertStatus({
                type: LIBRARY_CONVERT_SOCKET_EVENT.status,
                status: 'started',
                titleId,
            });
            const result = await convertWudImagesInRoots(
                getConfig().wiiuRoots,
                titleId,
                {
                    onProgress: (progress) => {
                        broadcastLibraryConvertStatus({
                            type: LIBRARY_CONVERT_SOCKET_EVENT.status,
                            status: 'converting',
                            titleId,
                            currentFileName: progress.currentFileName,
                            current: progress.completedFiles + 1,
                            total: progress.totalFiles,
                        });
                    },
                }
            );

            clearTitleScanCache();
            broadcastLibraryConvertStatus({
                type: LIBRARY_CONVERT_SOCKET_EVENT.status,
                status: 'complete',
                titleId,
                converted: result.converted.reduce(
                    (total, image) => total + image.titles.length,
                    0
                ),
            });
            const response: LibraryConvertResponse = {
                converted: result.converted.map((item) => ({
                    sourcePath: item.sourcePath,
                    titles: item.titles.map((title) => ({
                        name: title.name,
                        titleVersion: title.titleVersion,
                        outputDir: title.outputDir,
                        sizeBytes: title.sizeBytes,
                    })),
                })),
            };

            res.json(response);
        } catch (error) {
            broadcastLibraryConvertStatus({
                type: LIBRARY_CONVERT_SOCKET_EVENT.status,
                status: 'failed',
                titleId,
                error: error instanceof Error ? error.message : String(error),
            });
            logger.warn(
                'server',
                `Failed to convert WUD/WUX library entries: ${formatLogError(error)}`
            );
            sendServerError(
                res,
                'Failed to convert WUD/WUX library entries',
                error,
                {
                    includeDetails: true,
                }
            );
        }
    });

    return router;
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
