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
} as const;

export const DOWNLOAD_SOCKET_COMMAND_TYPES = [
    SOCKET_COMMAND.downloadQueue,
    SOCKET_COMMAND.downloadRetry,
    SOCKET_COMMAND.downloadClear,
    SOCKET_COMMAND.downloadCancel,
] as const;

export const DOWNLOAD_ID_SOCKET_COMMAND_TYPES = [
    SOCKET_COMMAND.downloadRetry,
    SOCKET_COMMAND.downloadClear,
    SOCKET_COMMAND.downloadCancel,
] as const;

export const STORAGE_COPY_SOCKET_COMMAND_TYPES = [
    SOCKET_COMMAND.storageCopyRetry,
    SOCKET_COMMAND.storageCopyClear,
    SOCKET_COMMAND.storageCopyCancel,
] as const;

export const STORAGE_DELETE_SOCKET_COMMAND_TYPES = [
    SOCKET_COMMAND.storageDeleteRetry,
    SOCKET_COMMAND.storageDeleteClear,
] as const;

export const ID_SOCKET_COMMAND_TYPES = [
    ...DOWNLOAD_ID_SOCKET_COMMAND_TYPES,
    ...STORAGE_COPY_SOCKET_COMMAND_TYPES,
    ...STORAGE_DELETE_SOCKET_COMMAND_TYPES,
] as const;

export type IdSocketCommandType = (typeof ID_SOCKET_COMMAND_TYPES)[number];

export function isIdSocketCommandType(
    value: unknown
): value is IdSocketCommandType {
    return ID_SOCKET_COMMAND_TYPES.includes(value as IdSocketCommandType);
}

export type AppConnectedEvent = {
    type: 'app.connected';
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
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
          type: 'download.clear';
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

export type StorageDeleteSocketEvent = {
    type: 'storage.deleteChanged';
    items: StorageDeleteItem[];
};

export type StorageCopySocketCommand =
    | {
          type: 'storage.copy.retry';
          id: string;
      }
    | {
          type: 'storage.copy.clear';
          id: string;
      }
    | {
          type: 'storage.copy.cancel';
          id: string;
      };

export type StorageDeleteSocketCommand =
    | {
          type: 'storage.delete.retry';
          id: string;
      }
    | {
          type: 'storage.delete.clear';
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

export type AppSocketCommand =
    | DownloadSocketCommand
    | StorageCopySocketCommand
    | StorageDeleteSocketCommand;

export function isDownloadSocketCommand(
    command: AppSocketCommand
): command is DownloadSocketCommand {
    return DOWNLOAD_SOCKET_COMMAND_TYPES.includes(
        command.type as (typeof DOWNLOAD_SOCKET_COMMAND_TYPES)[number]
    );
}

export function isStorageCopySocketCommand(
    command: AppSocketCommand
): command is StorageCopySocketCommand {
    return STORAGE_COPY_SOCKET_COMMAND_TYPES.includes(
        command.type as (typeof STORAGE_COPY_SOCKET_COMMAND_TYPES)[number]
    );
}

export function isStorageDeleteSocketCommand(
    command: AppSocketCommand
): command is StorageDeleteSocketCommand {
    return STORAGE_DELETE_SOCKET_COMMAND_TYPES.includes(
        command.type as (typeof STORAGE_DELETE_SOCKET_COMMAND_TYPES)[number]
    );
}

export type AppSocketEvent =
    | AppConnectedEvent
    | DownloadSocketEvent
    | StorageCopySocketEvent
    | StorageDeleteSocketEvent
    | ValidationStatusEvent;
