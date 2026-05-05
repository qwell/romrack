import { TitleKinds } from './shared.js';

export type AppConnectedEvent = {
    type: 'app.connected';
    downloads: DownloadQueueItem[];
    libraryValidationStatus?: ValidationStatusEvent | null;
};

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

export type ValidationStatus =
    | 'started'
    | 'validating'
    | 'validated'
    | 'complete'
    | 'failed';

export type ValidationStatusEvent = {
    type: 'library.validationStatus';
    status: ValidationStatus;
    titleId?: string;
    titleName?: string;
    titleKind?: string;
    sizeText?: string;
    result?: 'ok' | 'failed';
    total?: number;
    failed?: number;
    error?: string;
};

export type AppSocketCommand = DownloadSocketCommand;

export type AppSocketEvent =
    | AppConnectedEvent
    | DownloadSocketEvent
    | ValidationStatusEvent;
