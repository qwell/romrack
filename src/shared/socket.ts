import { DownloadQueueItem, StorageCopyItem } from './shared.js';

export type AppConnectedEvent = {
    type: 'app.connected';
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    libraryValidationStatus?: ValidationStatusEvent | null;
};

export type DownloadSocketCommand =
    | {
          type: 'download.queue';
          items: DownloadQueueItem[];
      }
    | {
          type: 'download.retry';
          id: string;
      }
    | {
          type: 'download.remove';
          id: string;
      }
    | {
          type: 'download.cancel';
          id: string;
      };

export type DownloadSocketEvent = {
    type: 'download.queueChanged';
    items: DownloadQueueItem[];
};

export type StorageCopySocketEvent = {
    type: 'storage.copyChanged';
    items: StorageCopyItem[];
};

export type StorageCopySocketCommand =
    | {
          type: 'storage.copy.retry';
          id: string;
      }
    | {
          type: 'storage.copy.remove';
          id: string;
      }
    | {
          type: 'storage.copy.cancel';
          id: string;
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

export type AppSocketCommand = DownloadSocketCommand | StorageCopySocketCommand;

export type AppSocketEvent =
    | AppConnectedEvent
    | DownloadSocketEvent
    | StorageCopySocketEvent
    | ValidationStatusEvent;
