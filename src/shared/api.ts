import {
    type AppConfigResponse,
    type AppConfigValidateRootResponse,
} from './config.js';
import { type Fat32Volume, type RuntimeOs } from './os.js';
import { type DeleteItem } from './delete.js';
import { type StorageCopyItem } from './storage.js';
import { type LibraryConvertItem } from './socket.js';
import { type TitleGroup, type TitleKinds } from './titles.js';
import { HttpError } from './download.js';

export type ApiErrorResponse = {
    error: string;
    message?: string;
    stage?: string | null;
};

export type ConfigResponse = AppConfigResponse;
export type ConfigValidateRootResponse = AppConfigValidateRootResponse;

export type StorageFat32ListResponse = {
    runtimeOs: RuntimeOs;
    volumes: Fat32Volume[];
};

export type LibraryResponse = {
    groups: TitleGroup[];
};

export type LibraryValidateTitle = {
    root: string | null;
    directory: string | null;
    name: string;
    titleId: string | null;
    version: number | null;
    kind: TitleKinds;
    sizeText: string | null;
    status: 'ok' | 'failed';
    error: string | null;
    verification: unknown[];
};

export type LibraryValidateResponse = {
    status: 'ok' | 'failed' | 'cancelled';
    total: number;
    failed: number;
    titles: LibraryValidateTitle[];
};

export type LibraryConvertQueuedResponse = {
    conversionId: string;
    item: LibraryConvertItem;
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

export type DeleteQueuedResponse = {
    deleteId: string;
    item: DeleteItem;
    duplicate?: boolean;
};

export type StorageQueueResponse =
    | StorageTransferQueuedResponse
    | DeleteQueuedResponse
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
    updateVersions: number[];
    dlcVersions: number[];
};

export type TitleDownloadResponse = {
    name: string | null;
    titleVersion: number | null;
    outputDir: string;
    sizeBytes: number;
};

export async function requestJson<T>(
    url: string,
    init?: RequestInit
): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new HttpError(url, response.status);
    }

    return (await response.json()) as T;
}
