import { TitleKinds } from './titles.js';

export type DownloadActionBarCommand =
    (typeof DOWNLOAD_ACTION)[keyof typeof DOWNLOAD_ACTION];

export const DOWNLOAD_ACTION = {
    cancel: 'download.cancel',
    clear: 'download.clear',
    retry: 'download.retry',
} as const;

export const DOWNLOAD_ACTION_BAR_COMMAND_TYPES = Object.values(
    DOWNLOAD_ACTION
) as DownloadActionBarCommand[];

export function isDownloadActionBarCommand(
    value: string | null
): value is DownloadActionBarCommand {
    return (
        value !== null &&
        DOWNLOAD_ACTION_BAR_COMMAND_TYPES.includes(
            value as DownloadActionBarCommand
        )
    );
}

export type DownloadQueueState =
    | 'queued'
    | 'downloading'
    | 'failed'
    | 'complete';

export type DownloadQueueItem = {
    id: string;
    family: string;
    groupName: string;
    kind: TitleKinds;
    label: string;
    titleId: string;
    sizeText: string | null;
    totalBytes: number | null;
    state: DownloadQueueState;
    error: string | null;

    progress: number;
    downloadedBytes: number | null;
    speedText: string | null;
    completedFiles: number | null;
    totalFiles: number | null;
    currentFileName: string | null;
    installedSizeBytes: number | null;
    installedVersion: number | null;
    installedTitleName: string | null;
    installedSourcePath: string | null;
};
