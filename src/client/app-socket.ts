import { type DownloadQueueItem } from '../shared/download.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
} from '../shared/storage.js';
import {
    type SocketCommand,
    type SocketEvent,
    type TitleValidationSocketEvent,
    type LibraryConvertSocketEvent,
    type LibraryVerifyStatusEvent,
    APP_SOCKET_EVENT,
    DOWNLOAD_SOCKET_EVENT,
    STORAGE_COPY_SOCKET_EVENT,
    STORAGE_DELETE_SOCKET_EVENT,
    LIBRARY_CONVERT_SOCKET_EVENT,
    LIBRARY_VERIFY_SOCKET_EVENT,
    TITLE_VALIDATE_SOCKET_EVENT,
} from '../shared/socket.js';
import { type TitleGroup } from '../shared/titles.js';
import { syncDownloadQueue } from './download.js';
import { removeTitlesFromLibrary } from './library.js';
import { syncStorageCopies, syncStorageDeletes } from './storage.js';

type AppSocketOptions = {
    reconnectMs: number;
    onAvailable: () => void;
    onGone: () => void;
    onEvent: (event: SocketEvent) => void;
};

type AppEventOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
    haystacks: WeakMap<TitleGroup, string>;
    getGroups: () => TitleGroup[];
    onServerAvailable: () => void;
    onGroupChanged: (group: TitleGroup) => void;
    onActionsChanged?: () => void;
    onVerificationStateChanged: (verifying: boolean) => void;
    onLibraryConvertChanged?: (
        items: LibraryConvertSocketEvent['items']
    ) => void;
    onLibraryVerifyChanged: (event: LibraryVerifyStatusEvent) => void;
    onTitleValidationChanged: (event: TitleValidationSocketEvent) => void;
};

let appSocket: WebSocket | null = null;
let reconnectSocketTimer: number | null = null;
let appSocketOptions: AppSocketOptions | null = null;

export function sendAppSocketCommand(command: SocketCommand): void {
    if (!appSocket || appSocket.readyState !== WebSocket.OPEN) {
        appSocketOptions?.onGone();
        return;
    }

    appSocket.send(JSON.stringify(command));
}

function scheduleAppSocketReconnect(): void {
    const options = appSocketOptions;

    if (!options || reconnectSocketTimer !== null) {
        return;
    }

    reconnectSocketTimer = window.setTimeout(() => {
        reconnectSocketTimer = null;

        if (
            appSocket &&
            (appSocket.readyState === WebSocket.OPEN ||
                appSocket.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        connectAppSocket(options);
    }, options.reconnectMs);
}

export function connectAppSocket(options: AppSocketOptions): void {
    appSocketOptions = options;

    if (
        appSocket &&
        (appSocket.readyState === WebSocket.OPEN ||
            appSocket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    appSocket = new WebSocket(getSocketUrl());

    appSocket.addEventListener('open', () => {
        options.onAvailable();
    });

    appSocket.addEventListener('message', (event: MessageEvent) => {
        try {
            const data = JSON.parse(String(event.data)) as SocketEvent;
            options.onEvent(data);
        } catch (error) {
            console.error(error);
        }
    });

    appSocket.addEventListener('close', () => {
        options.onGone();
        scheduleAppSocketReconnect();
    });

    appSocket.addEventListener('error', () => {
        options.onGone();
        scheduleAppSocketReconnect();
    });
}

export function createAppEventHandler(
    options: AppEventOptions
): (event: SocketEvent) => void {
    const reconcileRemovedTitles = (titleIds: string[]): void => {
        removeTitlesFromLibrary(titleIds, {
            groups: options.getGroups(),
            haystacks: options.haystacks,
            onGroupChanged: options.onGroupChanged,
        });
    };

    const handle = (event: SocketEvent): void => {
        switch (event.type) {
            case APP_SOCKET_EVENT.connected:
                options.onServerAvailable();

                syncDownloadQueue(
                    options.downloads,
                    event.downloads,
                    options.haystacks,
                    options.getGroups(),
                    options.onGroupChanged
                );

                reconcileRemovedTitles(
                    syncStorageCopies(
                        options.storageCopies,
                        event.storageCopies
                    )
                );
                reconcileRemovedTitles(
                    syncStorageDeletes(
                        options.storageDeletes,
                        event.storageDeletes
                    )
                );

                if (event.libraryVerifyStatus) {
                    handle(event.libraryVerifyStatus);
                }
                options.onLibraryConvertChanged?.(event.libraryConversions);
                options.onActionsChanged?.();
                return;

            case DOWNLOAD_SOCKET_EVENT.changed:
                options.onServerAvailable();
                syncDownloadQueue(
                    options.downloads,
                    event.items,
                    options.haystacks,
                    options.getGroups(),
                    options.onGroupChanged
                );
                options.onActionsChanged?.();
                return;

            case STORAGE_COPY_SOCKET_EVENT.changed:
                options.onServerAvailable();
                reconcileRemovedTitles(
                    syncStorageCopies(options.storageCopies, event.items)
                );
                options.onActionsChanged?.();
                return;

            case STORAGE_DELETE_SOCKET_EVENT.changed:
                options.onServerAvailable();
                reconcileRemovedTitles(
                    syncStorageDeletes(options.storageDeletes, event.items)
                );
                options.onActionsChanged?.();
                return;

            case LIBRARY_VERIFY_SOCKET_EVENT.status: {
                options.onServerAvailable();
                options.onVerificationStateChanged(
                    event.status !== 'complete' && event.status !== 'failed'
                );

                options.onLibraryVerifyChanged(event);
                return;
            }

            case LIBRARY_CONVERT_SOCKET_EVENT.changed:
                options.onServerAvailable();
                options.onLibraryConvertChanged?.(event.items);
                options.onActionsChanged?.();
                return;

            case TITLE_VALIDATE_SOCKET_EVENT.changed:
                options.onServerAvailable();
                options.onTitleValidationChanged(event);
                return;
        }
    };

    return handle;
}

export function getSocketUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/api/socket`;
}
