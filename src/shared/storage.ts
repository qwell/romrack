import { type TitleIdentity, type TitleKinds } from './titles.js';
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

export type StorageTransferQueueInput = {
    title: TitleIdentity;
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

export type StorageDeleteQueueItem = StorageDeleteItem & {
    title: TitleIdentity;
    sourcePaths: string[];
};
