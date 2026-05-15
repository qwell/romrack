import type { TitleKinds } from './titles.js';

export type StorageCopyOperation = 'copy' | 'move';
export type StorageCopyState = 'queued' | 'copying' | 'failed' | 'complete';
export type StorageCopyItem = {
    id: string;
    operation: StorageCopyOperation;
    titleId: string | null;
    sourceName: string;
    titleKind: TitleKinds | null;
    destinationName: string;
    state: StorageCopyState;
    progress: number | null;
    message: string | null;
    sourceSizeBytes: number | null;
    completedFiles: number | null;
    totalFiles: number | null;
    currentSizeBytes: number | null;
    currentFileName: string | null;
    error: string | null;
};

export type StorageDeleteState = 'queued' | 'deleting' | 'failed' | 'complete';
export type StorageDeleteItem = {
    id: string;
    titleId: string;
    titleName: string | null;
    titleKind: TitleKinds | null;
    state: StorageDeleteState;
    message: string | null;
    deletedCount: number;
    totalCount: number | null;
    error: string | null;
};

export type StorageActionBarCommand =
    | 'storage.copy.cancel'
    | 'storage.copy.clear'
    | 'storage.copy.retry'
    | 'storage.delete.clear'
    | 'storage.delete.retry';

export type StorageDeleteQueueItem = StorageDeleteItem & {
    sourcePaths: string[];
};

export type StorageTransferQueueInput = {
    sourcePath: string | null;
    titleId: string | null;
    requestedDestination: string | null;
    move: boolean;
};

export type StorageTransferQueueResult = {
    status: number;
    body: Record<string, unknown>;
};

export type StorageCopyQueueItem = StorageCopyItem & {
    sourcePath: string | null;
    destinationPath: string;
    currentFilePath: string | null;
    requestedSourcePath: string | null;
    requestedDestination: string | null;
    requestedTitleId: string | null;
    duplicateSourcePaths: string[];
};
