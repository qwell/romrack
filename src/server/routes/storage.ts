import { createReadStream, createWriteStream } from 'fs';
import { mkdir, realpath, rm, stat, unlink } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Router, type Request } from 'express';

import { sendServerError } from '../routes.js';
import { downloadNusTitleMetadata } from '../metadata.js';
import { broadcastAppSocketEvent } from '../socket.js';
import {
    classifyTitleId,
    findWiiUTitleSourcePaths,
    readWiiUTitleIdentity,
} from '../wiiu.js';
import { getConfig } from '../../shared/config.js';
import {
    getPathFileSizes,
    getPathStats,
    type PathFileSize,
} from '../../shared/file.js';
import logger from '../../shared/logger.js';
import {
    getRuntimeOs,
    listFat32Volumes,
    resolveFat32Destination,
    resolveReadablePath,
} from '../../shared/os.js';
import {
    formatLogError,
    formatTitleDisplayName,
    getStringQuery,
} from '../../shared/shared.js';
import type {
    StorageCopyItem,
    StorageCopyQueueItem,
    StorageDeleteItem,
    StorageDeleteQueueItem,
    StorageTransferQueueInput,
    StorageTransferQueueResult,
} from '../../shared/storage.js';
import type {
    StorageCopySocketCommand,
    StorageDeleteSocketCommand,
} from '../../shared/socket.js';
import { getLibraryCacheEntry } from '../../shared/wiiu.js';

export function createStorageRouter(): Router {
    const router = Router();

    router.get('/copy', (req, res) => {
        try {
            const result = queueStorageTransfer(
                getStorageTransferQueueInput(req, false)
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
        try {
            const result = queueStorageTransfer(
                getStorageTransferQueueInput(req, true)
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
        const titleId = getStringQuery(req, 'titleId');
        if (!titleId) {
            res.status(400).json({
                error: 'Missing titleId query parameter',
            });
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

            res.json({
                runtimeOs,
                volumes,
            });
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
): StorageTransferQueueResult {
    const requestedDestination = input.requestedDestination;
    const move = input.move;
    const copyId = randomUUID();
    const sourcePath = input.sourcePath;
    const titleId = input.titleId?.toLowerCase() ?? null;
    const operation = move ? 'move' : 'copy';
    const transferKey = getStorageTransferKey({
        sourcePath,
        titleId,
        requestedDestination,
        operation,
    });
    const existingItem =
        storageCopyQueue.find(
            (item) =>
                (item.state === 'queued' || item.state === 'copying') &&
                getStorageTransferKey({
                    sourcePath: item.sourcePath,
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
                sourcePath,
                titleId,
                requestedDestination,
                move,
                duplicate: true,
            },
        };
    }

    const cached = titleId ? getLibraryCacheEntry(titleId) : null;
    const titleKind = titleId ? classifyTitleId(titleId).kind : null;
    const sourceName = sourcePath
        ? getStorageCopySourceName(sourcePath)
        : cached
          ? formatTitleDisplayName(cached.name, titleId!, titleKind)
          : titleId
            ? formatTitleDisplayName(null, titleId, titleKind)
            : 'Wii U root';

    const copyItem: StorageCopyItem = {
        id: copyId,
        operation,
        titleId,
        sourceName,
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
        sourcePath,
        destinationPath: requestedDestination ?? '',
        currentFilePath: null,
        requestedSourcePath: sourcePath,
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
            sourcePath,
            titleId,
            requestedDestination,
            move,
        },
    };
}

function getStorageTransferQueueInput(
    req: Request,
    move: boolean
): StorageTransferQueueInput {
    return {
        sourcePath: getStringQuery(req, 'source'),
        titleId: getStringQuery(req, 'titleId'),
        requestedDestination: getStringQuery(req, 'dest'),
        move,
    };
}

function getStorageTransferKey({
    sourcePath,
    titleId,
    requestedDestination,
    operation,
}: {
    sourcePath: string | null;
    titleId: string | null;
    requestedDestination: string | null;
    operation: StorageCopyItem['operation'];
}): string {
    return [
        operation,
        sourcePath ?? '',
        titleId?.toLowerCase() ?? '',
        requestedDestination?.trim() ?? '',
    ].join('\0');
}

function queueStorageDelete(titleId: string): StorageTransferQueueResult {
    if (!/^[0-9a-f]{16}$/i.test(titleId)) {
        return {
            status: 400,
            body: {
                error: 'titleId query parameter must be 16 hexadecimal characters',
            },
        };
    }

    const normalizedTitleId = titleId.toLowerCase();
    const existingItem =
        storageDeleteQueue.find(
            (item) =>
                (item.state === 'queued' || item.state === 'deleting') &&
                item.titleId === normalizedTitleId
        ) ?? null;

    if (existingItem) {
        return {
            status: 200,
            body: {
                deleteId: existingItem.id,
                item: existingItem,
                duplicate: true,
            },
        };
    }

    const deleteId = randomUUID();
    const deleteTitleKind = classifyTitleId(normalizedTitleId).kind;
    const deleteCached = getLibraryCacheEntry(normalizedTitleId);
    const deleteItem: StorageDeleteItem = {
        id: deleteId,
        titleId: normalizedTitleId,
        titleName: formatTitleDisplayName(
            deleteCached?.name ?? null,
            normalizedTitleId,
            deleteTitleKind
        ),
        titleKind: deleteTitleKind,
        state: 'queued',
        message: 'Queued',
        deletedCount: 0,
        totalCount: null,
        error: null,
    };
    const queueItem: StorageDeleteQueueItem = {
        ...deleteItem,
        sourcePaths: [],
    };

    storageDeletes = [...storageDeletes, deleteItem];
    storageDeleteQueue = [...storageDeleteQueue, queueItem];

    broadcastStorageDeletes();
    void processStorageDeleteQueue();

    return {
        status: 202,
        body: {
            deleteId,
            item: deleteItem,
        },
    };
}

type StreamCopyProgress = {
    relativePath: string;
    fileSizeBytes: number;
    fileProgress: number;
    copiedBytes: number;
};

let storageCopyQueue: StorageCopyQueueItem[] = [];
let storageDeleteQueue: StorageDeleteQueueItem[] = [];
let broadcastStorageCopiesTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastStorageDeletesTimer: ReturnType<typeof setTimeout> | null = null;
let activeStorageDeleteId: string | null = null;

let activeStorageCopyId: string | null = null;
let activeStorageCopyAbortController: AbortController | null = null;

let storageCopies: StorageCopyItem[] = [];
let storageDeletes: StorageDeleteItem[] = [];

export function getStorageCopies(): StorageCopyItem[] {
    return storageCopies;
}

export function getStorageDeletes(): StorageDeleteItem[] {
    return storageDeletes;
}

const cancelledStorageCopyIds = new Set<string>();

export async function processStorageDeleteQueue(): Promise<void> {
    if (activeStorageDeleteId) {
        return;
    }

    const nextItem = storageDeleteQueue.find((item) => item.state === 'queued');

    if (!nextItem) {
        broadcastStorageDeletes();
        return;
    }

    activeStorageDeleteId = nextItem.id;
    nextItem.state = 'deleting';
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
            const sourcePaths = await findWiiUTitleSourcePaths(
                getConfig().wiiuRoots,
                nextItem.titleId
            );

            if (sourcePaths.length === 0) {
                throw new Error(`No local title found for ${nextItem.titleId}`);
            }

            const safeSourcePaths = await getSafeLocalDeletePaths(sourcePaths);
            if (safeSourcePaths.length === 0) {
                throw new Error(`No local title found for ${nextItem.titleId}`);
            }

            const titleIdentity = await readWiiUTitleIdentity(
                safeSourcePaths[0]
            ).catch(() => null);

            nextItem.sourcePaths = safeSourcePaths;
            nextItem.totalCount = safeSourcePaths.length;

            nextItem.titleKind = titleIdentity?.kind ?? null;
            const deleteCached = getLibraryCacheEntry(nextItem.titleId);
            nextItem.titleName = formatTitleDisplayName(
                deleteCached?.name ?? null,
                nextItem.titleId,
                nextItem.titleKind
            );

            void downloadNusTitleMetadata(nextItem.titleId)
                .then((metadata) => {
                    if (!metadata?.name) {
                        return;
                    }
                    const namedTitleName = formatTitleDisplayName(
                        metadata.name,
                        nextItem.titleId,
                        nextItem.titleKind
                    );
                    updateStorageDelete(nextItem.id, {
                        titleName: namedTitleName,
                    });
                })
                .catch(() => {});
            nextItem.message = 'Deleting...';

            updateStorageDelete(nextItem.id, {
                titleName: nextItem.titleName,
                titleKind: nextItem.titleKind,
                totalCount: nextItem.totalCount,
                message: nextItem.message,
            });
        }

        if (await hasConflictingStorageCopyPath(nextItem.sourcePaths)) {
            throw new Error(
                `Cannot delete ${nextItem.titleId} while it is queued or copying`
            );
        }

        const deletedCount = await deleteLocalTitleSourcePaths(
            nextItem.sourcePaths,
            (nextDeletedCount) => {
                nextItem.deletedCount = nextDeletedCount;
                nextItem.message = `Deleted ${nextDeletedCount}/${nextItem.totalCount ?? nextDeletedCount}`;
                updateStorageDeleteProgress(nextItem.id, {
                    deletedCount: nextItem.deletedCount,
                    message: nextItem.message,
                });
            }
        );

        nextItem.state = 'complete';
        nextItem.deletedCount = deletedCount;
        nextItem.message = 'Deleted';
        nextItem.error = null;

        updateStorageDelete(nextItem.id, {
            state: nextItem.state,
            deletedCount: nextItem.deletedCount,
            message: nextItem.message,
            error: nextItem.error,
        });
    } catch (error) {
        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);
        nextItem.message = nextItem.error;

        logger.error(
            'server',
            `Storage delete failed: ${formatLogError(error)}`
        );

        updateStorageDelete(nextItem.id, {
            state: nextItem.state,
            error: nextItem.error,
            message: nextItem.message,
            deletedCount: nextItem.deletedCount,
        });
    } finally {
        if (activeStorageDeleteId === nextItem.id) {
            activeStorageDeleteId = null;
        }

        void processStorageDeleteQueue();
    }
}

function scheduleBroadcastStorageCopies(): void {
    if (broadcastStorageCopiesTimer !== null) {
        return;
    }

    broadcastStorageCopiesTimer = setTimeout(() => {
        broadcastStorageCopiesTimer = null;
        broadcastStorageCopies();
    }, 200);
}

function broadcastStorageDeletes(): void {
    if (broadcastStorageDeletesTimer !== null) {
        clearTimeout(broadcastStorageDeletesTimer);
        broadcastStorageDeletesTimer = null;
    }

    broadcastAppSocketEvent({
        type: 'storage.deleteChanged',
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

export function updateStorageDelete(
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

    if (!item) {
        logger.warn('server', `storage copy clear ignored: missing id=${id}`);
        broadcastStorageCopies();
        return;
    }

    logger.log(
        'server',
        queueItem
            ? `storage ${queueItem.operation} cleared: ${queueItem.sourcePath} -> ${queueItem.destinationPath}`
            : `storage ${item.operation} cleared: ${item.sourceName} -> ${item.destinationName}`
    );

    if (activeStorageCopyId === id) {
        cancelledStorageCopyIds.add(id);
        activeStorageCopyAbortController?.abort();
        cancelStorageCopyProcess(id, item);
    }

    clearStorageCopyFromState(id);
    broadcastStorageCopies();

    if (activeStorageCopyId !== id) {
        void processStorageCopyQueue();
    }
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
        logger.warn('server', `storage copy cancel ignored: missing id=${id}`);
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

    cancelledStorageCopyIds.add(id);
    clearStorageCopyFromState(id);
    broadcastStorageCopies();

    try {
        if (wasActive) {
            activeStorageCopyAbortController?.abort();
            cancelStorageCopyProcess(id, item);
        }
    } catch (error) {
        logger.error(
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
        type: 'storage.copyChanged',
        items: storageCopies,
    });
}

export function handleStorageCopySocketCommand(
    command: StorageCopySocketCommand
): void {
    switch (command.type) {
        case 'storage.copy.cancel':
            cancelStorageCopy(command.id);
            return;

        case 'storage.copy.clear':
            clearStorageCopy(command.id);
            return;

        case 'storage.copy.retry':
            retryStorageCopy(command.id);
            return;
    }
}

function clearStorageDeleteFromState(id: string): StorageDeleteItem | null {
    const item =
        storageDeletes.find((candidate) => candidate.id === id) ?? null;

    storageDeletes = storageDeletes.filter((candidate) => candidate.id !== id);
    storageDeleteQueue = storageDeleteQueue.filter(
        (candidate) => candidate.id !== id
    );

    return item;
}

function clearStorageDelete(id: string): void {
    const item = clearStorageDeleteFromState(id);
    if (!item) {
        logger.warn('server', `storage delete clear ignored: missing id=${id}`);
    }
    broadcastStorageDeletes();
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
    void processStorageDeleteQueue();
}

export function handleStorageDeleteSocketCommand(
    command: StorageDeleteSocketCommand
): void {
    switch (command.type) {
        case 'storage.delete.clear':
            clearStorageDelete(command.id);
            return;

        case 'storage.delete.retry':
            retryStorageDelete(command.id);
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

    nextItem.state = 'copying';
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

        if (
            nextItem.requestedSourcePath !== null &&
            isInvalidStorageSourcePath(nextItem.requestedSourcePath)
        ) {
            throw new Error(
                `Invalid storage source path: ${nextItem.requestedSourcePath}`
            );
        }

        let sourcePath = nextItem.requestedSourcePath;
        let duplicateSourcePaths: string[] = [];

        if (sourcePath === null && nextItem.requestedTitleId !== null) {
            const sourcePaths = await findWiiUTitleSourcePaths(
                getConfig().wiiuRoots,
                nextItem.requestedTitleId
            );
            sourcePath = sourcePaths[0] ?? null;
            duplicateSourcePaths = sourcePaths.slice(1);
        }

        if (sourcePath === null && nextItem.requestedTitleId === null) {
            sourcePath = getConfig().wiiuRoots[0] ?? null;
        }

        if (!sourcePath) {
            throw new Error(
                nextItem.requestedTitleId === null
                    ? 'No Wii U root configured'
                    : `No local title found for ${nextItem.requestedTitleId}`
            );
        }

        const readableSourcePath = await resolveReadablePath(sourcePath);
        const titleIdentity = await readWiiUTitleIdentity(readableSourcePath);
        nextItem.sourcePath = readableSourcePath;
        nextItem.requestedSourcePath = sourcePath;
        nextItem.duplicateSourcePaths = duplicateSourcePaths;
        nextItem.titleId =
            nextItem.requestedTitleId ?? titleIdentity?.titleId ?? null;
        const resolvedTitleId =
            nextItem.requestedTitleId ?? titleIdentity?.titleId ?? null;
        nextItem.titleId = resolvedTitleId;
        nextItem.titleKind = titleIdentity?.kind ?? null;
        const copyCached = nextItem.titleId
            ? getLibraryCacheEntry(nextItem.titleId)
            : null;
        nextItem.sourceName = nextItem.titleId
            ? formatTitleDisplayName(
                  copyCached?.name ?? null,
                  nextItem.titleId,
                  nextItem.titleKind
              )
            : getStorageCopySourceName(readableSourcePath);

        updateStorageCopy(nextItem.id, {
            titleId: nextItem.titleId,
            sourceName: nextItem.sourceName,
            titleKind: nextItem.titleKind,
        });

        if (resolvedTitleId) {
            const copyId = nextItem.id;
            const kind = nextItem.titleKind;
            void downloadNusTitleMetadata(resolvedTitleId)
                .then((metadata) => {
                    if (!metadata?.name || shouldStopStorageCopy(copyId)) {
                        return;
                    }
                    const namedSourceName = formatTitleDisplayName(
                        metadata.name,
                        resolvedTitleId,
                        kind
                    );
                    updateStorageCopy(copyId, { sourceName: namedSourceName });
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
        const freeBytes = storageDestination.freeBytes;

        if (freeBytes !== null && sourceSizeBytes > freeBytes) {
            throw new Error('Not enough free space on destination');
        }

        const destinationPath = await getStreamCopyDestinationPath(
            readableSourcePath,
            storageDestination.source
        );

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

                const nextFilePath = getStorageCopyFileKey(
                    progressUpdate.relativePath
                );

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
            await deleteLocalTitleSourcePaths(nextItem.duplicateSourcePaths);
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

function getStorageCopyFileKey(filePath: string): string {
    return filePath.replaceAll('\\', '/').replace(/^\/+/, '');
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

function getStorageInstallRoot(destinationRoot: string): string {
    const usesWindowsPath = /^[A-Z]:(?:[\\/]|$)/i.test(destinationRoot);
    const pathApi = usesWindowsPath ? path.win32 : path.posix;
    const normalizedRoot = usesWindowsPath
        ? path.win32.normalize(
              /^[A-Z]:$/i.test(destinationRoot)
                  ? `${destinationRoot}\\`
                  : destinationRoot
          )
        : destinationRoot.replace(/[\\/]+$/, '');

    if (pathApi.basename(normalizedRoot).toLowerCase() === 'install') {
        return normalizedRoot;
    }

    return pathApi.join(normalizedRoot, 'install');
}

async function getStreamCopyDestinationPath(
    sourcePath: string,
    destinationRoot: string
): Promise<string> {
    let resolvedDestinationRoot: string;
    const installRoot = getStorageInstallRoot(destinationRoot);
    const isWindowsPath = /^[A-Z]:(?:[\\/]|$)/i.test(installRoot);
    if (isWindowsPath) {
        const resolvedPath = await resolveReadablePath(installRoot).catch(
            () => null
        );
        if (resolvedPath === null) {
            throw new Error(
                `Destination is not mounted in WSL: ${installRoot}. Mount the drive in WSL or run the server on Windows.`
            );
        }

        resolvedDestinationRoot = resolvedPath;
    } else {
        try {
            resolvedDestinationRoot = await resolveReadablePath(installRoot);
        } catch (error) {
            throw new Error(
                `Storage destination is not mounted in this runtime: ${installRoot}`,
                { cause: error }
            );
        }
    }

    return path.join(
        resolvedDestinationRoot,
        path.basename(sourcePath.replace(/[\\/]+$/, ''))
    );
}

function getStorageCopyDisplayName(filePath: string): string {
    const normalized = filePath.replace(/[\\/]+$/, '');
    return path.basename(normalized) || normalized;
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

function isInvalidStorageSourcePath(sourcePath: string): boolean {
    return sourcePath === 'undefined' || sourcePath === 'null';
}

async function getSafeLocalDeletePaths(
    sourcePaths: string[]
): Promise<string[]> {
    const rootPaths = await Promise.all(
        getConfig().wiiuRoots.map(async (root) => {
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
                `Refusing to delete path outside configured Wii U roots: ${sourcePath}`
            );
        }

        if (path.relative(containingRoot, realSourcePath) === '') {
            throw new Error(
                `Refusing to delete configured Wii U root: ${sourcePath}`
            );
        }

        deletePaths.push(realSourcePath);
    }

    return [...new Set(deletePaths)];
}

async function deleteLocalTitleSourcePaths(
    sourcePaths: string[],
    onProgress?: (deletedCount: number) => void
): Promise<number> {
    const deletePaths = await getSafeLocalDeletePaths(sourcePaths);
    let deletedCount = 0;

    for (const deletePath of deletePaths) {
        await rm(deletePath, {
            recursive: true,
            force: true,
        });
        deletedCount += 1;
        onProgress?.(deletedCount);
    }

    return deletedCount;
}

async function hasConflictingStorageCopyPath(
    sourcePaths: string[]
): Promise<boolean> {
    const deletePaths = await getSafeLocalDeletePaths(sourcePaths);

    for (const item of storageCopyQueue) {
        if (item.state !== 'queued' && item.state !== 'copying') {
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
        readStream.on('data', (chunk: Buffer) => {
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

function isSameOrNestedPath(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
}
