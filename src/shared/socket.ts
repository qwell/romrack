import { type DownloadQueueItem } from './download.js';
import { type DeleteItem } from './delete.js';
import { type ActionState } from './action.js';

import { type StorageCopyItem } from './storage.js';
import { TitleKinds } from './titles.js';

export const SOCKET_COMMAND = {
    downloadQueue: 'download.queue',
    downloadRetry: 'download.retry',
    downloadClear: 'download.clear',
    downloadCancel: 'download.cancel',
    storageCopyRetry: 'storage.copy.retry',
    storageCopyClear: 'storage.copy.clear',
    storageCopyCancel: 'storage.copy.cancel',
    deleteRetry: 'delete.retry',
    deleteClear: 'delete.clear',
    deleteCancel: 'delete.cancel',
    libraryValidateCancel: 'library.validate.cancel',
    libraryValidateClear: 'library.validate.clear',
    libraryValidateDownload: 'library.validate.download',
    libraryConvertCancel: 'library.convert.cancel',
    libraryConvertClear: 'library.convert.clear',
    libraryConvertRetry: 'library.convert.retry',
    titleValidateQueue: 'title.validate.queue',
} as const;

export const SOCKET_EVENT = {
    appConnected: 'app.connected',
    downloadQueueChanged: 'download.queueChanged',
    storageCopyChanged: 'storage.copyChanged',
    deleteChanged: 'delete.changed',
    libraryValidateStatus: 'library.validateStatus',
    libraryConvertChanged: 'library.convertChanged',
    titleValidateChanged: 'title.validate.changed',
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

export const DELETE_SOCKET_COMMAND = {
    retry: SOCKET_COMMAND.deleteRetry,
    clear: SOCKET_COMMAND.deleteClear,
    cancel: SOCKET_COMMAND.deleteCancel,
} as const;

export const LIBRARY_VALIDATE_SOCKET_COMMAND = {
    cancel: SOCKET_COMMAND.libraryValidateCancel,
    clear: SOCKET_COMMAND.libraryValidateClear,
    download: SOCKET_COMMAND.libraryValidateDownload,
} as const;

export const TITLE_VALIDATE_SOCKET_COMMAND = {
    queue: SOCKET_COMMAND.titleValidateQueue,
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

export const DELETE_SOCKET_EVENT = {
    changed: SOCKET_EVENT.deleteChanged,
} as const;

export const LIBRARY_VALIDATE_SOCKET_EVENT = {
    status: SOCKET_EVENT.libraryValidateStatus,
} as const;

export const LIBRARY_CONVERT_SOCKET_EVENT = {
    changed: SOCKET_EVENT.libraryConvertChanged,
} as const;

export const LIBRARY_CONVERT_SOCKET_COMMAND = {
    cancel: SOCKET_COMMAND.libraryConvertCancel,
    clear: SOCKET_COMMAND.libraryConvertClear,
    retry: SOCKET_COMMAND.libraryConvertRetry,
} as const;

export const TITLE_VALIDATE_SOCKET_EVENT = {
    changed: SOCKET_EVENT.titleValidateChanged,
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

export type DeleteSocketCommand =
    | {
          type: typeof DELETE_SOCKET_COMMAND.retry;
          id: string;
      }
    | {
          type: typeof DELETE_SOCKET_COMMAND.clear;
          id: string;
      }
    | {
          type: typeof DELETE_SOCKET_COMMAND.cancel;
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
          type: typeof LIBRARY_VALIDATE_SOCKET_COMMAND.download;
      };

export type LibraryConvertSocketCommand =
    | {
          type: typeof LIBRARY_CONVERT_SOCKET_COMMAND.cancel;
          id: string;
      }
    | {
          type: typeof LIBRARY_CONVERT_SOCKET_COMMAND.clear;
          id: string;
      }
    | {
          type: typeof LIBRARY_CONVERT_SOCKET_COMMAND.retry;
          id: string;
      };

export type TitleValidationSocketCommand = {
    type: typeof TITLE_VALIDATE_SOCKET_COMMAND.queue;
    titleId: string;
    name: string;
};

export type SocketCommand =
    | DownloadSocketCommand
    | StorageCopySocketCommand
    | DeleteSocketCommand
    | LibraryValidateSocketCommand
    | LibraryConvertSocketCommand
    | TitleValidationSocketCommand;

export type AppConnectedEvent = {
    type: typeof APP_SOCKET_EVENT.connected;
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    deletes: DeleteItem[];
    libraryValidateStatus?: LibraryValidateStatusEvent | null;
    libraryConversions: LibraryConvertItem[];
};

export type DownloadSocketEvent = {
    type: typeof DOWNLOAD_SOCKET_EVENT.changed;
    items: DownloadQueueItem[];
};

export type StorageCopySocketEvent = {
    type: typeof STORAGE_COPY_SOCKET_EVENT.changed;
    items: StorageCopyItem[];
};

export type DeleteSocketEvent = {
    type: typeof DELETE_SOCKET_EVENT.changed;
    items: DeleteItem[];
};

export type LibraryValidateStatus =
    | 'started'
    | 'validating'
    | 'validated'
    | 'complete'
    | 'failed'
    | 'cancelled';

export type LibraryValidateStatusEvent = {
    type: typeof SOCKET_EVENT.libraryValidateStatus;
    state: ActionState;
    status: LibraryValidateStatus;
    titleId?: string;
    name?: string;
    kind?: TitleKinds;
    version?: number | null;
    currentFileName?: string | null;
    currentFileSizeBytes?: number | null;
    result?: 'ok' | 'failed';
    current?: number;
    total?: number;
    failed?: number;
    error?: string | null;
};

export type LibraryConvertItem = {
    id: string;
    titleId: string;
    name: string | null;
    kind: TitleKinds;
    version: number | null;
    state: ActionState;
    currentFileName: string | null;
    current: number | null;
    total: number | null;
    currentFileSizeBytes: number | null;
    converted: number | null;
    convertedTitles: Array<{
        titleId: string;
        name: string;
        kind: TitleKinds;
        version: number;
        sizeBytes: number;
    }> | null;
    error: string | null;
};

export type LibraryConvertSocketEvent = {
    type: typeof SOCKET_EVENT.libraryConvertChanged;
    items: LibraryConvertItem[];
};

export type TitleValidationCopyResult = {
    sourcePath: string;
    titleId: string | null;
    titleKind: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    failedCount: number;
    totalCount: number;
    error: string | null;
};

export type TitleValidationSocketEvent = {
    type: typeof SOCKET_EVENT.titleValidateChanged;
    titleId: string;
    status: 'validating' | 'complete' | 'failed';
    copies: TitleValidationCopyResult[];
    error?: string | null;
};

export type SocketEvent =
    | AppConnectedEvent
    | DownloadSocketEvent
    | StorageCopySocketEvent
    | DeleteSocketEvent
    | LibraryValidateStatusEvent
    | LibraryConvertSocketEvent
    | TitleValidationSocketEvent;

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
