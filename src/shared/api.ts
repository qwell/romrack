import {
    type AppConfigResponse,
    type AppConfigValidateRootResponse,
} from './config.js';
import { type Fat32Volume, type RuntimeOs } from './os.js';
import { type StorageCopyItem, type StorageDeleteItem } from './storage.js';
import { type TitleGroup } from './titles.js';

export type ApiErrorResponse = {
    error: string;
    message?: string;
    stage?: string | null;
};

export type ConfigResponse = AppConfigResponse;
export type ConfigValidateRootResponse = AppConfigValidateRootResponse;

export type Fat32ListResponse = {
    runtimeOs: RuntimeOs;
    volumes: Fat32Volume[];
};

export type LibraryResponse = {
    groups: TitleGroup[];
};

export type LibraryValidationTitle = {
    root: string | null;
    directory: string | null;
    titleName: string;
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    error: string | null;
    verification: unknown[];
};

export type LibraryValidationResponse = {
    status: 'ok' | 'failed';
    total: number;
    failed: number;
    titles: LibraryValidationTitle[];
};

export type StorageTransferQueuedResponse = {
    copyId: string;
    item: StorageCopyItem;
    sourcePath: string | null;
    titleId: string | null;
    requestedDestination: string | null;
    move: boolean;
    duplicate?: boolean;
};

export type StorageDeleteQueuedResponse = {
    deleteId: string;
    item: StorageDeleteItem;
    duplicate?: boolean;
};

export type StorageQueueResponse =
    | StorageTransferQueuedResponse
    | StorageDeleteQueuedResponse
    | ApiErrorResponse;

export type TitleResponse = {
    titleId: string;
    name: string | null;
    region: string | null;
    productCode: string | null;
    companyCode: string | null;
    baseVersions: number[];
    titleKey: string | null;
    titleKeyPassword: string | null;
    updates: number[];
    dlc: number[];
};

export type TitleDownloadResponse = {
    name: string | null;
    titleVersion: number | null;
    outputDir: string;
    sizeBytes: number;
};
