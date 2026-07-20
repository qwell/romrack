import {
    requestJson,
    type ConfigResponse,
    type ConfigValidateRootResponse,
    type LibraryResponse,
    type LibraryConvertQueuedResponse,
    type LibraryVerifyResponse,
    type StorageFat32ListResponse,
    type StorageDeleteQueuedResponse,
    type StorageTransferQueuedResponse,
} from '../shared/api.js';
import { type AppConfigUpdate } from '../shared/config.js';
import { type TitlePlatform } from '../shared/titles.js';

export function getLibrary(
    options: { clearScanCache?: boolean } = {}
): Promise<LibraryResponse> {
    const params = new URLSearchParams();
    if (options.clearScanCache) {
        params.set('clearScanCache', '1');
    }

    return requestJson(`/api/library${params.size > 0 ? `?${params}` : ''}`);
}

export function verifyLibrary(): Promise<LibraryVerifyResponse> {
    return requestJson('/api/library/verify');
}

export function queueLibraryConvert(
    titleId: string
): Promise<LibraryConvertQueuedResponse> {
    const params = new URLSearchParams({ titleId });
    return requestJson(`/api/library/convert?${params}`);
}

export function listFat32Volumes(): Promise<StorageFat32ListResponse> {
    return requestJson('/api/storage/list-fat32');
}

export function queueStorageCopy(
    titleId: string,
    destination: string,
    platform: TitlePlatform
): Promise<StorageTransferQueuedResponse> {
    const params = new URLSearchParams({
        titleId,
        dest: destination,
        platform,
    });
    return requestJson(`/api/storage/copy?${params}`);
}

export function queueStorageDelete(
    titleId: string,
    platform: TitlePlatform
): Promise<StorageDeleteQueuedResponse> {
    const params = new URLSearchParams({ titleId, platform });
    return requestJson(`/api/storage/delete?${params}`);
}

export function getConfig(): Promise<ConfigResponse> {
    return requestJson('/api/config');
}

export function saveConfig(update: AppConfigUpdate): Promise<ConfigResponse> {
    return requestJson('/api/config', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(update),
    });
}

export function validateConfigRoot(
    root: string
): Promise<ConfigValidateRootResponse> {
    return requestJson('/api/config/validate-root', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ root }),
    });
}
