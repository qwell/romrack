import { STORAGE_COPY_SOCKET_COMMAND } from './socket.js';
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

export type StorageActionBarCommand =
    (typeof STORAGE_COPY_SOCKET_COMMAND)[keyof typeof STORAGE_COPY_SOCKET_COMMAND];

export const STORAGE_ACTION_BAR_COMMAND_TYPES = [
    STORAGE_COPY_SOCKET_COMMAND.cancel,
    STORAGE_COPY_SOCKET_COMMAND.clear,
    STORAGE_COPY_SOCKET_COMMAND.retry,
] as const satisfies readonly StorageActionBarCommand[];

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
