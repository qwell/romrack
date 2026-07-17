import { type DownloadQueueItem } from '../../shared/download.js';
import { type TitleDownloadResponse } from '../../shared/api.js';
import { getConfig } from '../routes/config.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/utils.js';
import { isTerminalActionState } from '../../shared/action.js';
import {
    DOWNLOAD_SOCKET_COMMAND,
    DOWNLOAD_SOCKET_EVENT,
    DownloadSocketCommand,
} from '../../shared/socket.js';
import { broadcastAppSocketEvent } from '../socket.js';
import {
    generateWupTitleFiles,
    type WupGenerationProgress,
} from '../platforms/wiiu.js';
import { clearTitleScanCache } from '../library.js';
import { findFirstReadableWiiURoot } from '../platforms/wiiu.js';
import { markTitleCopiesValidating, revalidateTitleCopies } from './titles.js';
import { type TitlePlatform } from '../../shared/titles.js';

let downloadQueue: DownloadQueueItem[] = [];

let activeDownloadItemId: string | null = null;
const activeDownloadAbortControllers = new Map<string, AbortController>();
const activeDownloadSourcePaths = new Map<string, string>();

const cancelledDownloadIds = new Set<string>();

export async function downloadTitle(
    platform: TitlePlatform,
    titleId: string,
    onProgress?: (progress: WupGenerationProgress) => void,
    signal?: AbortSignal
): Promise<TitleDownloadResponse> {
    switch (platform) {
        case '3ds':
            return downloadThreeDSTitle(titleId);
        case 'wii':
            return downloadWiiTitle(titleId);
        case 'wiiu':
            return downloadWiiUTitle(titleId, onProgress, signal);
    }
}

async function downloadWiiUTitle(
    titleId: string,
    onProgress?: (progress: WupGenerationProgress) => void,
    signal?: AbortSignal
): Promise<TitleDownloadResponse> {
    const romRoot = await findFirstReadableWiiURoot(getConfig().wiiuRoots);

    const response = await generateWupTitleFiles(titleId, romRoot, {
        onProgress,
        signal,
    });

    clearTitleScanCache();

    return response;
}

function downloadThreeDSTitle(titleId: string): never {
    throwUnsupportedTitleDownload('3ds', titleId, 'CIA');
}

function downloadWiiTitle(titleId: string): never {
    throwUnsupportedTitleDownload('wii', titleId, 'WAD');
}

function throwUnsupportedTitleDownload(
    platform: TitlePlatform,
    titleId: string,
    representation: string
): never {
    throw new Error(
        `${platform} title download is unavailable for ${titleId}: ${representation} writing is not implemented`
    );
}

function broadcastDownloadQueue(): void {
    broadcastAppSocketEvent({
        type: DOWNLOAD_SOCKET_EVENT.changed,
        items: downloadQueue,
    });
}

function getDownloadQueueKey(item: {
    platform: TitlePlatform;
    family: string;
    kind: string;
    titleId: string;
}): string {
    return `${item.platform}\0${item.family}\0${item.kind}\0${item.titleId}`;
}

function hasDownloadQueueItem(id: string): boolean {
    return downloadQueue.some((item) => item.id === id);
}

let broadcastDownloadQueueTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBroadcastDownloadQueue(): void {
    if (broadcastDownloadQueueTimer !== null) {
        return;
    }
    broadcastDownloadQueueTimer = setTimeout(() => {
        broadcastDownloadQueueTimer = null;
        broadcastDownloadQueue();
    }, 200);
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

    nextItem.state = 'in-progress';
    nextItem.error = null;
    nextItem.progress = 0;
    nextItem.downloadedBytes = null;
    nextItem.speedText = null;
    nextItem.completedFiles = null;
    nextItem.totalFiles = null;
    nextItem.currentFileName = null;
    nextItem.currentFileSizeBytes = null;
    nextItem.installedSizeBytes = null;
    nextItem.installedVersion = null;
    nextItem.installedTitleName = null;
    nextItem.installedSourcePath = null;

    scheduleBroadcastDownloadQueue();

    try {
        const result = await downloadTitle(
            nextItem.platform,
            nextItem.titleId,
            (progress) => {
                activeDownloadSourcePaths.set(nextItem.id, progress.outputDir);
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
                nextItem.currentFileSizeBytes = progress.currentFileSizeBytes;

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
        nextItem.currentFileSizeBytes = null;
        nextItem.installedSizeBytes = result.sizeBytes;
        nextItem.installedVersion = result.titleVersion;
        nextItem.installedTitleName = result.name;
        nextItem.installedSourcePath = result.outputDir;

        logger.log(
            'server',
            `download completed: ${nextItem.groupName} ${nextItem.label} ${nextItem.titleId}`
        );

        broadcastDownloadQueue();
        revalidateTitleCopies([
            {
                titleId: nextItem.titleId,
                sourcePaths: [result.outputDir],
            },
        ]);
    } catch (error) {
        if (
            cancelledDownloadIds.has(nextItem.id) ||
            abortController.signal.aborted
        ) {
            return;
        }

        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);

        logger.warn('server', `Download failed: ${formatLogError(error)}`);

        broadcastDownloadQueue();
        clearTitleScanCache();
        revalidateCancelledDownload(nextItem);
    } finally {
        if (cancelledDownloadIds.has(nextItem.id)) {
            clearTitleScanCache();
            revalidateCancelledDownload(nextItem);
        }
        cancelledDownloadIds.delete(nextItem.id);
        activeDownloadAbortControllers.delete(nextItem.id);
        activeDownloadSourcePaths.delete(nextItem.id);

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

    cancelledDownloadIds.add(item.id);
    item.state = 'cancelled';
    item.currentFileName = null;
    item.currentFileSizeBytes = null;

    const abortController = activeDownloadAbortControllers.get(item.id);
    abortController?.abort();
    clearTitleScanCache();
    if (activeDownloadSourcePaths.has(item.id)) {
        markTitleCopiesValidating([item.titleId]);
    }

    logger.log(
        'server',
        `download abort signaled: id=${item.id} signalAborted=${abortController?.signal.aborted ? 'yes' : 'no'}`
    );

    broadcastDownloadQueue();
}

function revalidateCancelledDownload(item: DownloadQueueItem): void {
    const sourcePath = activeDownloadSourcePaths.get(item.id);
    if (!sourcePath) {
        return;
    }

    revalidateTitleCopies([
        { titleId: item.titleId, sourcePaths: [sourcePath] },
    ]);
}

export function handleDownloadSocketCommand(
    command: DownloadSocketCommand
): void {
    switch (command.type) {
        case DOWNLOAD_SOCKET_COMMAND.queue: {
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
                    .filter(
                        (item) =>
                            item.state !== 'complete' &&
                            item.state !== 'cancelled'
                    )
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
                    currentFileSizeBytes: null,
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

        case DOWNLOAD_SOCKET_COMMAND.retry: {
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
            item.currentFileSizeBytes = null;
            item.installedSizeBytes = null;
            item.installedVersion = null;
            item.installedTitleName = null;
            item.installedSourcePath = null;

            broadcastDownloadQueue();
            void processDownloadQueue();
            return;
        }

        case DOWNLOAD_SOCKET_COMMAND.clear: {
            const item = downloadQueue.find(
                (candidate) => candidate.id === command.id
            );

            if (!item || !isTerminalActionState(item.state)) {
                logger.log(
                    'server',
                    `download clear ignored: id=${command.id} item=${item?.state ?? 'missing'}`
                );
                return;
            }

            logger.log(
                'server',
                `download cleared: [${item.titleId}] ${item.groupName} [${item.label}]`
            );

            downloadQueue = downloadQueue.filter(
                (candidate) => candidate.id !== item.id
            );

            broadcastDownloadQueue();
            void processDownloadQueue();

            return;
        }

        case DOWNLOAD_SOCKET_COMMAND.cancel: {
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
                        candidate.state === 'in-progress' &&
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
                    `download queued items cancelled: ${item.groupName} ${item.label} ${item.titleId}`
                );

                for (const queuedItem of matchingQueuedItems) {
                    queuedItem.state = 'cancelled';
                }

                broadcastDownloadQueue();
                void processDownloadQueue();
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

export function getDownloadQueue(): DownloadQueueItem[] {
    return downloadQueue;
}
