import express, { type Request, type Response } from 'express';
import open from 'open';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import path from 'node:path';

import { getAppRoot } from './paths.js';
import {
    getConfig,
    loadConfig,
    saveConfig,
    validateWiiURoot,
} from './config.js';
import {
    downloadNusTitleMetadata,
    generateTitleInstallFiles,
    getDlcMetadata,
    getUpdateMetadata,
    TitleDownloadProgress,
} from './metadata.js';
import { getCachedImage } from './image-cache.js';
import {
    classifyTitleId,
    findFirstReadableWiiURoot,
    findWiiUTitleSourcePaths,
    getTitleIconUrl,
    readWiiUTitleIdentity,
    scanWiiUTitleRoots,
    validateWiiUTitleRoots,
} from './wiiu.js';
import {
    AppSocketCommand,
    AppSocketEvent,
    DownloadSocketCommand,
    StorageCopySocketCommand,
    StorageDeleteSocketCommand,
    ValidationStatusEvent,
} from '../shared/socket.js';
import {
    type AppConfigResponse,
    type AppConfigUpdate,
    type AppConfigValidateRootResponse,
} from '../shared/config.js';
import {
    getRuntimeOs,
    listFat32Volumes,
    resolveReadablePath,
    resolveFat32Destination,
} from '../shared/os.js';
import {
    getPathFileSizes,
    getPathStats,
    type PathFileSize,
} from '../shared/file.js';
import logger from '../shared/logger.js';
import {
    DownloadQueueItem,
    StorageCopyItem,
    StorageDeleteItem,
} from '../shared/shared.js';
import { TitleGroup, TitleKinds } from '../shared/titles.js';

const config = loadConfig();

const app = express();
const host = config.host;
const port = config.port;

const clientDir = path.join(getAppRoot(), 'client');

type TitleIdQueryResult =
    | {
          ok: true;
          titleId: string;
      }
    | {
          ok: false;
          error: string;
      };

let libraryGroups: TitleGroup[] = [];

function getLibraryCacheEntry(
    titleId: string
): { name: string; kind: TitleKinds | null } | null {
    const normalized = titleId.toLowerCase();
    const family = normalized.slice(8);
    const group = libraryGroups.find((g) => g.family === family);
    if (!group || !group.name) {
        return null;
    }
    const kind =
        group.entries.find((e) => e.titleId.toLowerCase() === normalized)
            ?.kind ?? null;
    return { name: group.name, kind };
}

function getTitleKindDisplayName(kind: TitleKinds): string {
    return kind === TitleKinds.Base ? 'Game' : kind;
}

function formatTitleDisplayName(
    name: string | null,
    titleId: string,
    kind: TitleKinds | null
): string {
    const label = name ?? titleId;
    return kind ? `${label} [${getTitleKindDisplayName(kind)}]` : label;
}

function getConfigRootBodyValue(body: unknown): string {
    if (
        typeof body === 'object' &&
        body !== null &&
        'root' in body &&
        typeof body.root === 'string'
    ) {
        return body.root;
    }

    return '';
}

function getTitleIdQuery(req: Request): TitleIdQueryResult {
    const { titleId } = req.query;

    if (typeof titleId !== 'string' || titleId.length === 0) {
        return {
            ok: false,
            error: 'Missing titleId query parameter',
        };
    }

    if (!/^[0-9a-f]{16}$/i.test(titleId)) {
        return {
            ok: false,
            error: 'titleId query parameter must be 16 hexadecimal characters',
        };
    }

    return {
        ok: true,
        titleId: titleId.toLowerCase(),
    };
}

function requireTitleIdQuery(req: Request, res: Response): string | null {
    const result = getTitleIdQuery(req);
    if (result.ok) {
        return result.titleId;
    }

    res.status(400).json({
        error: result.error,
    });
    return null;
}

function getErrorStage(error: unknown): string | null {
    return typeof error === 'object' &&
        error !== null &&
        'stage' in error &&
        typeof error.stage === 'string'
        ? error.stage
        : null;
}

function sendServerError(
    res: Response,
    publicError: string,
    error: unknown,
    options: { includeDetails?: boolean } = {}
): void {
    const body: {
        error: string;
        message?: string;
        stage?: string | null;
    } = {
        error: publicError,
    };

    if (options.includeDetails) {
        body.message = error instanceof Error ? error.message : String(error);
        body.stage = getErrorStage(error);
    }

    res.status(500).json(body);
}

function getStringQuery(req: Request, name: string): string | null {
    const value = req.query[name];
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function createStorageCopyCancelledError(): Error {
    const error = new Error('Storage copy cancelled');
    error.name = 'AbortError';
    return error;
}

function formatSocketCommandArgs(command: AppSocketCommand): string {
    return JSON.stringify(
        Object.fromEntries(
            Object.entries(command).filter(([key]) => key !== 'type')
        )
    );
}

function handleAppSocketCommand(command: AppSocketCommand): void {
    logger.log(
        'server',
        `socket command dispatch: ${command.type} args=${formatSocketCommandArgs(command)}`
    );

    switch (command.type) {
        case 'download.queue':
        case 'download.retry':
        case 'download.remove':
        case 'download.cancel':
            handleDownloadSocketCommand(command);
            return;

        case 'storage.copy.retry':
        case 'storage.copy.remove':
        case 'storage.copy.cancel':
            handleStorageCopySocketCommand(command);
            return;

        case 'storage.delete.retry':
        case 'storage.delete.remove':
            handleStorageDeleteSocketCommand(command);
            return;
    }
}

let downloadQueue: DownloadQueueItem[] = [];
let storageCopies: StorageCopyItem[] = [];
let storageDeletes: StorageDeleteItem[] = [];

let activeDownloadItemId: string | null = null;
const activeDownloadAbortControllers = new Map<string, AbortController>();

let activeStorageCopyId: string | null = null;
let activeStorageCopyAbortController: AbortController | null = null;

const cancelledDownloadIds = new Set<string>();
const cancelledStorageCopyIds = new Set<string>();

let latestLibraryValidationStatus: ValidationStatusEvent | null = null;

type StorageCopyQueueItem = StorageCopyItem & {
    sourcePath: string | null;
    destinationPath: string;
    currentFilePath: string | null;
    requestedSourcePath: string | null;
    requestedDestination: string | null;
    requestedTitleId: string | null;
    duplicateSourcePaths: string[];
};

type StorageDeleteQueueItem = StorageDeleteItem & {
    sourcePaths: string[];
};

let storageCopyQueue: StorageCopyQueueItem[] = [];
let storageDeleteQueue: StorageDeleteQueueItem[] = [];
let broadcastStorageCopiesTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastStorageDeletesTimer: ReturnType<typeof setTimeout> | null = null;
let activeStorageDeleteId: string | null = null;

function sendAppSocketEvent(socket: WebSocket, event: AppSocketEvent): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify(event));
}

function broadcastAppSocketEvent(event: AppSocketEvent): void {
    for (const client of socketServer.clients) {
        sendAppSocketEvent(client, event);
    }
}

function broadcastDownloadQueue(): void {
    broadcastAppSocketEvent({
        type: 'download.queueChanged',
        items: downloadQueue,
    });
}

function getDownloadQueueKey(item: {
    family: string;
    kind: string;
    titleId: string;
}): string {
    return `${item.family}\0${item.kind}\0${item.titleId}`;
}

function hasDownloadQueueItem(id: string): boolean {
    return downloadQueue.some((item) => item.id === id);
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

function removeStorageCopyFromState(id: string): StorageCopyItem | null {
    const item = storageCopies.find((candidate) => candidate.id === id) ?? null;

    storageCopies = storageCopies.filter((candidate) => candidate.id !== id);
    storageCopyQueue = storageCopyQueue.filter(
        (candidate) => candidate.id !== id
    );

    return item;
}

function removeStorageCopy(id: string): void {
    const item = storageCopies.find((candidate) => candidate.id === id);
    const queueItem =
        storageCopyQueue.find((candidate) => candidate.id === id) ?? null;

    if (!item) {
        logger.log('server', `storage copy remove ignored: missing id=${id}`);
        broadcastStorageCopies();
        return;
    }

    logger.log(
        'server',
        queueItem
            ? `storage ${queueItem.operation} removed: ${queueItem.sourcePath} -> ${queueItem.destinationPath}`
            : `storage ${item.operation} removed: ${item.sourceName} -> ${item.destinationName}`
    );

    if (activeStorageCopyId === id) {
        cancelledStorageCopyIds.add(id);
        activeStorageCopyAbortController?.abort();
        cancelStorageCopyProcess(id, item);
    }

    removeStorageCopyFromState(id);
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

    cancelledStorageCopyIds.add(id);
    removeStorageCopyFromState(id);
    broadcastStorageCopies();

    try {
        if (wasActive) {
            activeStorageCopyAbortController?.abort();
            cancelStorageCopyProcess(id, item);
        }
    } catch (error) {
        logServerError('Failed to cancel storage copy:', error);
    } finally {
        broadcastStorageCopies();

        if (!wasActive) {
            void processStorageCopyQueue();
        }
    }
}

function broadcastLibraryValidationStatus(event: ValidationStatusEvent): void {
    latestLibraryValidationStatus = event;
    broadcastAppSocketEvent(event);
}

function handleStorageCopySocketCommand(
    command: StorageCopySocketCommand
): void {
    switch (command.type) {
        case 'storage.copy.cancel':
            cancelStorageCopy(command.id);
            return;

        case 'storage.copy.remove':
            removeStorageCopy(command.id);
            return;

        case 'storage.copy.retry':
            retryStorageCopy(command.id);
            return;
    }
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

function removeStorageDelete(id: string): void {
    const item = removeStorageDeleteFromState(id);
    if (!item) {
        logger.log('server', `storage delete remove ignored: missing id=${id}`);
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

function handleStorageDeleteSocketCommand(
    command: StorageDeleteSocketCommand
): void {
    switch (command.type) {
        case 'storage.delete.remove':
            removeStorageDelete(command.id);
            return;

        case 'storage.delete.retry':
            retryStorageDelete(command.id);
            return;
    }
}

function parseSocketCommand(data: RawData): AppSocketCommand | null {
    let parsed: unknown;
    try {
        const text = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
        parsed = JSON.parse(text) as unknown;
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const command = parsed as { type?: unknown };

    switch (command.type) {
        case 'download.queue': {
            const items = (command as { items?: unknown }).items;
            if (!Array.isArray(items)) {
                return null;
            }

            const isQueueItem = (
                value: unknown
            ): value is DownloadQueueItem => {
                if (!value || typeof value !== 'object') {
                    return false;
                }

                const item = value as Record<string, unknown>;
                return (
                    typeof item.id === 'string' &&
                    typeof item.family === 'string' &&
                    typeof item.groupName === 'string' &&
                    typeof item.label === 'string' &&
                    typeof item.titleId === 'string' &&
                    typeof item.kind === 'string' &&
                    (typeof item.sizeText === 'string' ||
                        item.sizeText === null) &&
                    (typeof item.totalBytes === 'number' ||
                        item.totalBytes === null)
                );
            };

            if (!items.every(isQueueItem)) {
                return null;
            }

            return parsed as AppSocketCommand;
        }

        case 'download.retry':
        case 'download.remove':
        case 'download.cancel':
        case 'storage.copy.remove':
        case 'storage.copy.retry':
        case 'storage.copy.cancel':
        case 'storage.delete.remove':
        case 'storage.delete.retry': {
            const id = (command as { id?: unknown }).id;
            if (typeof id !== 'string' || id.length === 0) {
                return null;
            }

            return parsed as AppSocketCommand;
        }

        default:
            return null;
    }
}

type DownloadTitleResult = {
    name: string | null;
    titleVersion: number | null;
    outputDir: string;
    sizeBytes: number;
};

async function downloadTitle(
    titleId: string,
    onProgress?: (progress: TitleDownloadProgress) => void,
    signal?: AbortSignal
): Promise<DownloadTitleResult> {
    const romRoot = await findFirstReadableWiiURoot(getConfig().wiiuRoots);

    return generateTitleInstallFiles(titleId, romRoot, {
        onProgress,
        signal,
    });
}

let broadcastDownloadQueueTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBroadcastDownloadQueue(): void {
    if (broadcastDownloadQueueTimer !== null) return;
    broadcastDownloadQueueTimer = setTimeout(() => {
        broadcastDownloadQueueTimer = null;
        broadcastDownloadQueue();
    }, 200);
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

type StreamCopyProgress = {
    relativePath: string;
    fileSizeBytes: number;
    fileProgress: number;
    copiedBytes: number;
};

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

function isSameOrNestedPath(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
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

async function processDownloadQueue(): Promise<void> {
    if (activeDownloadItemId) {
        return;
    }

    const nextItem = downloadQueue.find((item) => item.state === 'queued');

    if (!nextItem) {
        scheduleBroadcastDownloadQueue();
        return;
    }

    activeDownloadItemId = nextItem.id;

    const abortController = new AbortController();
    activeDownloadAbortControllers.set(nextItem.id, abortController);

    nextItem.state = 'downloading';
    nextItem.error = null;
    nextItem.progress = 0;
    nextItem.downloadedBytes = null;
    nextItem.speedText = null;
    nextItem.completedFiles = null;
    nextItem.totalFiles = null;
    nextItem.currentFileName = null;
    nextItem.installedSizeBytes = null;
    nextItem.installedVersion = null;
    nextItem.installedTitleName = null;
    nextItem.installedSourcePath = null;

    scheduleBroadcastDownloadQueue();

    try {
        const result = await downloadTitle(
            nextItem.titleId,
            (progress) => {
                if (
                    cancelledDownloadIds.has(nextItem.id) ||
                    !hasDownloadQueueItem(nextItem.id) ||
                    abortController.signal.aborted
                ) {
                    return;
                }

                nextItem.progress =
                    progress.totalFiles > 0
                        ? Math.round(
                              (progress.completedFiles / progress.totalFiles) *
                                  100
                          )
                        : 0;

                nextItem.downloadedBytes = null;
                nextItem.speedText = null;
                nextItem.completedFiles = progress.completedFiles;
                nextItem.totalFiles = progress.totalFiles;
                nextItem.currentFileName = progress.currentFileName;

                scheduleBroadcastDownloadQueue();
            },
            abortController.signal
        );

        if (
            cancelledDownloadIds.has(nextItem.id) ||
            !hasDownloadQueueItem(nextItem.id) ||
            abortController.signal.aborted
        ) {
            return;
        }

        nextItem.state = 'complete';
        nextItem.error = null;
        nextItem.progress = 100;
        nextItem.downloadedBytes = result.sizeBytes;
        nextItem.speedText = null;
        nextItem.completedFiles = null;
        nextItem.totalFiles = null;
        nextItem.currentFileName = null;
        nextItem.installedSizeBytes = result.sizeBytes;
        nextItem.installedVersion = result.titleVersion;
        nextItem.installedTitleName = result.name;
        nextItem.installedSourcePath = result.outputDir;

        broadcastDownloadQueue();
    } catch (error) {
        if (
            cancelledDownloadIds.has(nextItem.id) ||
            abortController.signal.aborted
        ) {
            return;
        }

        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);

        broadcastDownloadQueue();
    } finally {
        cancelledDownloadIds.delete(nextItem.id);
        activeDownloadAbortControllers.delete(nextItem.id);

        if (activeDownloadItemId === nextItem.id) {
            activeDownloadItemId = null;
        }

        void processDownloadQueue();
    }
}

function cancelActiveDownload(item: DownloadQueueItem): void {
    logger.log(
        'server',
        `download cancel requested: ${item.groupName} ${item.label} ${item.titleId}`
    );

    const key = getDownloadQueueKey(item);

    cancelledDownloadIds.add(item.id);

    const abortController = activeDownloadAbortControllers.get(item.id);
    abortController?.abort();

    logger.log(
        'server',
        `download abort signaled: id=${item.id} signalAborted=${abortController?.signal.aborted ? 'yes' : 'no'}`
    );

    downloadQueue = downloadQueue.filter(
        (candidate) => getDownloadQueueKey(candidate) !== key
    );

    broadcastDownloadQueue();
}

function handleDownloadSocketCommand(command: DownloadSocketCommand): void {
    switch (command.type) {
        case 'download.queue': {
            logger.log(
                'server',
                `download queue requested: ${command.items
                    .map(
                        (item) =>
                            `${item.id}:${item.groupName}:${item.kind}:${item.label}:${item.titleId}`
                    )
                    .join(',')}`
            );

            const existingKeys = new Set(
                downloadQueue
                    .filter((item) => item.state !== 'complete')
                    .map(getDownloadQueueKey)
            );

            const newItems = command.items.filter((item) => {
                const key = getDownloadQueueKey(item);

                if (existingKeys.has(key)) {
                    logger.log(
                        'server',
                        `download queue rejected: existing key=${JSON.stringify(key)} existing=${downloadQueue
                            .filter(
                                (candidate) =>
                                    getDownloadQueueKey(candidate) === key
                            )
                            .map(
                                (candidate) =>
                                    `${candidate.id}:${candidate.kind}:${candidate.titleId}:${candidate.state}`
                            )
                            .join(',')}`
                    );
                    return false;
                }

                existingKeys.add(key);
                return true;
            });

            if (newItems.length === 0) {
                logger.log('server', 'download queue ignored: no new items');
                return;
            }

            downloadQueue.push(
                ...newItems.map((item) => ({
                    ...item,
                    state: 'queued' as const,
                    error: null,
                    progress: 0,
                    downloadedBytes: null,
                    speedText: null,
                    completedFiles: null,
                    totalFiles: null,
                    currentFileName: null,
                    installedSizeBytes: null,
                    installedVersion: null,
                    installedTitleName: null,
                    installedSourcePath: null,
                }))
            );

            broadcastDownloadQueue();
            void processDownloadQueue();
            return;
        }

        case 'download.retry': {
            const item = downloadQueue.find(
                (candidate) => candidate.id === command.id
            );

            if (!item || item.state !== 'failed') {
                return;
            }

            logger.log(
                'server',
                `download retry queued: ${item.groupName} ${item.label} ${item.titleId}`
            );

            item.state = 'queued';
            item.error = null;
            item.progress = 0;
            item.downloadedBytes = null;
            item.speedText = null;
            item.completedFiles = null;
            item.totalFiles = null;
            item.currentFileName = null;
            item.installedSizeBytes = null;
            item.installedVersion = null;
            item.installedTitleName = null;
            item.installedSourcePath = null;

            broadcastDownloadQueue();
            void processDownloadQueue();
            return;
        }

        case 'download.remove': {
            const item = downloadQueue.find(
                (candidate) => candidate.id === command.id
            );

            if (!item) {
                logger.log(
                    'server',
                    `download remove ignored: id=${command.id} item=missing`
                );
                return;
            }

            const key = getDownloadQueueKey(item);
            const activeItem =
                downloadQueue.find(
                    (candidate) =>
                        candidate.state === 'downloading' &&
                        getDownloadQueueKey(candidate) === key
                ) ?? null;

            if (activeItem) {
                logger.log(
                    'server',
                    `download remove received for active item; cancelling: ${activeItem.groupName} ${activeItem.label} ${activeItem.titleId}`
                );

                cancelActiveDownload(activeItem);
                return;
            }

            logger.log(
                'server',
                `download removed: ${item.groupName} ${item.label} ${item.titleId}`
            );

            downloadQueue = downloadQueue.filter(
                (candidate) => getDownloadQueueKey(candidate) !== key
            );

            broadcastDownloadQueue();
            void processDownloadQueue();

            return;
        }

        case 'download.cancel': {
            const item = downloadQueue.find(
                (candidate) => candidate.id === command.id
            );

            if (!item) {
                logger.log(
                    'server',
                    `download cancel ignored: id=${command.id} item=missing`
                );
                return;
            }

            const key = getDownloadQueueKey(item);
            const activeItem =
                downloadQueue.find(
                    (candidate) =>
                        candidate.state === 'downloading' &&
                        getDownloadQueueKey(candidate) === key
                ) ?? null;

            if (activeItem) {
                cancelActiveDownload(activeItem);
                return;
            }

            const matchingQueuedItems = downloadQueue.filter(
                (candidate) =>
                    candidate.state === 'queued' &&
                    getDownloadQueueKey(candidate) === key
            );

            if (matchingQueuedItems.length > 0) {
                logger.log(
                    'server',
                    `download queued items removed: ${item.groupName} ${item.label} ${item.titleId}`
                );

                downloadQueue = downloadQueue.filter(
                    (candidate) => getDownloadQueueKey(candidate) !== key
                );

                broadcastDownloadQueue();
                return;
            }

            logger.log(
                'server',
                `download cancel ignored: id=${command.id} item=${item.state}:${item.titleId}`
            );

            return;
        }
    }
}

function shouldStopStorageCopy(itemId: string): boolean {
    return (
        cancelledStorageCopyIds.has(itemId) ||
        !hasStorageCopyItem(itemId) ||
        (activeStorageCopyId === itemId &&
            activeStorageCopyAbortController?.signal.aborted === true)
    );
}

function getErrorCause(error: Error): unknown {
    return 'cause' in error ? error.cause : undefined;
}

function formatLogError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const cause = getErrorCause(error);
    if (cause === undefined) {
        return error.message;
    }

    return `${error.message}; cause: ${formatLogError(cause)}`;
}

function logServerError(message: string, error: unknown): void {
    logger.error('server', `${message} ${formatLogError(error)}`);
}

type StorageTransferQueueInput = {
    sourcePath: string | null;
    titleId: string | null;
    requestedDestination: string | null;
    move: boolean;
};

type StorageTransferQueueResult = {
    status: number;
    body: Record<string, unknown>;
};

function isInvalidStorageSourcePath(sourcePath: string): boolean {
    return sourcePath === 'undefined' || sourcePath === 'null';
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

function formatUrlHost(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function getBrowserUrl(host: string, port: number): string {
    const browserHost =
        host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `http://${formatUrlHost(browserHost)}:${port}`;
}

function getListenUrl(host: string, port: number): string {
    return `http://${formatUrlHost(host)}:${port}`;
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

        logServerError('Storage copy failed:', error);

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

async function processStorageDeleteQueue(): Promise<void> {
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

        logServerError('Storage delete failed:', error);

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

app.use((req, _res, next) => {
    logger.log('server', `${req.method} ${req.url}`);
    next();
});

app.use(express.json());
app.use(
    express.static(clientDir, {
        etag: false,
        setHeaders(res) {
            res.setHeader('Cache-Control', 'no-store');
        },
    })
);

app.get('/api/config', (_req, res) => {
    const response: AppConfigResponse = {
        config: getConfig(),
        restartRequired: false,
    };
    logger.log('server', `config loaded: ${JSON.stringify(response)}`);
    res.json(response);
});

app.post('/api/config/validate-root', async (req, res) => {
    try {
        const root = getConfigRootBodyValue(req.body as unknown);
        const response: AppConfigValidateRootResponse =
            await validateWiiURoot(root);
        res.json(response);
    } catch (error) {
        logServerError('Failed to validate Wii U root:', error);
        sendServerError(res, 'Failed to validate Wii U root', error, {
            includeDetails: true,
        });
    }
});

app.post('/api/config', (req, res) => {
    try {
        const response: AppConfigResponse = saveConfig(
            req.body as AppConfigUpdate
        );
        logger.log('server', `config saved: ${JSON.stringify(response)}`);
        res.json(response);
    } catch (error) {
        logServerError('Failed to save config:', error);
        sendServerError(res, 'Failed to save config', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/library', async (req, res) => {
    try {
        const includeAll = req.query.includeAll === 'true';
        const groups = await scanWiiUTitleRoots(getConfig().wiiuRoots, {
            includeAll,
        });

        libraryGroups = groups;
        res.json({
            groups,
        });
    } catch (error) {
        logServerError('Failed to scan library:', error);
        sendServerError(res, 'Failed to scan library', error);
    }
});

app.get('/api/library/validate', async (_req, res) => {
    try {
        broadcastLibraryValidationStatus({
            type: 'library.validationStatus',
            status: 'started',
        });

        const titles = await validateWiiUTitleRoots(
            getConfig().wiiuRoots,
            (progress) => {
                broadcastLibraryValidationStatus({
                    type: 'library.validationStatus',
                    ...progress,
                });
            }
        );
        const failed = titles.filter((title) => title.status !== 'ok').length;

        broadcastLibraryValidationStatus({
            type: 'library.validationStatus',
            status: 'complete',
            total: titles.length,
            failed,
        });

        res.json({
            status: failed === 0 ? 'ok' : 'failed',
            total: titles.length,
            failed,
            titles,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        broadcastLibraryValidationStatus({
            type: 'library.validationStatus',
            status: 'failed',
            error: message,
        });

        logServerError('Failed to validate library:', error);
        sendServerError(res, 'Failed to validate library', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/storage/copy', (req, res) => {
    try {
        const result = queueStorageTransfer(
            getStorageTransferQueueInput(req, false)
        );
        res.status(result.status).json(result.body);
    } catch (error) {
        logServerError('Failed to queue storage copy:', error);
        sendServerError(res, 'Failed to queue storage copy', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/storage/move', (req, res) => {
    try {
        const result = queueStorageTransfer(
            getStorageTransferQueueInput(req, true)
        );
        res.status(result.status).json(result.body);
    } catch (error) {
        logServerError('Failed to queue storage move:', error);
        sendServerError(res, 'Failed to queue storage move', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/storage/delete', (req, res) => {
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
        logServerError('Failed to queue storage delete:', error);
        sendServerError(res, 'Failed to queue storage delete', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/storage/list-fat32', async (_req, res) => {
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
        logServerError('Failed to list FAT32 volumes:', error);
        sendServerError(res, 'Failed to list FAT32 volumes', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-icon/:family', async (req, res) => {
    try {
        const iconUrl = await getTitleIconUrl(req.params.family);

        if (!iconUrl) {
            res.status(404).json({
                error: 'Missing title icon',
            });
            return;
        }

        const image = await getCachedImage(iconUrl);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('Content-Type', image.contentType);
        res.send(image.body);
    } catch (error) {
        logServerError('Failed to load title icon:', error);
        sendServerError(res, 'Failed to load title icon', error);
    }
});

app.get('/api/title-metadata', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const metadata = await downloadNusTitleMetadata(titleId);

        if (!metadata) {
            res.status(404).json({
                error: 'Failed to parse title metadata',
            });
            return;
        }

        res.json({
            titleId: metadata.titleId,
            name: metadata.name,
            region: metadata.region,
            productCode: metadata.productCode,
            companyCode: metadata.companyCode,
            baseVersions:
                metadata.titleVersion === null ? [] : [metadata.titleVersion],
            metaJson: metadata.metaJson,
            titleKey: metadata.titleKey
                ? Buffer.from(metadata.titleKey).toString('hex')
                : null,
            titleKeyPassword: metadata.titleKeyPassword,
        });
    } catch (error) {
        logServerError('Failed to download title metadata:', error);
        sendServerError(res, 'Failed to download title metadata', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-all', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const [metadata, updateMetadata, dlcMetadata] = await Promise.all([
            downloadNusTitleMetadata(titleId),
            getUpdateMetadata(titleId),
            getDlcMetadata(titleId),
        ]);

        if (!metadata) {
            res.status(404).json({
                error: 'Failed to parse title metadata',
            });
            return;
        }

        res.json({
            titleId: metadata.titleId,
            name: metadata.name,
            region: metadata.region,
            productCode: metadata.productCode,
            companyCode: metadata.companyCode,
            baseVersions:
                metadata.titleVersion === null ? [] : [metadata.titleVersion],
            titleKey: metadata.titleKey
                ? Buffer.from(metadata.titleKey).toString('hex')
                : null,
            titleKeyPassword: metadata.titleKeyPassword,
            updates:
                updateMetadata.exists && updateMetadata.titleVersion !== null
                    ? [updateMetadata.titleVersion]
                    : [],
            dlc:
                dlcMetadata.exists && dlcMetadata.titleVersion !== null
                    ? [dlcMetadata.titleVersion]
                    : [],
        });
    } catch (error) {
        logServerError('Failed to load full title metadata:', error);
        sendServerError(res, 'Failed to load full title metadata', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-download', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        res.json(await downloadTitle(titleId));
    } catch (error) {
        logServerError('Failed to download title:', error);
        sendServerError(res, 'Failed to download title', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-update', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const metadata = await getUpdateMetadata(titleId);
        res.json({
            titleId: metadata.titleId,
            updateTitleId: metadata.childTitleId,
            exists: metadata.exists,
            titleVersion: metadata.titleVersion,
        });
    } catch (error) {
        logServerError('Failed to load title update metadata:', error);
        sendServerError(res, 'Failed to load title update metadata', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-dlc', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const metadata = await getDlcMetadata(titleId);
        res.json({
            titleId: metadata.titleId,
            dlcTitleId: metadata.childTitleId,
            exists: metadata.exists,
            titleVersion: metadata.titleVersion,
        });
    } catch (error) {
        logServerError('Failed to load title DLC metadata:', error);
        sendServerError(res, 'Failed to load title DLC metadata', error, {
            includeDetails: true,
        });
    }
});

const server = createServer(app);

const socketServer = new WebSocketServer({
    server,
    path: '/api/socket',
});

socketServer.on('connection', (socket) => {
    logger.log('server', 'WebSocket client connected');

    sendAppSocketEvent(socket, {
        type: 'app.connected',
        downloads: downloadQueue,
        storageCopies,
        storageDeletes,
        libraryValidationStatus: latestLibraryValidationStatus,
    });

    socket.on('message', (data) => {
        const commandText = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');

        const commandType = (() => {
            try {
                const raw = JSON.parse(commandText) as { type?: unknown };
                return typeof raw.type === 'string'
                    ? raw.type
                    : `invalid:${String(raw.type)}`;
            } catch {
                return 'invalid-json';
            }
        })();

        logger.log('server', `socket command received: ${commandType}`);

        const command = parseSocketCommand(data);
        if (!command) {
            logger.log(
                'server',
                `socket command rejected: ${commandType} payload=${commandText}`
            );
            return;
        }

        handleAppSocketCommand(command);
    });

    socket.on('close', () => {
        logger.warn('server', 'WebSocket client disconnected');
    });

    socket.on('error', (error) => {
        logger.warn(
            'server',
            `WebSocket client error: ${formatLogError(error)}`
        );
    });
});

server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(
        'server',
        `Failed to listen at ${getListenUrl(host, port)}: ${error.message}`
    );
    process.exit(1);
});

server.on('listening', () => {
    logger.log('server', `Listening at ${getListenUrl(host, port)}`);

    if (config.openBrowser) {
        const url = getBrowserUrl(host, port);
        logger.log('server', `Opening browser at ${url}`);
        void open(url).catch((error: unknown) => {
            logger.warn(
                'server',
                `Failed to open browser: ${formatLogError(error)}`
            );
        });
    }
});

server.listen(port, host);
