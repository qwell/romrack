import { type TitleKinds } from './titles.js';

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
    (typeof STORAGE_ACTION)[keyof typeof STORAGE_ACTION];

export const STORAGE_ACTION = {
    cancelCopy: 'storage.copy.cancel',
    clearCopy: 'storage.copy.clear',
    retryCopy: 'storage.copy.retry',
    clearDelete: 'storage.delete.clear',
    retryDelete: 'storage.delete.retry',
} as const;

export const STORAGE_ACTION_BAR_COMMAND_TYPES = [
    STORAGE_ACTION.cancelCopy,
    STORAGE_ACTION.clearCopy,
    STORAGE_ACTION.retryCopy,
    STORAGE_ACTION.clearDelete,
    STORAGE_ACTION.retryDelete,
] as const satisfies readonly StorageActionBarCommand[];

export type StorageDeleteQueueItem = StorageDeleteItem & {
    sourcePaths: string[];
};

export type StorageTransferQueueInput = {
    sourcePath: string | null;
    titleId: string | null;
    requestedDestination: string | null;
    move: boolean;
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

export function isStorageActionBarCommand(
    value: string | null
): value is StorageActionBarCommand {
    return STORAGE_ACTION_BAR_COMMAND_TYPES.includes(
        value as StorageActionBarCommand
    );
}
