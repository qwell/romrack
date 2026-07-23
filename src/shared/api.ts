import {
    type AppConfigResponse,
    type AppConfigValidateRootResponse,
} from './config.js';
import { type Fat32Volume, type RuntimeOs } from './os/types.js';
import { type StorageCopyItem, type StorageDeleteItem } from './storage.js';
import { type LibraryConvertItem } from './socket.js';
import {
    type TitleGroup,
    type TitleKinds,
    type TitlePlatform,
} from './titles.js';
import { HttpError } from './download.js';
import { isObject } from './utils.js';

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

export type LibraryRenameResponse = {
    renamed: number;
    unchanged: number;
    conflicts: string[];
};

export type LibraryRenamePreviewResponse = {
    renames: number;
    unchanged: number;
    conflicts: string[];
};

export type LibraryVerifyTitle = {
    platform: TitlePlatform;
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

export type LibraryVerifyProgress =
    | {
          titleId: string;
          platform: TitlePlatform;
          name: string;
          kind: TitleKinds;
          version: number | null;
          currentFileName?: string | null;
          currentFileSizeBytes?: number | null;
          current: number;
          total: number;
          result?: undefined;
      }
    | {
          titleId: string;
          platform: TitlePlatform;
          name: string;
          kind: TitleKinds;
          version: number | null;
          result: 'ok' | 'failed';
          error: string | null;
          current: number;
          total: number;
      };

export type LibraryVerifyResponse = {
    status: 'ok' | 'failed' | 'cancelled';
    total: number;
    failed: number;
    titles: LibraryVerifyTitle[];
};

export function sortLibraryTitleVerifications(
    verifications: LibraryVerifyTitle[]
): LibraryVerifyTitle[] {
    return verifications.sort((a, b) => {
        const nameComparison = a.name.localeCompare(b.name);
        if (nameComparison !== 0) {
            return nameComparison;
        }

        return (a.directory ?? a.titleId ?? '').localeCompare(
            b.directory ?? b.titleId ?? ''
        );
    });
}

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

export type StorageDeleteQueuedResponse = {
    storageDeleteId: string;
    item: StorageDeleteItem;
    duplicate?: boolean;
};

export type StorageQueueResponse =
    | StorageTransferQueuedResponse
    | StorageDeleteQueuedResponse
    | ApiErrorResponse;

export type TitleLookupResponse = {
    titleId: string;
    name: string | null;
    region: string | null;
    productCode: string | null;
    companyCode: string | null;
    baseVersions: number[];
    updateVersions: number[];
    dlcVersions: number[];
    iconUrl?: string | null;
    availableOnCdn?: boolean;
};

export type TitleLookupWiiUResponse = TitleLookupResponse & {
    titleKey: string | null;
    titleKeyPassword: string | null;
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
    const text = await response.text();

    if (!response.ok) {
        let details: string | null = null;
        try {
            const body = JSON.parse(text) as unknown;
            if (isObject(body)) {
                details =
                    typeof body.message === 'string'
                        ? body.message
                        : typeof body.error === 'string'
                          ? body.error
                          : null;
            }
        } catch {
            details = text.trim() || null;
        }

        throw new HttpError(url, response.status, details);
    }

    return JSON.parse(text) as T;
}
