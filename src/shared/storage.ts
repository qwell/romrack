import {
    type TitleIdentity,
    type TitleKinds,
    type TitlePlatform,
} from './titles.js';
import { type ActionState } from './action.js';

export type StoragePathTemplate = {
    root: string;
    directory: string | null;
    filename: string | null;
};

export const STORAGE_PATHS: Record<TitlePlatform, StoragePathTemplate> = {
    '3ds': {
        root: '/cias/',
        directory: null,
        filename: '{titleName} [{titleId}].cia',
    },
    gamecube: {
        root: '/games/',
        directory: '{titleName} [{titleId}]',
        filename: 'game{extension}',
    },
    wii: {
        root: '/wbfs/',
        directory: '{titleName} [{titleId}]',
        filename: '{titleId}{extension}',
    },
    wiiu: {
        root: '/install/',
        directory: '{titleName} [{titleId}]',
        filename: null,
    },
};

export type StorageCopyOperation = 'copy' | 'move';
export type StorageCopyItem = {
    id: string;
    platform: TitlePlatform;
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
    sourcePaths: string[];
    destinationPath: string;
    currentFilePath: string | null;
    requestedDestination: string | null;
    requestedTitleId: string;
    requestedPlatform: TitlePlatform;
    duplicateSourcePaths: string[];
};

export type StorageDeleteItem = {
    id: string;
    platform: TitlePlatform;
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
