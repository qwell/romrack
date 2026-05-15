import {
    type ConfigResponse,
    type ConfigValidateRootResponse,
    type Fat32ListResponse,
    type LibraryResponse,
    type LibraryValidationResponse,
    type StorageDeleteQueuedResponse,
    type StorageTransferQueuedResponse,
} from '../shared/api.js';
import { type AppConfigUpdate } from '../shared/config.js';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
}

export function getLibrary(includeAll: boolean): Promise<LibraryResponse> {
    return requestJson(
        includeAll ? '/api/library?includeAll=true' : '/api/library'
    );
}

export function validateLibrary(): Promise<LibraryValidationResponse> {
    return requestJson('/api/library/validate');
}

export function listFat32Volumes(): Promise<Fat32ListResponse> {
    return requestJson('/api/storage/list-fat32');
}

export function queueStorageCopy(
    titleId: string,
    destination: string
): Promise<StorageTransferQueuedResponse> {
    const params = new URLSearchParams({
        titleId,
        dest: destination,
    });
    return requestJson(`/api/storage/copy?${params}`);
}

export function queueStorageDelete(
    titleId: string
): Promise<StorageDeleteQueuedResponse> {
    const params = new URLSearchParams({ titleId });
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
