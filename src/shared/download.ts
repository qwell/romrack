import { TitleKinds, type TitlePlatform } from './titles.js';
import { type ActionState } from './action.js';

export type DownloadQueueItemDetails = {
    id: string;
    platform: TitlePlatform;
    family: string;
    groupName: string;
    kind: TitleKinds;
    label: string;
    titleId: string;
    sizeText: string | null;
    totalBytes: number | null;
};

export type DownloadQueueItem = DownloadQueueItemDetails & {
    state: ActionState;
    error: string | null;

    progress: number;
    downloadedBytes: number | null;
    speedText: string | null;
    completedFiles: number | null;
    totalFiles: number | null;
    currentFileName: string | null;
    currentFileSizeBytes: number | null;
    installedSizeBytes: number | null;
    installedVersion: number | null;
    installedTitleName: string | null;
    installedSourcePath: string | null;
};

export function isHttpErrorStatus(error: unknown, status: number): boolean {
    return error instanceof HttpError && error.status === status;
}

export class HttpError extends Error {
    status: number;
    details: string | null;

    constructor(url: string, status: number, details: string | null = null) {
        super(
            details
                ? `${details}: HTTP ${status.toString()} (${url})`
                : `Request failed for ${url}: HTTP ${status.toString()}`
        );
        this.name = 'HttpError';
        this.status = status;
        this.details = details;
    }
}
