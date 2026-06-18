import { createReadStream, createWriteStream } from 'fs';
import { mkdir, realpath, rm, stat, statfs, unlink } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Router, type Request, type Response } from 'express';

import {
    getStringQuery,
    requireWiiUTitleIdQuery,
    sendServerError,
} from '../request.js';
import { broadcastAppSocketEvent } from '../socket.js';
import { findWiiTitleSourcePaths, readWiiTitleIdentity } from '../wii.js';
import { findWiiUTitleSourcePaths, readWiiUTitleIdentity } from '../wiiu.js';
import {
    clearTitleScanCache,
    getCachedTitleSourcePaths,
    getLibraryCacheEntry,
} from '../library.js';
import { normalizeTitle, TitleKinds } from '../../shared/titles.js';
import { getConfig } from './config.js';
import {
    getPathFileSizes,
    getPathStats,
    isSameOrNestedPath,
    type PathFileSize,
} from '../../shared/file.js';
import logger from '../../shared/logger.js';
import { isTerminalActionState } from '../../shared/action.js';
import {
    getRuntimeOs,
    listFat32Volumes,
    resolveFat32Destination,
    resolveReadablePath,
} from '../../shared/os.js';
import {
    formatLogError,
    formatSize,
    formatTitleDisplay,
} from '../../shared/shared.js';
import {
    type StorageDeleteQueuedResponse,
    type StorageFat32ListResponse,
    type StorageTransferQueuedResponse,
} from '../../shared/api.js';
import {
    type StorageCopyItem,
    type StorageCopyQueueItem,
    type StorageDeleteItem,
    type StorageDeleteQueueItem,
    type StorageTransferQueueInput,
} from '../../shared/storage.js';
import {
    STORAGE_COPY_SOCKET_COMMAND,
    STORAGE_COPY_SOCKET_EVENT,
    STORAGE_DELETE_SOCKET_COMMAND,
    STORAGE_DELETE_SOCKET_EVENT,
    type StorageCopySocketCommand,
    type StorageDeleteSocketCommand,
} from '../../shared/socket.js';
import { markTitleCopiesValidating, revalidateTitleCopies } from './title.js';
import { downloadNusBaseMetadata } from '../title.js';

type RouteResult<TBody> = {
    status: number;
    body: TBody;
};

function requireStorageDeleteTitleIdQuery(
    req: Request,
    res: Response
): string | null {
    const titleId = getStringQuery(req, 'titleId');
    if (!titleId) {
        res.status(400).json({
            error: 'Missing titleId query parameter',
        });
        return null;
    }

    const normalizedTitle = normalizeTitle(titleId);
    if (!normalizedTitle) {
        res.status(400).json({
            error: 'titleId query parameter must be a Wii U title ID or Wii disc ID',
        });
        return null;
    }

    return normalizedTitle.titleId;
}

export function createStorageRouter(): Router {
    const router = Router();

    router.get('/copy', (req, res) => {
        const titleId = requireWiiUTitleIdQuery(req, res);
        if (titleId === null) {
            return;
        }

        try {
            const result = queueStorageTransfer(
                getStorageTransferQueueInput(req, titleId, false)
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to queue storage copy: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to queue storage copy', error, {
                includeDetails: true,
            });
        }
    });

    router.get('/move', (req, res) => {
        const titleId = requireWiiUTitleIdQuery(req, res);
        if (titleId === null) {
            return;
        }

        try {
            const result = queueStorageTransfer(
                getStorageTransferQueueInput(req, titleId, true)
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to queue storage move: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to queue storage move', error, {
                includeDetails: true,
            });
        }
    });

    router.get('/delete', (req, res) => {
        const titleId = requireStorageDeleteTitleIdQuery(req, res);
        if (titleId === null) {
            return;
        }

        try {
            const result = queueStorageDelete(titleId);
            res.status(result.status).json(result.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to queue storage delete: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to queue storage delete', error, {
                includeDetails: true,
            });
        }
    });

    router.get('/list-fat32', async (_req, res) => {
        try {
            const [runtimeOs, volumes] = await Promise.all([
                getRuntimeOs(),
                listFat32Volumes(),
            ]);

            const response: StorageFat32ListResponse = {
                runtimeOs,
                volumes,
            };
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to list FAT32 volumes: ${formatLogError(error)}`
            );

            sendServerError(res, 'Failed to list FAT32 volumes', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}

function queueStorageTransfer(
    input: StorageTransferQueueInput
): RouteResult<StorageTransferQueuedResponse> {
    const requestedDestination = input.requestedDestination;
    const move = input.move;
    const copyId = randomUUID();
    const titleId = input.titleId;
    const operation = move ? 'move' : 'copy';
    const transferKey = getStorageTransferKey({
        titleId,
        requestedDestination,
        operation,
    });
    const existingItem =
        storageCopyQueue.find(
            (item) =>
                (item.state === 'queued' || item.state === 'in-progress') &&
                getStorageTransferKey({
                    titleId: item.requestedTitleId,
                    requestedDestination: item.requestedDestination,
                    operation: item.operation,
                }) === transferKey
        ) ?? null;

    if (existingItem) {
        return {
            status: 200,
            body: {
                copyId: existingItem.id,
                item: existingItem,
                sourcePath: existingItem.sourcePath,
                titleId,
                requestedDestination,
                move,
                duplicate: true,
            },
        };
    }

    const cached = getLibraryCacheEntry(titleId);
    const titleKind = normalizeTitle(titleId)?.kind ?? TitleKinds.Unknown;
    const sourceName = cached
        ? formatTitleDisplay(cached.name, titleId, titleKind, cached.version)
        : formatTitleDisplay(null, titleId, titleKind);

    const copyItem: StorageCopyItem = {
        id: copyId,
        operation,
        titleId,
        sourceName,
        titleVersion: cached?.version ?? null,
        titleKind,
        destinationName: requestedDestination
            ? getStorageCopyDisplayName(requestedDestination)
            : '',
        state: 'queued',
        progress: null,
        message: 'Queued',
        sourceSizeBytes: null,
        completedFiles: 0,
        totalFiles: null,
        currentSizeBytes: null,
        currentFileName: null,
        error: null,
    };

    const queueItem: StorageCopyQueueItem = {
        ...copyItem,
        sourcePath: null,
        destinationPath: requestedDestination ?? '',
        currentFilePath: null,
        requestedDestination,
        requestedTitleId: titleId,
        duplicateSourcePaths: [],
    };

    storageCopies = [...storageCopies, copyItem];
    storageCopyQueue = [...storageCopyQueue, queueItem];

    broadcastStorageCopies();
    void processStorageCopyQueue();

    return {
        status: 202,
        body: {
            copyId,
            item: copyItem,
            sourcePath: null,
            titleId,
            requestedDestination,
            move,
        },
    };
}

function getStorageTransferQueueInput(
    req: Request,
    titleId: string,
    move: boolean
): StorageTransferQueueInput {
    return {
        titleId,
        requestedDestination: getStringQuery(req, 'dest'),
        move,
    };
}

function getStorageTransferKey({
    titleId,
    requestedDestination,
    operation,
}: {
    titleId: string;
    requestedDestination: string | null;
    operation: StorageCopyItem['operation'];
}): string {
    return [operation, titleId, requestedDestination?.trim() ?? ''].join('\0');
}

type StreamCopyProgress = {
    relativePath: string;
    fileSizeBytes: number;
    fileProgress: number;
    copiedBytes: number;
};

let storageCopyQueue: StorageCopyQueueItem[] = [];
let broadcastStorageCopiesTimer: ReturnType<typeof setTimeout> | null = null;

let activeStorageCopyId: string | null = null;
let activeStorageCopyAbortController: AbortController | null = null;

let storageCopies: StorageCopyItem[] = [];

export function getStorageCopies(): StorageCopyItem[] {
    return storageCopies;
}

const cancelledStorageCopyIds = new Set<string>();

function scheduleBroadcastStorageCopies(): void {
    if (broadcastStorageCopiesTimer !== null) {
        return;
    }

    broadcastStorageCopiesTimer = setTimeout(() => {
        broadcastStorageCopiesTimer = null;
        broadcastStorageCopies();
    }, 200);
}

function updateStorageCopy(
    id: string,
    update: Partial<Omit<StorageCopyItem, 'id'>>
): void {
    storageCopies = storageCopies.map((item) =>
        item.id === id ? { ...item, ...update } : item
    );
    broadcastStorageCopies();
}

function updateStorageCopyProgress(
    id: string,
    update: Partial<Omit<StorageCopyItem, 'id'>>
): void {
    storageCopies = storageCopies.map((item) =>
        item.id === id ? { ...item, ...update } : item
    );
    scheduleBroadcastStorageCopies();
}

function hasStorageCopyItem(id: string): boolean {
    return storageCopies.some((item) => item.id === id);
}

function retryStorageCopy(id: string): void {
    const item = storageCopyQueue.find((candidate) => candidate.id === id);
    if (!item || item.state !== 'failed') {
        return;
    }

    logger.log(
        'server',
        `storage ${item.operation} retry queued: ${item.sourcePath} -> ${item.destinationPath}`
    );

    item.state = 'queued';
    item.error = null;
    item.progress = null;
    item.message = 'Queued';
    item.completedFiles = 0;
    item.currentSizeBytes = null;
    item.currentFilePath = null;
    item.currentFileName = null;
    updateStorageCopy(id, {
        state: item.state,
        error: item.error,
        progress: item.progress,
        message: item.message,
        completedFiles: item.completedFiles,
        currentSizeBytes: item.currentSizeBytes,
        currentFileName: item.currentFileName,
    });
    void processStorageCopyQueue();
}

function clearStorageCopyFromState(id: string): StorageCopyItem | null {
    const item = storageCopies.find((candidate) => candidate.id === id) ?? null;

    storageCopies = storageCopies.filter((candidate) => candidate.id !== id);
    storageCopyQueue = storageCopyQueue.filter(
        (candidate) => candidate.id !== id
    );

    return item;
}

function clearStorageCopy(id: string): void {
    const item = storageCopies.find((candidate) => candidate.id === id);
    const queueItem =
        storageCopyQueue.find((candidate) => candidate.id === id) ?? null;

    if (!item || !isTerminalActionState(item.state)) {
        logger.log(
            'server',
            `storage copy clear ignored: id=${id} item=${item?.state ?? 'missing'}`
        );
        broadcastStorageCopies();
        return;
    }

    logger.log(
        'server',
        queueItem
            ? `storage ${queueItem.operation} cleared: ${queueItem.sourcePath} -> ${queueItem.destinationPath}`
            : `storage ${item.operation} cleared: ${item.sourceName} -> ${item.destinationName}`
    );

    clearStorageCopyFromState(id);
    broadcastStorageCopies();
    void processStorageCopyQueue();
}

function cancelStorageCopyProcess(id: string, item: StorageCopyItem): void {
    logger.log(
        'server',
        `storage ${item.operation} stream cancel requested: id=${id} ${item.sourceName} -> ${item.destinationName}`
    );
}

function cancelStorageCopy(id: string): void {
    const item = storageCopies.find((candidate) => candidate.id === id);
    const queueItem =
        storageCopyQueue.find((candidate) => candidate.id === id) ?? null;

    if (!item) {
        logger.log('server', `storage copy cancel ignored: missing id=${id}`);
        broadcastStorageCopies();
        return;
    }

    const wasActive = activeStorageCopyId === id;

    logger.log(
        'server',
        queueItem
            ? `storage ${queueItem.operation} cancel requested: ${queueItem.sourcePath} -> ${queueItem.destinationPath}`
            : `storage ${item.operation} cancel requested: ${item.sourceName} -> ${item.destinationName}`
    );

    if (wasActive) {
        cancelledStorageCopyIds.add(id);
    }
    if (queueItem) {
        queueItem.state = 'cancelled';
        queueItem.message = 'Cancelled';
        queueItem.currentFileName = null;
        queueItem.currentFilePath = null;
        queueItem.currentSizeBytes = null;
    }
    updateStorageCopy(id, {
        state: 'cancelled',
        message: 'Cancelled',
        currentFileName: null,
        currentSizeBytes: null,
    });
    broadcastStorageCopies();

    try {
        if (wasActive) {
            activeStorageCopyAbortController?.abort();
            cancelStorageCopyProcess(id, item);
            if (queueItem?.operation === 'move') {
                markTitleCopiesValidating([queueItem.requestedTitleId]);
            }
        }
    } catch (error) {
        logger.warn(
            'server',
            `Failed to cancel storage copy: ${formatLogError(error)}`
        );
    } finally {
        broadcastStorageCopies();

        if (!wasActive) {
            void processStorageCopyQueue();
        }
    }
}

function broadcastStorageCopies(): void {
    if (broadcastStorageCopiesTimer !== null) {
        clearTimeout(broadcastStorageCopiesTimer);
        broadcastStorageCopiesTimer = null;
    }

    broadcastAppSocketEvent({
        type: STORAGE_COPY_SOCKET_EVENT.changed,
        items: storageCopies,
    });
}

export function handleStorageCopySocketCommand(
    command: StorageCopySocketCommand
): void {
    switch (command.type) {
        case STORAGE_COPY_SOCKET_COMMAND.cancel:
            cancelStorageCopy(command.id);
            return;

        case STORAGE_COPY_SOCKET_COMMAND.clear:
            clearStorageCopy(command.id);
            return;

        case STORAGE_COPY_SOCKET_COMMAND.retry:
            retryStorageCopy(command.id);
            return;
    }
}

async function processStorageCopyQueue(): Promise<void> {
    if (activeStorageCopyId) {
        return;
    }

    const nextItem = storageCopyQueue.find((item) => item.state === 'queued');

    if (!nextItem) {
        broadcastStorageCopies();
        return;
    }

    activeStorageCopyId = nextItem.id;

    const abortController = new AbortController();
    activeStorageCopyAbortController = abortController;

    nextItem.state = 'in-progress';
    nextItem.progress = 0;
    nextItem.message =
        nextItem.operation === 'move'
            ? 'Preparing move...'
            : 'Preparing copy...';
    nextItem.error = null;

    updateStorageCopy(nextItem.id, {
        state: nextItem.state,
        progress: nextItem.progress,
        message: nextItem.message,
        error: nextItem.error,
    });

    let moveMutationStarted = false;
    let moveSourcePaths: string[] = [];

    try {
        const [runtimeOs, volumes] = await Promise.all([
            getRuntimeOs(),
            listFat32Volumes(),
        ]);

        if (shouldStopStorageCopy(nextItem.id)) {
            return;
        }

        const storageDestination = resolveFat32Destination(
            volumes,
            nextItem.requestedDestination
        );

        if (!storageDestination) {
            throw new Error(
                nextItem.requestedDestination
                    ? `Requested FAT32 volume was not found: ${nextItem.requestedDestination}`
                    : `No FAT32 volumes found for runtime OS: ${runtimeOs}`
            );
        }

        const sourcePaths = await findWiiUTitleSourcePaths(
            getConfig().wiiuRoots,
            nextItem.requestedTitleId
        );

        if (sourcePaths.length === 0) {
            throw new Error(
                `No local title found for ${nextItem.requestedTitleId}`
            );
        }

        const readableSourcePaths = await Promise.all(
            sourcePaths.map((path) => resolveReadablePath(path))
        );
        let sourceIndex: number | null = null;
        let destination: StreamCopyDestination | null = null;

        for (const [index, readablePath] of readableSourcePaths.entries()) {
            const candidateDestination = await getStreamCopyDestination(
                readablePath,
                storageDestination.source
            );
            if (
                !isSameOrNestedPath(readablePath, candidateDestination.path) &&
                !isSameOrNestedPath(candidateDestination.path, readablePath)
            ) {
                sourceIndex = index;
                destination = candidateDestination;
                break;
            }
        }

        if (sourceIndex === null || destination === null) {
            throw new Error(
                `No non-overlapping local title source found for ${nextItem.requestedTitleId}`
            );
        }

        const readableSourcePath = readableSourcePaths[sourceIndex];
        const titleIdentity = await readWiiUTitleIdentity(readableSourcePath);
        nextItem.sourcePath = readableSourcePath;
        nextItem.duplicateSourcePaths = sourcePaths.filter((_, index) => {
            const readablePath = readableSourcePaths[index];
            return (
                index !== sourceIndex &&
                readablePath !== undefined &&
                !isSameOrNestedPath(readablePath, destination.path) &&
                !isSameOrNestedPath(destination.path, readablePath)
            );
        });
        if (nextItem.operation === 'move') {
            moveSourcePaths = [
                readableSourcePath,
                ...nextItem.duplicateSourcePaths,
            ];
        }
        const resolvedTitleId = nextItem.requestedTitleId;
        nextItem.titleId = resolvedTitleId;
        nextItem.titleKind = titleIdentity?.kind ?? null;
        nextItem.titleVersion = titleIdentity?.version ?? null;
        const copyCached = nextItem.titleId
            ? getLibraryCacheEntry(nextItem.titleId)
            : null;
        nextItem.sourceName = nextItem.titleId
            ? formatTitleDisplay(
                  copyCached?.name ?? null,
                  nextItem.titleId,
                  nextItem.titleKind,
                  nextItem.titleVersion
              )
            : getStorageCopySourceName(readableSourcePath);

        updateStorageCopy(nextItem.id, {
            titleId: nextItem.titleId,
            sourceName: nextItem.sourceName,
            titleVersion: nextItem.titleVersion,
            titleKind: nextItem.titleKind,
        });

        if (resolvedTitleId) {
            const copyId = nextItem.id;
            const kind = nextItem.titleKind;
            void downloadNusBaseMetadata(resolvedTitleId)
                .then((metadata) => {
                    if (!metadata?.name || shouldStopStorageCopy(copyId)) {
                        return;
                    }
                    const namedSourceName = formatTitleDisplay(
                        metadata.name,
                        resolvedTitleId,
                        kind,
                        null
                    );
                    updateStorageCopy(copyId, {
                        sourceName: namedSourceName,
                        titleVersion: nextItem.titleVersion,
                    });
                })
                .catch(() => {});
        }

        if (shouldStopStorageCopy(nextItem.id)) {
            return;
        }

        const [sourceStats, sourceFileSizes] = await Promise.all([
            getPathStats(readableSourcePath),
            getPathFileSizes(readableSourcePath),
        ]);

        if (shouldStopStorageCopy(nextItem.id)) {
            return;
        }

        const sourceSizeBytes = sourceStats.sizeBytes;
        const sourceFileCount = sourceStats.fileCount;
        const destinationPath = destination.path;
        const freeBytes = destination.freeBytes ?? storageDestination.freeBytes;

        if (freeBytes !== null && sourceSizeBytes > freeBytes) {
            throw new Error(
                `Not enough free space on destination: need ${formatSize(sourceSizeBytes)}, available ${formatSize(freeBytes)}`
            );
        }

        if (shouldStopStorageCopy(nextItem.id)) {
            return;
        }

        nextItem.destinationPath = destinationPath;
        nextItem.destinationName = getStorageCopyDisplayName(destinationPath);
        nextItem.sourceSizeBytes = sourceSizeBytes;
        nextItem.totalFiles = sourceFileCount;
        nextItem.completedFiles = 0;
        nextItem.message =
            nextItem.operation === 'move' ? 'Moving...' : 'Copying...';

        updateStorageCopy(nextItem.id, {
            sourceName: nextItem.sourceName,
            titleKind: nextItem.titleKind,
            destinationName: nextItem.destinationName,
            sourceSizeBytes: nextItem.sourceSizeBytes,
            totalFiles: nextItem.totalFiles,
            completedFiles: nextItem.completedFiles,
            message: nextItem.message,
        });

        logger.log(
            'server',
            `storage ${nextItem.operation} stream started: ${readableSourcePath} -> ${destinationPath}`
        );

        let completedBytes = 0;
        let currentFilePath: string | null = null;
        let currentFileSizeBytes: number | null = null;

        moveMutationStarted = nextItem.operation === 'move';
        await copyPathWithStreams({
            sourcePath: readableSourcePath,
            destinationPath,
            files: sourceFileSizes,
            move: nextItem.operation === 'move',
            signal: abortController.signal,
            onProgress: (progressUpdate) => {
                if (
                    cancelledStorageCopyIds.has(nextItem.id) ||
                    !hasStorageCopyItem(nextItem.id) ||
                    abortController.signal.aborted
                ) {
                    return;
                }

                const nextFilePath = progressUpdate.relativePath;

                if (
                    currentFilePath !== null &&
                    currentFilePath !== nextFilePath
                ) {
                    completedBytes += currentFileSizeBytes ?? 0;
                    nextItem.completedFiles =
                        (nextItem.completedFiles ?? 0) + 1;
                }

                currentFilePath = nextFilePath;
                currentFileSizeBytes = progressUpdate.fileSizeBytes;
                nextItem.currentFilePath = progressUpdate.relativePath;
                nextItem.currentFileName = getStorageCopyDisplayName(
                    progressUpdate.relativePath
                );
                nextItem.currentSizeBytes = progressUpdate.fileSizeBytes;
                nextItem.message = nextItem.currentFileName;

                const nextProgress =
                    calculateStorageCopyByteProgress({
                        completedBytes,
                        currentFileSizeBytes,
                        currentFileProgress: progressUpdate.fileProgress,
                        totalBytes: nextItem.sourceSizeBytes,
                    }) ??
                    calculateStorageCopyProgress(
                        nextItem.completedFiles ?? 0,
                        nextItem.totalFiles,
                        progressUpdate.fileProgress
                    );
                if (nextProgress !== null) {
                    nextItem.progress = Math.max(
                        nextItem.progress ?? 0,
                        nextProgress
                    );
                }

                updateStorageCopyProgress(nextItem.id, {
                    progress: nextItem.progress,
                    message: nextItem.message,
                    completedFiles: nextItem.completedFiles,
                    currentSizeBytes: nextItem.currentSizeBytes,
                    currentFileName: nextItem.currentFileName,
                });
            },
        });

        if (
            cancelledStorageCopyIds.has(nextItem.id) ||
            !hasStorageCopyItem(nextItem.id) ||
            abortController.signal.aborted
        ) {
            return;
        }

        nextItem.state = 'complete';
        nextItem.progress = 100;
        nextItem.message = 'Done';
        nextItem.currentSizeBytes = null;
        nextItem.currentFilePath = null;
        nextItem.currentFileName = null;
        nextItem.error = null;

        if (nextItem.operation === 'move') {
            await deleteStorageTitleSourcePaths(nextItem.duplicateSourcePaths);
        }

        logger.log('server', `storage ${nextItem.operation} stream completed`);

        updateStorageCopy(nextItem.id, {
            state: nextItem.state,
            progress: nextItem.progress,
            message: nextItem.message,
            currentSizeBytes: nextItem.currentSizeBytes,
            currentFileName: nextItem.currentFileName,
            error: nextItem.error,
        });
    } catch (error) {
        if (
            cancelledStorageCopyIds.has(nextItem.id) ||
            abortController.signal.aborted
        ) {
            return;
        }

        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);
        nextItem.message = nextItem.error;

        logger.warn('server', `Storage copy failed: ${formatLogError(error)}`);

        updateStorageCopy(nextItem.id, {
            state: nextItem.state,
            error: nextItem.error,
            message: nextItem.message,
        });
    } finally {
        if (moveMutationStarted) {
            clearTitleScanCache();
            revalidateTitleCopies([
                {
                    titleId: nextItem.requestedTitleId,
                    sourcePaths: moveSourcePaths,
                },
            ]);
        }

        cancelledStorageCopyIds.delete(nextItem.id);

        if (activeStorageCopyId === nextItem.id) {
            activeStorageCopyId = null;

            if (activeStorageCopyAbortController === abortController) {
                activeStorageCopyAbortController = null;
            }
        }

        void processStorageCopyQueue();
    }
}

function calculateStorageCopyProgress(
    completedFiles: number,
    totalFiles: number | null,
    currentFileProgress: number | null
): number | null {
    if (totalFiles === null || totalFiles <= 0) {
        return currentFileProgress;
    }

    const currentFileFraction =
        currentFileProgress === null ? 0 : currentFileProgress / 100;
    const overallProgress =
        ((completedFiles + currentFileFraction) / totalFiles) * 100;

    return Math.min(100, Math.max(0, overallProgress));
}

function calculateStorageCopyByteProgress({
    completedBytes,
    currentFileSizeBytes,
    currentFileProgress,
    totalBytes,
}: {
    completedBytes: number;
    currentFileSizeBytes: number | null;
    currentFileProgress: number | null;
    totalBytes: number | null;
}): number | null {
    if (
        totalBytes === null ||
        totalBytes <= 0 ||
        currentFileSizeBytes === null ||
        currentFileProgress === null
    ) {
        return null;
    }

    const currentFileBytes =
        (currentFileSizeBytes *
            Math.min(100, Math.max(0, currentFileProgress))) /
        100;

    return Math.min(
        100,
        Math.max(0, ((completedBytes + currentFileBytes) / totalBytes) * 100)
    );
}

type StreamCopyDestination = {
    path: string;
    freeBytes: number | null;
};

async function getStreamCopyDestination(
    sourcePath: string,
    destinationRoot: string
): Promise<StreamCopyDestination> {
    const resolvedDestinationRoot =
        await ensureStorageInstallRoot(destinationRoot);

    return {
        path: path.join(resolvedDestinationRoot, path.basename(sourcePath)),
        freeBytes: await getStorageFreeBytes(resolvedDestinationRoot),
    };
}

async function ensureStorageInstallRoot(
    destinationRoot: string
): Promise<string> {
    let readableDestinationRoot: string;
    try {
        readableDestinationRoot = await resolveReadablePath(destinationRoot);
    } catch (error) {
        throw new Error(
            `Storage destination is not mounted in this runtime: ${destinationRoot}`,
            { cause: error }
        );
    }

    const resolvedDestinationRoot = path.join(
        readableDestinationRoot,
        'install'
    );
    await mkdir(resolvedDestinationRoot, { recursive: true });
    return resolvedDestinationRoot;
}

async function getStorageFreeBytes(
    storagePath: string
): Promise<number | null> {
    try {
        const stats = await statfs(storagePath);
        return stats.bavail * stats.bsize;
    } catch {
        return null;
    }
}

function getStorageCopyDisplayName(filePath: string): string {
    return path.basename(filePath) || filePath;
}

function getStorageCopySourceName(filePath: string): string {
    const displayName = getStorageCopyDisplayName(filePath);
    return (
        displayName
            .replace(/\s*\[[0-9a-f]{16}\]/gi, '')
            .replace(
                /\s*\[(Game|Base|Update|DLC|Demo|FCT|System App|System Data|System Applet|vWii|Unknown)\]/gi,
                ''
            )
            .trim() || displayName
    );
}

function shouldStopStorageCopy(itemId: string): boolean {
    return (
        cancelledStorageCopyIds.has(itemId) ||
        !hasStorageCopyItem(itemId) ||
        (activeStorageCopyId === itemId &&
            activeStorageCopyAbortController?.signal.aborted === true)
    );
}

export async function hasConflictingStorageCopyPath(
    deletePaths: string[]
): Promise<boolean> {
    for (const item of storageCopyQueue) {
        if (item.state !== 'queued' && item.state !== 'in-progress') {
            continue;
        }

        if (item.sourcePath === null) {
            continue;
        }

        const itemPath = await realpath(item.sourcePath).catch(() => null);
        if (itemPath === null) {
            continue;
        }

        if (
            deletePaths.some(
                (deletePath) =>
                    isSameOrNestedPath(deletePath, itemPath) ||
                    isSameOrNestedPath(itemPath, deletePath)
            )
        ) {
            return true;
        }
    }

    return false;
}

async function copyPathWithStreams({
    sourcePath,
    destinationPath,
    files,
    move,
    signal,
    onProgress,
}: {
    sourcePath: string;
    destinationPath: string;
    files: PathFileSize[];
    move: boolean;
    signal: AbortSignal;
    onProgress: (progress: StreamCopyProgress) => void;
}): Promise<void> {
    const sourceInfo = await stat(sourcePath);
    const sourceRoot = sourceInfo.isDirectory()
        ? sourcePath
        : path.dirname(sourcePath);

    if (sourceInfo.isDirectory()) {
        await mkdir(destinationPath, { recursive: true });
    } else {
        await mkdir(path.dirname(destinationPath), { recursive: true });
    }

    for (const file of files) {
        if (signal.aborted) {
            throw createStorageCopyCancelledError();
        }

        const sourceFilePath = path.join(sourceRoot, file.relativePath);
        const destinationFilePath = sourceInfo.isDirectory()
            ? path.join(destinationPath, file.relativePath)
            : destinationPath;
        await mkdir(path.dirname(destinationFilePath), { recursive: true });

        let copiedBytes = 0;
        const readStream = createReadStream(sourceFilePath);
        readStream.on('data', (chunk) => {
            copiedBytes += chunk.length;
            onProgress({
                relativePath: file.relativePath,
                fileSizeBytes: file.sizeBytes,
                fileProgress:
                    file.sizeBytes > 0
                        ? (copiedBytes / file.sizeBytes) * 100
                        : 100,
                copiedBytes,
            });
        });

        await pipeline(readStream, createWriteStream(destinationFilePath), {
            signal,
        });

        onProgress({
            relativePath: file.relativePath,
            fileSizeBytes: file.sizeBytes,
            fileProgress: 100,
            copiedBytes: file.sizeBytes,
        });

        if (move) {
            await unlink(sourceFilePath);
        }
    }

    if (move && sourceInfo.isDirectory()) {
        await rm(sourcePath, { recursive: true, force: true });
    }
}

function createStorageCopyCancelledError(): Error {
    const error = new Error('Storage copy cancelled');
    error.name = 'AbortError';
    return error;
}

let storageDeleteQueue: StorageDeleteQueueItem[] = [];
let storageDeletes: StorageDeleteItem[] = [];
let broadcastStorageDeletesTimer: ReturnType<typeof setTimeout> | null = null;
const STORAGE_DELETE_CONCURRENCY = 3;
const activeStorageDeleteIds = new Set<string>();
const activeStorageDeleteAbortControllers = new Map<string, AbortController>();
const activeStorageDeleteMutations = new Set<string>();

function queueStorageDelete(
    titleId: string
): RouteResult<StorageDeleteQueuedResponse> {
    const existingItem =
        storageDeleteQueue.find(
            (item) =>
                (item.state === 'queued' || item.state === 'in-progress') &&
                item.titleId === titleId
        ) ?? null;

    if (existingItem) {
        return {
            status: 200,
            body: {
                storageDeleteId: existingItem.id,
                item: existingItem,
                duplicate: true,
            },
        };
    }

    const storageDeleteId = randomUUID();
    const storageDeleteCached = getLibraryCacheEntry(titleId);
    const storageDeleteNormalized = normalizeTitle(titleId);
    const storageDeletePlatform =
        storageDeleteCached?.platform ??
        storageDeleteNormalized?.platform ??
        'wiiu';
    const storageDeleteTitleKind =
        storageDeleteCached?.kind ??
        storageDeleteNormalized?.kind ??
        TitleKinds.Unknown;
    const cachedSourcePaths = getCachedTitleSourcePaths(titleId);
    const storageDeleteItem: StorageDeleteItem = {
        id: storageDeleteId,
        titleId,
        titleName: formatTitleDisplay(
            storageDeleteCached?.name ?? null,
            titleId,
            storageDeleteTitleKind,
            storageDeleteCached?.version ?? null
        ),
        titleVersion: storageDeleteCached?.version ?? null,
        titleKind: storageDeleteTitleKind,
        state: 'queued',
        message: 'Queued',
        deletedCount: 0,
        totalCount:
            cachedSourcePaths.length > 0 ? cachedSourcePaths.length : null,
        error: null,
    };
    const queueItem: StorageDeleteQueueItem = {
        ...storageDeleteItem,
        platform: storageDeletePlatform,
        sourcePaths: cachedSourcePaths,
    };

    storageDeletes = [...storageDeletes, storageDeleteItem];
    storageDeleteQueue = [...storageDeleteQueue, queueItem];

    broadcastStorageDeletes();
    void processStorageDeleteQueue();

    return {
        status: 202,
        body: {
            storageDeleteId,
            item: storageDeleteItem,
        },
    };
}

export function getStorageDeletes(): StorageDeleteItem[] {
    return storageDeletes;
}

function processStorageDeleteQueue(): void {
    while (activeStorageDeleteIds.size < STORAGE_DELETE_CONCURRENCY) {
        const nextItem = storageDeleteQueue.find(
            (item) => item.state === 'queued'
        );
        if (!nextItem) {
            break;
        }

        activeStorageDeleteIds.add(nextItem.id);
        nextItem.state = 'in-progress';
        void processStorageDelete(nextItem);
    }

    if (activeStorageDeleteIds.size === 0) {
        broadcastStorageDeletes();
    }
}

async function processStorageDelete(
    nextItem: StorageDeleteQueueItem
): Promise<void> {
    const abortController = new AbortController();
    activeStorageDeleteAbortControllers.set(nextItem.id, abortController);
    nextItem.message =
        nextItem.sourcePaths.length > 0
            ? 'Deleting...'
            : 'Finding local copies...';
    nextItem.error = null;
    nextItem.deletedCount = 0;
    nextItem.totalCount =
        nextItem.sourcePaths.length > 0 ? nextItem.sourcePaths.length : null;

    updateStorageDelete(nextItem.id, {
        state: nextItem.state,
        message: nextItem.message,
        error: nextItem.error,
        deletedCount: nextItem.deletedCount,
        totalCount: nextItem.totalCount,
    });

    try {
        if (nextItem.sourcePaths.length === 0) {
            const config = getConfig();
            const sourcePaths =
                nextItem.platform === 'wii'
                    ? await findWiiTitleSourcePaths(
                          config.wiiRoots,
                          nextItem.titleId
                      )
                    : await findWiiUTitleSourcePaths(
                          config.wiiuRoots,
                          nextItem.titleId
                      );

            if (sourcePaths.length === 0) {
                throw new Error(`No local title found for ${nextItem.titleId}`);
            }

            nextItem.sourcePaths = sourcePaths;
            if (nextItem.sourcePaths.length === 0) {
                throw new Error(`No local title found for ${nextItem.titleId}`);
            }

            const titleIdentity =
                nextItem.platform === 'wii'
                    ? await readWiiTitleIdentity(nextItem.sourcePaths[0])
                    : await readWiiUTitleIdentity(nextItem.sourcePaths[0]);

            nextItem.totalCount = nextItem.sourcePaths.length;

            const storageDeleteCached = getLibraryCacheEntry(nextItem.titleId);
            nextItem.titleKind =
                titleIdentity?.kind ?? storageDeleteCached?.kind ?? null;
            nextItem.titleVersion =
                titleIdentity?.version ?? storageDeleteCached?.version ?? null;
            nextItem.titleName = formatTitleDisplay(
                storageDeleteCached?.name ?? null,
                nextItem.titleId,
                nextItem.titleKind,
                nextItem.titleVersion
            );

            nextItem.message = 'Deleting...';

            updateStorageDelete(nextItem.id, {
                titleName: nextItem.titleName,
                titleVersion: nextItem.titleVersion,
                titleKind: nextItem.titleKind,
                totalCount: nextItem.totalCount,
                message: nextItem.message,
            });
        }

        const safeSourcePaths = await getSafeStorageDeletePaths(
            nextItem.sourcePaths
        );
        nextItem.sourcePaths = safeSourcePaths;

        if (await hasConflictingStorageCopyPath(safeSourcePaths)) {
            throw new Error(
                `Cannot delete ${nextItem.titleId} while it is queued or copying`
            );
        }

        activeStorageDeleteMutations.add(nextItem.id);
        const deletedCount = await deleteSafeStorageTitleSourcePaths(
            safeSourcePaths,
            (nextDeletedCount) => {
                nextItem.deletedCount = nextDeletedCount;
                nextItem.message = `Deleted ${nextDeletedCount}/${nextItem.totalCount ?? nextDeletedCount}`;
                updateStorageDeleteProgress(nextItem.id, {
                    deletedCount: nextItem.deletedCount,
                    message: nextItem.message,
                });
            },
            abortController.signal
        );

        nextItem.state = 'complete';
        nextItem.deletedCount = deletedCount;
        nextItem.message = 'Deleted';
        nextItem.error = null;
        clearTitleScanCache();

        updateStorageDelete(nextItem.id, {
            state: nextItem.state,
            deletedCount: nextItem.deletedCount,
            message: nextItem.message,
            error: nextItem.error,
        });
    } catch (error) {
        if (abortController.signal.aborted) {
            return;
        }

        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);
        nextItem.message = nextItem.error;

        logger.warn(
            'server',
            `Storage delete failed: ${formatLogError(error)}`
        );

        updateStorageDelete(nextItem.id, {
            state: nextItem.state,
            error: nextItem.error,
            message: nextItem.message,
            deletedCount: nextItem.deletedCount,
        });
        if (activeStorageDeleteMutations.has(nextItem.id)) {
            clearTitleScanCache();
            revalidateTitleCopies([
                {
                    titleId: nextItem.titleId,
                    sourcePaths: nextItem.sourcePaths,
                },
            ]);
        }
    } finally {
        if (
            abortController.signal.aborted &&
            activeStorageDeleteMutations.has(nextItem.id)
        ) {
            clearTitleScanCache();
            revalidateTitleCopies([
                {
                    titleId: nextItem.titleId,
                    sourcePaths: nextItem.sourcePaths,
                },
            ]);
        }

        activeStorageDeleteIds.delete(nextItem.id);
        activeStorageDeleteAbortControllers.delete(nextItem.id);
        activeStorageDeleteMutations.delete(nextItem.id);
        processStorageDeleteQueue();
    }
}

function broadcastStorageDeletes(): void {
    if (broadcastStorageDeletesTimer !== null) {
        clearTimeout(broadcastStorageDeletesTimer);
        broadcastStorageDeletesTimer = null;
    }

    broadcastAppSocketEvent({
        type: STORAGE_DELETE_SOCKET_EVENT.changed,
        items: storageDeletes,
    });
}

function scheduleBroadcastStorageDeletes(): void {
    if (broadcastStorageDeletesTimer !== null) {
        return;
    }

    broadcastStorageDeletesTimer = setTimeout(() => {
        broadcastStorageDeletesTimer = null;
        broadcastStorageDeletes();
    }, 200);
}

function updateStorageDelete(
    id: string,
    update: Partial<Omit<StorageDeleteItem, 'id'>>
): void {
    storageDeletes = storageDeletes.map((item) =>
        item.id === id ? { ...item, ...update } : item
    );
    broadcastStorageDeletes();
}

function updateStorageDeleteProgress(
    id: string,
    update: Partial<Omit<StorageDeleteItem, 'id'>>
): void {
    storageDeletes = storageDeletes.map((item) =>
        item.id === id ? { ...item, ...update } : item
    );
    scheduleBroadcastStorageDeletes();
}

function removeStorageDeleteFromState(id: string): StorageDeleteItem | null {
    const item =
        storageDeletes.find((candidate) => candidate.id === id) ?? null;

    storageDeletes = storageDeletes.filter((candidate) => candidate.id !== id);
    storageDeleteQueue = storageDeleteQueue.filter(
        (candidate) => candidate.id !== id
    );

    return item;
}

function clearStorageDelete(id: string): void {
    const item = storageDeletes.find((candidate) => candidate.id === id);
    if (!item || !isTerminalActionState(item.state)) {
        logger.log(
            'server',
            `storage delete clear ignored: id=${id} item=${item?.state ?? 'missing'}`
        );
        broadcastStorageDeletes();
        return;
    }

    removeStorageDeleteFromState(id);
    broadcastStorageDeletes();
}

function cancelStorageDelete(id: string): void {
    const item = storageDeleteQueue.find((candidate) => candidate.id === id);
    if (!item || (item.state !== 'queued' && item.state !== 'in-progress')) {
        logger.log(
            'server',
            `storage delete cancel ignored: missing active id=${id}`
        );
        return;
    }

    const isActive = activeStorageDeleteIds.has(id);
    item.state = 'cancelled';
    item.message = 'Cancelled';
    if (isActive) {
        activeStorageDeleteAbortControllers.get(id)?.abort();
        if (activeStorageDeleteMutations.has(id)) {
            markTitleCopiesValidating([item.titleId]);
        }
    }
    updateStorageDelete(id, {
        state: item.state,
        message: item.message,
    });
    logger.log('server', `storage delete cancelled: ${item.titleId}`);
    processStorageDeleteQueue();
}

function retryStorageDelete(id: string): void {
    const item = storageDeleteQueue.find((candidate) => candidate.id === id);
    if (!item || item.state !== 'failed') {
        return;
    }

    logger.log('server', `storage delete retry queued: ${item.titleId}`);

    item.state = 'queued';
    item.error = null;
    item.message = 'Queued';
    item.deletedCount = 0;
    item.totalCount =
        item.sourcePaths.length > 0 ? item.sourcePaths.length : null;
    updateStorageDelete(id, {
        state: item.state,
        error: item.error,
        message: item.message,
        deletedCount: item.deletedCount,
        totalCount: item.totalCount,
    });
    processStorageDeleteQueue();
}

export function handleStorageDeleteSocketCommand(
    command: StorageDeleteSocketCommand
): void {
    switch (command.type) {
        case STORAGE_DELETE_SOCKET_COMMAND.clear:
            clearStorageDelete(command.id);
            return;

        case STORAGE_DELETE_SOCKET_COMMAND.cancel:
            cancelStorageDelete(command.id);
            return;

        case STORAGE_DELETE_SOCKET_COMMAND.retry:
            retryStorageDelete(command.id);
            return;
    }
}

export async function getSafeStorageDeletePaths(
    sourcePaths: string[]
): Promise<string[]> {
    const config = getConfig();
    const rootPaths = await Promise.all(
        [...config.wiiuRoots, ...config.wiiRoots].map(async (root) => {
            const readableRoot = await resolveReadablePath(root);
            return realpath(readableRoot);
        })
    );

    const deletePaths: string[] = [];

    for (const sourcePath of sourcePaths) {
        const readableSourcePath = await resolveReadablePath(sourcePath);
        const realSourcePath = await realpath(readableSourcePath);
        const containingRoot = rootPaths.find((rootPath) =>
            isSameOrNestedPath(rootPath, realSourcePath)
        );

        if (!containingRoot) {
            throw new Error(
                `Refusing to delete path outside configured roots: ${sourcePath}`
            );
        }

        if (containingRoot === realSourcePath) {
            throw new Error(
                `Refusing to delete configured root: ${sourcePath}`
            );
        }

        deletePaths.push(realSourcePath);
    }

    return [...new Set(deletePaths)];
}

export async function deleteStorageTitleSourcePaths(
    sourcePaths: string[],
    onProgress?: (deletedCount: number) => void,
    signal?: AbortSignal
): Promise<number> {
    signal?.throwIfAborted();
    const deletePaths = await getSafeStorageDeletePaths(sourcePaths);
    return deleteSafeStorageTitleSourcePaths(deletePaths, onProgress, signal);
}

async function deleteSafeStorageTitleSourcePaths(
    deletePaths: string[],
    onProgress?: (deletedCount: number) => void,
    signal?: AbortSignal
): Promise<number> {
    let deletedCount = 0;

    for (const deletePath of deletePaths) {
        signal?.throwIfAborted();
        await rm(deletePath, {
            recursive: true,
            force: true,
        });
        deletedCount += 1;
        onProgress?.(deletedCount);
    }

    return deletedCount;
}
