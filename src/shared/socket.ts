import { type DownloadQueueItem } from './download.js';

import { type StorageCopyItem, type StorageDeleteItem } from './storage.js';

export const SOCKET_COMMAND = {
    downloadQueue: 'download.queue',
    downloadRetry: 'download.retry',
    downloadClear: 'download.clear',
    downloadCancel: 'download.cancel',
    storageCopyRetry: 'storage.copy.retry',
    storageCopyClear: 'storage.copy.clear',
    storageCopyCancel: 'storage.copy.cancel',
    storageDeleteRetry: 'storage.delete.retry',
    storageDeleteClear: 'storage.delete.clear',
    libraryValidateCancel: 'library.validate.cancel',
    libraryValidateClear: 'library.validate.clear',
    libraryValidateFailureClear: 'library.validate.failure.clear',
    libraryValidateFailureDownload: 'library.validate.failure.download',
    titleVerifyQueue: 'title.verify.queue',
} as const;

export const SOCKET_EVENT = {
    appConnected: 'app.connected',
    downloadQueueChanged: 'download.queueChanged',
    storageCopyChanged: 'storage.copyChanged',
    storageDeleteChanged: 'storage.deleteChanged',
    libraryValidateStatus: 'library.validateStatus',
    titleVerifyChanged: 'title.verify.changed',
} as const;

export const DOWNLOAD_SOCKET_COMMAND = {
    queue: SOCKET_COMMAND.downloadQueue,
    retry: SOCKET_COMMAND.downloadRetry,
    clear: SOCKET_COMMAND.downloadClear,
    cancel: SOCKET_COMMAND.downloadCancel,
} as const;

export const STORAGE_COPY_SOCKET_COMMAND = {
    retry: SOCKET_COMMAND.storageCopyRetry,
    clear: SOCKET_COMMAND.storageCopyClear,
    cancel: SOCKET_COMMAND.storageCopyCancel,
} as const;

export const STORAGE_DELETE_SOCKET_COMMAND = {
    retry: SOCKET_COMMAND.storageDeleteRetry,
    clear: SOCKET_COMMAND.storageDeleteClear,
} as const;

export const LIBRARY_VALIDATE_SOCKET_COMMAND = {
    cancel: SOCKET_COMMAND.libraryValidateCancel,
    clear: SOCKET_COMMAND.libraryValidateClear,
    failureClear: SOCKET_COMMAND.libraryValidateFailureClear,
    failureDownload: SOCKET_COMMAND.libraryValidateFailureDownload,
} as const;

export const TITLE_VERIFY_SOCKET_COMMAND = {
    queue: SOCKET_COMMAND.titleVerifyQueue,
} as const;

export const APP_SOCKET_EVENT = {
    connected: SOCKET_EVENT.appConnected,
} as const;

export const DOWNLOAD_SOCKET_EVENT = {
    changed: SOCKET_EVENT.downloadQueueChanged,
} as const;

export const STORAGE_COPY_SOCKET_EVENT = {
    changed: SOCKET_EVENT.storageCopyChanged,
} as const;

export const STORAGE_DELETE_SOCKET_EVENT = {
    changed: SOCKET_EVENT.storageDeleteChanged,
} as const;

export const LIBRARY_VALIDATE_SOCKET_EVENT = {
    status: SOCKET_EVENT.libraryValidateStatus,
} as const;

export const TITLE_VERIFY_SOCKET_EVENT = {
    changed: SOCKET_EVENT.titleVerifyChanged,
} as const;

export type DownloadSocketCommand =
    | {
          type: typeof DOWNLOAD_SOCKET_COMMAND.queue;
          items: DownloadQueueItem[];
      }
    | {
          type: typeof DOWNLOAD_SOCKET_COMMAND.retry;
          id: string;
      }
    | {
          type: typeof DOWNLOAD_SOCKET_COMMAND.clear;
          id: string;
      }
    | {
          type: typeof DOWNLOAD_SOCKET_COMMAND.cancel;
          id: string;
      };

export type StorageCopySocketCommand =
    | {
          type: typeof STORAGE_COPY_SOCKET_COMMAND.retry;
          id: string;
      }
    | {
          type: typeof STORAGE_COPY_SOCKET_COMMAND.clear;
          id: string;
      }
    | {
          type: typeof STORAGE_COPY_SOCKET_COMMAND.cancel;
          id: string;
      };

export type StorageDeleteSocketCommand =
    | {
          type: typeof STORAGE_DELETE_SOCKET_COMMAND.retry;
          id: string;
      }
    | {
          type: typeof STORAGE_DELETE_SOCKET_COMMAND.clear;
          id: string;
      };

export type LibraryValidateSocketCommand =
    | {
          type: typeof LIBRARY_VALIDATE_SOCKET_COMMAND.cancel;
      }
    | {
          type: typeof LIBRARY_VALIDATE_SOCKET_COMMAND.clear;
      }
    | {
          type: typeof LIBRARY_VALIDATE_SOCKET_COMMAND.failureClear;
      }
    | {
          type: typeof LIBRARY_VALIDATE_SOCKET_COMMAND.failureDownload;
      };

export type TitleVerifySocketCommand = {
    type: typeof TITLE_VERIFY_SOCKET_COMMAND.queue;
    titleId: string;
    name: string;
};

export type SocketCommand =
    | DownloadSocketCommand
    | StorageCopySocketCommand
    | StorageDeleteSocketCommand
    | LibraryValidateSocketCommand
    | TitleVerifySocketCommand;

export type AppConnectedEvent = {
    type: typeof APP_SOCKET_EVENT.connected;
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
    libraryValidateStatus?: LibraryValidateStatusEvent | null;
};

export type DownloadSocketEvent = {
    type: typeof DOWNLOAD_SOCKET_EVENT.changed;
    items: DownloadQueueItem[];
};

export type StorageCopySocketEvent = {
    type: typeof STORAGE_COPY_SOCKET_EVENT.changed;
    items: StorageCopyItem[];
};

export type StorageDeleteSocketEvent = {
    type: typeof STORAGE_DELETE_SOCKET_EVENT.changed;
    items: StorageDeleteItem[];
};

export type LibraryValidateStatus =
    | 'started'
    | 'validating'
    | 'validated'
    | 'complete'
    | 'failed';

export type LibraryValidateStatusEvent = {
    type: typeof SOCKET_EVENT.libraryValidateStatus;
    status: LibraryValidateStatus;
    titleId?: string;
    name?: string;
    kind?: string;
    sizeText?: string;
    result?: 'ok' | 'failed';
    current?: number;
    total?: number;
    failed?: number;
    error?: string | null;
};

export type TitleVerifyCopyResult = {
    sourcePath: string;
    titleId: string | null;
    titleKind: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    failedCount: number;
    totalCount: number;
    error: string | null;
};

export type TitleVerifySocketEvent = {
    type: typeof SOCKET_EVENT.titleVerifyChanged;
    titleId: string;
    status: 'verifying' | 'complete' | 'failed';
    copies: TitleVerifyCopyResult[];
    error?: string | null;
};

export type SocketEvent =
    | AppConnectedEvent
    | DownloadSocketEvent
    | StorageCopySocketEvent
    | StorageDeleteSocketEvent
    | LibraryValidateStatusEvent
    | TitleVerifySocketEvent;

export function isSocketCommand<T extends SocketCommand['type']>(
    command: SocketCommand,
    type?: T | readonly T[] | Record<string, T>
): command is Extract<SocketCommand, { type: T }> {
    if (!type) {
        return Object.values(SOCKET_COMMAND).includes(command.type);
    }
    if (typeof type === 'object' && !Array.isArray(type)) {
        return Object.values(type).includes(command.type as T);
    }
    if (Array.isArray(type)) {
        return type.includes(command.type);
    }
    return type === command.type;
}
