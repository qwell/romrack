import {
    type AppConfigUpdate,
    type AppConfigResponse,
    type AppConfigValidateRootResponse,
} from '../shared/config.js';
import { type Fat32Volume, type RuntimeOs } from '../shared/os.js';
import { TitleGroup } from '../shared/titles.js';

export type Fat32ListResponse = {
    runtimeOs: RuntimeOs;
    volumes: Fat32Volume[];
};

export type LibraryValidationResponse = {
    status: 'ok' | 'failed';
    total: number;
    failed: number;
};

export type LibraryResponse = {
    groups: TitleGroup[];
};

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
): Promise<unknown> {
    const params = new URLSearchParams({
        titleId,
        dest: destination,
    });
    return requestJson(`/api/storage/copy?${params}`);
}

export function queueStorageDelete(titleId: string): Promise<unknown> {
    const params = new URLSearchParams({ titleId });
    return requestJson(`/api/storage/delete?${params}`);
}

export function getConfig(): Promise<AppConfigResponse> {
    return requestJson('/api/config');
}

export function saveConfig(
    update: AppConfigUpdate
): Promise<AppConfigResponse> {
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
): Promise<AppConfigValidateRootResponse> {
    return requestJson('/api/config/validate-root', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ root }),
    });
}
