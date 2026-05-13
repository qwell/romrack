import express, { type Request, type Response } from 'express';
import open from 'open';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
    findFirstReadableWiiURoot,
    getTitleIconUrl,
    readWiiUTitleKind,
    scanWiiUTitleRoots,
    validateWiiUTitleRoots,
} from './wiiu.js';
import {
    AppSocketCommand,
    AppSocketEvent,
    DownloadSocketCommand,
    StorageCopySocketCommand,
    ValidationStatusEvent,
} from '../shared/socket.js';
import {
    type AppConfigResponse,
    type AppConfigUpdate,
    type AppConfigValidateRootResponse,
} from '../shared/config.js';
import {
    copyPath,
    cancelCopy,
    type CopyPathCommand,
    type CancelCopyCommand,
    getRuntimeOs,
    listFat32Volumes,
    resolveReadablePath,
    resolveFat32Destination,
} from '../shared/os.js';
import { getPathFileSizes, getPathStats } from '../shared/file.js';
import logger from '../shared/logger.js';
import { DownloadQueueItem, StorageCopyItem } from '../shared/shared.js';

const config = loadConfig();

const app = express();
const host = config.host;
const port = config.port;

const clientDir = path.join(getAppRoot(), 'client');

let activeStorageCopyPid: number | null = null;

type TitleIdQueryResult =
    | {
          ok: true;
          titleId: string;
      }
    | {
          ok: false;
          error: string;
      };

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

function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    return new Error(String(error));
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

function executeCancelCopyCommand(command: CancelCopyCommand): Promise<void> {
    logger.log(
        'server',
        `storage cancel command: ${command.command} ${command.args
            .map((arg) => JSON.stringify(arg))
            .join(' ')}`
    );

    return new Promise((resolve, reject) => {
        const child = spawn(command.command, command.args, {
            stdio: 'ignore',
            windowsHide: true,
        });

        child.once('error', reject);

        child.once('close', (exitCode, signal) => {
            const successExitCodes = command.successExitCodes ?? [0];
            logger.log(
                'server',
                `storage cancel command exited: ${command.command} exit=${exitCode ?? 'null'} signal=${signal ?? 'null'}`
            );

            if (exitCode !== null && successExitCodes.includes(exitCode)) {
                resolve();
                return;
            }

            reject(
                new Error(
                    `${command.command} failed with exit code ${exitCode ?? signal}`
                )
            );
        });
    });
}

function createStorageCopyCancelledError(): Error {
    const error = new Error('Storage copy cancelled');
    error.name = 'AbortError';
    return error;
}

function executeCopyCommand(
    command: CopyPathCommand,
    onOutput: (text: string) => void,
    onPid?: (pid: number) => void,
    signal?: AbortSignal
): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createStorageCopyCancelledError());
            return;
        }

        const child = spawn(command.command, command.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: command.detached ?? false,
        });

        const pid = child.pid;
        if (!pid) {
            reject(new Error(`Failed to start ${command.command}`));
            return;
        }

        onPid?.(pid);

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;

        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }

            settled = true;
            reject(toError(error));
        };

        const succeed = (value: {
            exitCode: number | null;
            signal: NodeJS.Signals | null;
            stdout: string;
            stderr: string;
        }): void => {
            if (settled) {
                return;
            }

            settled = true;
            resolve(value);
        };

        const handleOutput = (target: Buffer[], chunk: Buffer): void => {
            if (signal?.aborted) {
                return;
            }

            target.push(chunk);
            onOutput(chunk.toString('utf8'));
        };

        child.stdout.on('data', (chunk: Buffer) => {
            handleOutput(stdout, chunk);
        });

        child.stderr.on('data', (chunk: Buffer) => {
            handleOutput(stderr, chunk);
        });

        child.on('error', (error: Error) => {
            if (signal?.aborted) {
                fail(createStorageCopyCancelledError());
                return;
            }

            fail(error);
        });

        child.on('close', (exitCode, exitSignal) => {
            if (signal?.aborted) {
                fail(createStorageCopyCancelledError());
                return;
            }

            const output = {
                exitCode,
                signal: exitSignal,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            };

            const successExitCodes = command.successExitCodes ?? [0];

            if (exitCode !== null && successExitCodes.includes(exitCode)) {
                succeed(output);
                return;
            }

            fail(
                new Error(
                    `${command.command} failed with exit code ${exitCode ?? exitSignal}`
                )
            );
        });
    });
}

function handleAppSocketCommand(command: AppSocketCommand): void {
    logger.log('server', `socket command dispatch: ${command.type}`);

    switch (command.type) {
        case 'download.queue':
        case 'download.retry':
        case 'download.remove':
        case 'download.cancel':
            handleDownloadSocketCommand(command);
            return;

        case 'storage.copy.queue':
        case 'storage.copy.retry':
        case 'storage.copy.remove':
        case 'storage.copy.cancel':
            void handleStorageCopySocketCommand(command);
            return;
    }
}

let downloadQueue: DownloadQueueItem[] = [];
let storageCopies: StorageCopyItem[] = [];

let activeDownloadItemId: string | null = null;
const activeDownloadAbortControllers = new Map<string, AbortController>();

let activeStorageCopyId: string | null = null;
let activeStorageCopyAbortController: AbortController | null = null;

const cancelledDownloadIds = new Set<string>();
const cancelledStorageCopyIds = new Set<string>();

let latestLibraryValidationStatus: ValidationStatusEvent | null = null;

type StorageCopyQueueItem = StorageCopyItem & {
    requestedSourcePath: string;
    requestedDestination: string | null;
    command: CopyPathCommand | null;
};

let storageCopyQueue: StorageCopyQueueItem[] = [];

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
    broadcastAppSocketEvent({
        type: 'storage.copyChanged',
        items: storageCopies,
    });
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
    updateStorageCopy(id, {
        state: item.state,
        error: item.error,
        progress: item.progress,
        message: item.message,
        completedFiles: item.completedFiles,
        currentSizeBytes: item.currentSizeBytes,
        currentFilePath: item.currentFilePath,
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

    if (!item) {
        logger.log('server', `storage copy remove ignored: missing id=${id}`);
        broadcastStorageCopies();
        return;
    }

    logger.log(
        'server',
        `storage ${item.operation} removed: ${item.sourcePath} -> ${item.destinationPath}`
    );

    if (activeStorageCopyId === id) {
        cancelledStorageCopyIds.add(id);
        activeStorageCopyAbortController?.abort();

        void cancelStorageCopyProcess(id, item).catch((error: unknown) => {
            logServerError(
                'Failed to cancel active storage copy during remove:',
                error
            );
        });
    }

    removeStorageCopyFromState(id);
    broadcastStorageCopies();

    if (activeStorageCopyId !== id) {
        void processStorageCopyQueue();
    }
}

function removeStorageCopyLater(id: string): void {
    setTimeout(() => {
        removeStorageCopyFromState(id);
        broadcastStorageCopies();
    }, 5000);
}

async function cancelStorageCopyProcess(
    id: string,
    item: StorageCopyItem
): Promise<void> {
    const pid = activeStorageCopyId === id ? activeStorageCopyPid : null;

    if (pid === null) {
        logger.log(
            'server',
            `storage copy cancel marked before process start: id=${id}`
        );
        return;
    }

    const cancelCommand = await cancelCopy({
        pid,
        context: item.cancelContext,
    });

    await executeCancelCopyCommand(cancelCommand);

    logger.log(
        'server',
        `storage ${item.operation} cancel completed: ${item.sourcePath} -> ${item.destinationPath}`
    );
}

async function cancelStorageCopy(id: string): Promise<void> {
    const item = storageCopies.find((candidate) => candidate.id === id);

    if (!item) {
        logger.log('server', `storage copy cancel ignored: missing id=${id}`);
        broadcastStorageCopies();
        return;
    }

    const wasActive = activeStorageCopyId === id;

    logger.log(
        'server',
        `storage ${item.operation} cancel requested: ${item.sourcePath} -> ${item.destinationPath}`
    );

    cancelledStorageCopyIds.add(id);
    removeStorageCopyFromState(id);
    broadcastStorageCopies();

    try {
        if (wasActive) {
            activeStorageCopyAbortController?.abort();
            await cancelStorageCopyProcess(id, item);
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

async function handleStorageCopySocketCommand(
    command: StorageCopySocketCommand
): Promise<void> {
    switch (command.type) {
        case 'storage.copy.queue':
            try {
                await queueStorageTransfer({
                    sourcePath: command.sourcePath ?? null,
                    requestedDestination: command.destinationPath ?? null,
                    move: command.move ?? false,
                });
            } catch (error) {
                logServerError('Failed to queue storage transfer:', error);
            }
            return;

        case 'storage.copy.cancel':
            void cancelStorageCopy(command.id);
            return;

        case 'storage.copy.remove':
            removeStorageCopy(command.id);
            return;

        case 'storage.copy.retry':
            retryStorageCopy(command.id);
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

        case 'storage.copy.queue': {
            const sourcePath = (command as { sourcePath?: unknown }).sourcePath;
            const destinationPath = (command as { destinationPath?: unknown })
                .destinationPath;
            const move = (command as { move?: unknown }).move;

            if (
                sourcePath !== undefined &&
                (typeof sourcePath !== 'string' || sourcePath.length === 0)
            ) {
                return null;
            }

            if (
                destinationPath !== undefined &&
                destinationPath !== null &&
                (typeof destinationPath !== 'string' ||
                    destinationPath.length === 0)
            ) {
                return null;
            }

            if (move !== undefined && typeof move !== 'boolean') {
                return null;
            }

            return parsed as AppSocketCommand;
        }

        case 'download.retry':
        case 'download.remove':
        case 'download.cancel':
        case 'storage.copy.remove':
        case 'storage.copy.retry':
        case 'storage.copy.cancel': {
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
    requestedDestination: string | null;
    move: boolean;
};

type StorageTransferQueueResult = {
    status: number;
    body: Record<string, unknown>;
};

async function queueStorageTransfer(
    input: StorageTransferQueueInput
): Promise<StorageTransferQueueResult> {
    const sourcePath = input.sourcePath ?? getConfig().wiiuRoots[0];
    if (!sourcePath) {
        return {
            status: 400,
            body: {
                error: 'No Wii U root configured',
            },
        };
    }

    const requestedDestination = input.requestedDestination;
    const move = input.move;
    const copyId = randomUUID();
    const readableSourcePath = await resolveReadablePath(sourcePath);
    const titleKind = await readWiiUTitleKind(readableSourcePath);

    const copyItem: StorageCopyItem = {
        id: copyId,
        operation: move ? 'move' : 'copy',
        sourcePath: readableSourcePath,
        titleKind,
        destinationPath: requestedDestination ?? '',
        state: 'queued',
        progress: null,
        message: 'Queued',
        sourceSizeBytes: null,
        completedFiles: 0,
        totalFiles: null,
        currentSizeBytes: null,
        currentFilePath: null,
        cancelContext: undefined,
        error: null,
    };

    const queueItem: StorageCopyQueueItem = {
        ...copyItem,
        requestedSourcePath: sourcePath,
        requestedDestination,
        command: null,
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
        requestedDestination: getStringQuery(req, 'dest'),
        move,
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
    activeStorageCopyPid = null;

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

        const readableSourcePath = await resolveReadablePath(
            nextItem.requestedSourcePath
        );
        const titleKind = await readWiiUTitleKind(readableSourcePath);
        nextItem.sourcePath = readableSourcePath;
        nextItem.titleKind = titleKind;

        updateStorageCopy(nextItem.id, {
            sourcePath: nextItem.sourcePath,
            titleKind: nextItem.titleKind,
        });

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

        const sourceFileSizeByPath = new Map(
            sourceFileSizes.map((file) => [
                getStorageCopyFileKey(file.relativePath),
                file.sizeBytes,
            ])
        );
        const sourceSizeBytes = sourceStats.sizeBytes;
        const sourceFileCount = sourceStats.fileCount;
        const freeBytes = storageDestination.freeBytes;

        if (freeBytes !== null && sourceSizeBytes > freeBytes) {
            throw new Error('Not enough free space on destination');
        }

        const command = await copyPath({
            sourcePath: nextItem.requestedSourcePath,
            destination: storageDestination,
            move: nextItem.operation === 'move',
        });

        if (shouldStopStorageCopy(nextItem.id)) {
            return;
        }

        const destinationPath = command.args[1] ?? storageDestination.source;

        nextItem.command = command;
        nextItem.destinationPath = destinationPath;
        nextItem.sourceSizeBytes = sourceSizeBytes;
        nextItem.totalFiles = sourceFileCount;
        nextItem.completedFiles = 0;
        nextItem.cancelContext = command.cancelContext;
        nextItem.message =
            nextItem.operation === 'move' ? 'Moving...' : 'Copying...';

        updateStorageCopy(nextItem.id, {
            sourcePath: nextItem.sourcePath,
            titleKind: nextItem.titleKind,
            destinationPath: nextItem.destinationPath,
            sourceSizeBytes: nextItem.sourceSizeBytes,
            totalFiles: nextItem.totalFiles,
            completedFiles: nextItem.completedFiles,
            cancelContext: nextItem.cancelContext,
            message: nextItem.message,
        });

        logger.log(
            'server',
            `storage ${nextItem.operation} started: ${command.command} ${command.args
                .map((arg) => JSON.stringify(arg))
                .join(' ')}`
        );

        const countedFiles = new Set<string>();
        let completedBytes = 0;
        let currentFilePath: string | null = null;
        let currentFileSizeBytes: number | null = null;

        const result = await executeCopyCommand(
            command,
            (text) => {
                if (
                    cancelledStorageCopyIds.has(nextItem.id) ||
                    !hasStorageCopyItem(nextItem.id) ||
                    abortController.signal.aborted
                ) {
                    return;
                }

                const progressUpdate =
                    command.parseOutput?.(text, {
                        sourcePath: command.args[0] ?? nextItem.sourcePath,
                        destinationPath:
                            command.args[1] ?? nextItem.destinationPath,
                    }) ?? null;

                if (!progressUpdate) {
                    return;
                }

                if (progressUpdate.message !== null) {
                    nextItem.message = progressUpdate.message;
                }

                if (progressUpdate.currentFilePath !== null) {
                    const nextFilePath = getStorageCopyFileKey(
                        progressUpdate.currentFilePath
                    );

                    if (
                        currentFilePath !== null &&
                        currentFilePath !== nextFilePath &&
                        !countedFiles.has(currentFilePath)
                    ) {
                        countedFiles.add(currentFilePath);
                        completedBytes += currentFileSizeBytes ?? 0;
                        nextItem.completedFiles =
                            (nextItem.completedFiles ?? 0) + 1;
                    }

                    currentFilePath = nextFilePath;
                    currentFileSizeBytes =
                        sourceFileSizeByPath.get(nextFilePath) ??
                        progressUpdate.currentSizeBytes;
                    nextItem.currentFilePath = progressUpdate.currentFilePath;
                    nextItem.currentSizeBytes = currentFileSizeBytes;
                }

                if (progressUpdate.currentSizeBytes !== null) {
                    currentFileSizeBytes = progressUpdate.currentSizeBytes;
                    nextItem.currentSizeBytes = currentFileSizeBytes;
                }

                const nextProgress =
                    calculateStorageCopyByteProgress({
                        completedBytes,
                        currentFileSizeBytes,
                        currentFileProgress: progressUpdate.progress,
                        totalBytes: nextItem.sourceSizeBytes,
                    }) ??
                    calculateStorageCopyProgress(
                        nextItem.completedFiles ?? 0,
                        nextItem.totalFiles,
                        progressUpdate.progress
                    );
                if (nextProgress !== null) {
                    nextItem.progress = Math.max(
                        nextItem.progress ?? 0,
                        nextProgress
                    );
                }

                updateStorageCopy(nextItem.id, {
                    progress: nextItem.progress,
                    message: nextItem.message,
                    completedFiles: nextItem.completedFiles,
                    currentSizeBytes: nextItem.currentSizeBytes,
                    currentFilePath: nextItem.currentFilePath,
                });
            },
            (pid) => {
                activeStorageCopyPid = pid;
            },
            abortController.signal
        );

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
        nextItem.error = null;

        logger.log(
            'server',
            `storage ${nextItem.operation} completed: exit=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'}`
        );

        updateStorageCopy(nextItem.id, {
            state: nextItem.state,
            progress: nextItem.progress,
            message: nextItem.message,
            currentSizeBytes: nextItem.currentSizeBytes,
            currentFilePath: nextItem.currentFilePath,
            error: nextItem.error,
        });

        removeStorageCopyLater(nextItem.id);
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
            activeStorageCopyPid = null;

            if (activeStorageCopyAbortController === abortController) {
                activeStorageCopyAbortController = null;
            }
        }

        void processStorageCopyQueue();
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
    res.json({
        config: getConfig(),
        restartRequired: false,
    });
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

app.get('/api/storage/copy', async (req, res) => {
    try {
        const result = await queueStorageTransfer(
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

app.get('/api/storage/move', async (req, res) => {
    try {
        const result = await queueStorageTransfer(
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
