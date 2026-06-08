import { randomUUID } from 'crypto';
import { Router } from 'express';

import { requireStringQuery } from '../request.js';
import { sendServerError } from '../routes.js';
import { broadcastAppSocketEvent } from '../socket.js';
import {
    clearTitleScanCache,
    classifyTitleId,
    findWiiUTitleSourcePaths,
    readWiiUTitleIdentity,
} from '../wiiu.js';
import { getConfig } from '../../shared/config.js';
import { type DeleteItem, type DeleteQueueItem } from '../../shared/delete.js';
import {
    type ApiErrorResponse,
    type DeleteQueuedResponse,
} from '../../shared/api.js';
import logger from '../../shared/logger.js';
import {
    DELETE_SOCKET_COMMAND,
    DELETE_SOCKET_EVENT,
    type DeleteSocketCommand,
} from '../../shared/socket.js';
import { formatLogError, formatTitleDisplay } from '../../shared/shared.js';
import { getLibraryCacheEntry } from './library.js';
import { hasConflictingStorageCopyPath } from './storage.js';
import { realpath, rm } from 'fs/promises';
import { resolveReadablePath } from '../../shared/os.js';
import { isSameOrNestedPath } from '../../shared/file.js';

type RouteResult<TBody> = {
    status: number;
    body: TBody;
};

let deleteQueue: DeleteQueueItem[] = [];
let deletes: DeleteItem[] = [];
let broadcastDeletesTimer: ReturnType<typeof setTimeout> | null = null;
let activeDeleteId: string | null = null;

export function createDeleteRouter(): Router {
    const router = Router();

    router.get('/', (req, res) => {
        const titleId = requireStringQuery(
            req,
            res,
            'titleId',
            'Missing titleId query parameter'
        );
        if (!titleId) {
            return;
        }

        try {
            const result = queueDelete(titleId);
            res.status(result.status).json(result.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to queue delete: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to queue delete', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}

function queueDelete(
    titleId: string
): RouteResult<DeleteQueuedResponse | ApiErrorResponse> {
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
        deleteQueue.find(
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
    const deleteItem: DeleteItem = {
        id: deleteId,
        titleId: normalizedTitleId,
        titleName: formatTitleDisplay(
            deleteCached?.name ?? null,
            normalizedTitleId,
            deleteTitleKind,
            null
        ),
        titleVersion: deleteCached?.version ?? null,
        titleKind: deleteTitleKind,
        state: 'queued',
        message: 'Queued',
        deletedCount: 0,
        totalCount: null,
        error: null,
    };
    const queueItem: DeleteQueueItem = {
        ...deleteItem,
        sourcePaths: [],
    };

    deletes = [...deletes, deleteItem];
    deleteQueue = [...deleteQueue, queueItem];

    broadcastDeletes();
    void processDeleteQueue();

    return {
        status: 202,
        body: {
            deleteId,
            item: deleteItem,
        },
    };
}

export function getDeletes(): DeleteItem[] {
    return deletes;
}

async function processDeleteQueue(): Promise<void> {
    if (activeDeleteId) {
        return;
    }

    const nextItem = deleteQueue.find((item) => item.state === 'queued');

    if (!nextItem) {
        broadcastDeletes();
        return;
    }

    activeDeleteId = nextItem.id;
    nextItem.state = 'deleting';
    nextItem.message =
        nextItem.sourcePaths.length > 0
            ? 'Deleting...'
            : 'Finding local copies...';
    nextItem.error = null;
    nextItem.deletedCount = 0;
    nextItem.totalCount =
        nextItem.sourcePaths.length > 0 ? nextItem.sourcePaths.length : null;

    updateDelete(nextItem.id, {
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
            );

            nextItem.sourcePaths = safeSourcePaths;
            nextItem.totalCount = safeSourcePaths.length;

            nextItem.titleKind = titleIdentity?.kind ?? null;
            nextItem.titleVersion = titleIdentity?.version ?? null;
            const deleteCached = getLibraryCacheEntry(nextItem.titleId);
            nextItem.titleName = formatTitleDisplay(
                deleteCached?.name ?? null,
                nextItem.titleId,
                nextItem.titleKind,
                null
            );

            nextItem.message = 'Deleting...';

            updateDelete(nextItem.id, {
                titleName: nextItem.titleName,
                titleVersion: nextItem.titleVersion,
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
                updateDeleteProgress(nextItem.id, {
                    deletedCount: nextItem.deletedCount,
                    message: nextItem.message,
                });
            }
        );

        nextItem.state = 'complete';
        nextItem.deletedCount = deletedCount;
        nextItem.message = 'Deleted';
        nextItem.error = null;
        clearTitleScanCache();

        updateDelete(nextItem.id, {
            state: nextItem.state,
            deletedCount: nextItem.deletedCount,
            message: nextItem.message,
            error: nextItem.error,
        });
    } catch (error) {
        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);
        nextItem.message = nextItem.error;

        logger.warn('server', `Delete failed: ${formatLogError(error)}`);

        updateDelete(nextItem.id, {
            state: nextItem.state,
            error: nextItem.error,
            message: nextItem.message,
            deletedCount: nextItem.deletedCount,
        });
    } finally {
        if (activeDeleteId === nextItem.id) {
            activeDeleteId = null;
        }

        void processDeleteQueue();
    }
}

function broadcastDeletes(): void {
    if (broadcastDeletesTimer !== null) {
        clearTimeout(broadcastDeletesTimer);
        broadcastDeletesTimer = null;
    }

    broadcastAppSocketEvent({
        type: DELETE_SOCKET_EVENT.changed,
        items: deletes,
    });
}

function scheduleBroadcastDeletes(): void {
    if (broadcastDeletesTimer !== null) {
        return;
    }

    broadcastDeletesTimer = setTimeout(() => {
        broadcastDeletesTimer = null;
        broadcastDeletes();
    }, 200);
}

function updateDelete(
    id: string,
    update: Partial<Omit<DeleteItem, 'id'>>
): void {
    deletes = deletes.map((item) =>
        item.id === id ? { ...item, ...update } : item
    );
    broadcastDeletes();
}

function updateDeleteProgress(
    id: string,
    update: Partial<Omit<DeleteItem, 'id'>>
): void {
    deletes = deletes.map((item) =>
        item.id === id ? { ...item, ...update } : item
    );
    scheduleBroadcastDeletes();
}

function clearDeleteFromState(id: string): DeleteItem | null {
    const item = deletes.find((candidate) => candidate.id === id) ?? null;

    deletes = deletes.filter((candidate) => candidate.id !== id);
    deleteQueue = deleteQueue.filter((candidate) => candidate.id !== id);

    return item;
}

function clearDelete(id: string): void {
    const item = clearDeleteFromState(id);
    if (!item) {
        logger.log('server', `delete clear ignored: missing id=${id}`);
    }
    broadcastDeletes();
}

function retryDelete(id: string): void {
    const item = deleteQueue.find((candidate) => candidate.id === id);
    if (!item || item.state !== 'failed') {
        return;
    }

    logger.log('server', `delete retry queued: ${item.titleId}`);

    item.state = 'queued';
    item.error = null;
    item.message = 'Queued';
    item.deletedCount = 0;
    item.totalCount =
        item.sourcePaths.length > 0 ? item.sourcePaths.length : null;
    updateDelete(id, {
        state: item.state,
        error: item.error,
        message: item.message,
        deletedCount: item.deletedCount,
        totalCount: item.totalCount,
    });
    void processDeleteQueue();
}

export function handleDeleteSocketCommand(command: DeleteSocketCommand): void {
    switch (command.type) {
        case DELETE_SOCKET_COMMAND.clear:
            clearDelete(command.id);
            return;

        case DELETE_SOCKET_COMMAND.retry:
            retryDelete(command.id);
            return;
    }
}

export async function getSafeLocalDeletePaths(
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

        if (containingRoot === realSourcePath) {
            throw new Error(
                `Refusing to delete configured Wii U root: ${sourcePath}`
            );
        }

        deletePaths.push(realSourcePath);
    }

    return [...new Set(deletePaths)];
}

export async function deleteLocalTitleSourcePaths(
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
