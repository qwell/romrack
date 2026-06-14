import {
    STORAGE_COPY_SOCKET_COMMAND,
    STORAGE_DELETE_SOCKET_COMMAND,
} from './socket.js';
import { type TitleKinds } from './titles.js';
import { type ActionState } from './action.js';

export type StorageCopyOperation = 'copy' | 'move';
export type StorageCopyItem = {
    id: string;
    operation: StorageCopyOperation;
    titleId: string | null;
    sourceName: string;
    titleVersion: number | null;
    titleKind: TitleKinds | null;
    destinationName: string;
    state: ActionState;
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
    titleId: string;
    requestedDestination: string | null;
    move: boolean;
};

export type StorageCopyQueueItem = StorageCopyItem & {
    sourcePath: string | null;
    destinationPath: string;
    currentFilePath: string | null;
    requestedDestination: string | null;
    requestedTitleId: string;
    duplicateSourcePaths: string[];
};

export type StorageDeleteItem = {
    id: string;
    titleId: string;
    titleName: string | null;
    titleVersion: number | null;
    titleKind: TitleKinds | null;
    state: ActionState;
    message: string | null;
    deletedCount: number;
    totalCount: number | null;
    error: string | null;
};

export type StorageDeleteActionBarCommand =
    (typeof STORAGE_DELETE_SOCKET_COMMAND)[keyof typeof STORAGE_DELETE_SOCKET_COMMAND];

export type StorageDeleteQueueItem = StorageDeleteItem & {
    sourcePaths: string[];
};

export function isStorageActionBarCommand(
    value: string | null
): value is StorageActionBarCommand {
    return STORAGE_ACTION_BAR_COMMAND_TYPES.includes(
        value as StorageActionBarCommand
    );
}
