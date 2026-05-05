import { TitleKinds } from './shared.js';

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
    installedSizeBytes: number | null;
    installedVersion: number | null;
    installedTitleName: string | null;
};

export type DownloadSocketCommand =
    | {
          type: 'download.enqueue';
          items: DownloadQueueItem[];
      }
    | {
          type: 'download.retry';
          id: string;
      }
    | {
          type: 'download.remove';
          id: string;
      };

export type DownloadSocketEvent = {
    type: 'download.queueChanged';
    items: DownloadQueueItem[];
};

export type AppSocketCommand = DownloadSocketCommand;

export type AppSocketEvent =
    | { type: 'app.connected'; downloads: DownloadQueueItem[] }
    | DownloadSocketEvent;
