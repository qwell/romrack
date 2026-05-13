import { CopyCancelContext } from './os.js';
import { TitleKinds } from './titles.js';

export type DownloadQueueState =
    | 'queued'
    | 'downloading'
    | 'failed'
    | 'complete';
export type DownloadQueueItem = {
    id: string;
    family: string;
    groupName: string;
    kind: TitleKinds;
    label: string;
    titleId: string;
    sizeText: string | null;
    totalBytes: number | null;
    state: DownloadQueueState;
    error: string | null;

    progress: number;
    downloadedBytes: number | null;
    speedText: string | null;
    completedFiles: number | null;
    totalFiles: number | null;
    currentFileName: string | null;
    installedSizeBytes: number | null;
    installedVersion: number | null;
    installedTitleName: string | null;
};

export type StorageCopyOperation = 'copy' | 'move';
export type StorageCopyState = 'queued' | 'copying' | 'failed' | 'complete';
export type StorageCopyItem = {
    id: string;
    operation: StorageCopyOperation;
    sourcePath: string;
    titleKind: TitleKinds | null;
    destinationPath: string;
    state: StorageCopyState;
    progress: number | null;
    message: string | null;
    sourceSizeBytes: number | null;
    completedFiles: number | null;
    totalFiles: number | null;
    currentSizeBytes: number | null;
    currentFilePath: string | null;
    cancelContext?: CopyCancelContext;
    error: string | null;
};

export function toArray<T>(value: T | readonly T[] | null | undefined): T[] {
    if (value == null) {
        return [];
    }

    return Array.isArray(value)
        ? Array.from(value as readonly T[])
        : [value as T];
}

export function formatSize(sizeBytes: number | null): string {
    if (sizeBytes === null || sizeBytes === undefined) {
        return '-';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = sizeBytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export async function mapConcurrent<T, U>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
    if (items.length === 0) {
        return [];
    }

    const results = new Array<U>(items.length);
    let cursor = 0;

    const workerCount = Math.max(
        1,
        Math.min(Math.floor(concurrency) || 1, items.length)
    );

    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index], index);
        }
    });

    await Promise.all(workers);
    return results;
}
