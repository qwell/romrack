import { type DownloadQueueItem } from '../shared/download.js';
import { type DeleteItem } from '../shared/delete.js';
import { type StorageCopyItem } from '../shared/storage.js';
import {
    type SocketCommand,
    type SocketEvent,
    type TitleValidationSocketEvent,
    type LibraryConvertSocketEvent,
    type LibraryValidateStatusEvent,
    APP_SOCKET_EVENT,
    DOWNLOAD_SOCKET_EVENT,
    STORAGE_COPY_SOCKET_EVENT,
    DELETE_SOCKET_EVENT,
    LIBRARY_CONVERT_SOCKET_EVENT,
    LIBRARY_VALIDATE_SOCKET_EVENT,
    TITLE_VALIDATE_SOCKET_EVENT,
} from '../shared/socket.js';
import { type TitleGroup } from '../shared/titles.js';
import { syncDownloadQueue } from './download.js';
import { removeTitlesFromLibrary } from './library.js';
import { getCompletedDeletedTitleIds, syncDeletes } from './delete.js';
import { getCompletedMovedTitleIds, syncStorageCopies } from './storage.js';

type AppSocketOptions = {
    reconnectMs: number;
    onAvailable: () => void;
    onGone: () => void;
    onEvent: (event: SocketEvent) => void;
};

type AppEventOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    deletes: DeleteItem[];
    haystacks: WeakMap<TitleGroup, string>;
    getGroups: () => TitleGroup[];
    onServerAvailable: () => void;
    onGroupChanged: (group: TitleGroup) => void;
    onActionsChanged?: () => void;
    onValidationStateChanged: (validating: boolean) => void;
    onLibraryConvertChanged?: (
        items: LibraryConvertSocketEvent['items']
    ) => void;
    onLibraryValidateChanged: (event: LibraryValidateStatusEvent) => void;
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
                    getCompletedMovedTitleIds(
                        syncStorageCopies(
                            options.storageCopies,
                            event.storageCopies
                        )
                    )
                );
                reconcileRemovedTitles(
                    getCompletedDeletedTitleIds(
                        syncDeletes(options.deletes, event.deletes)
                    )
                );

                if (event.libraryValidateStatus) {
                    handle(event.libraryValidateStatus);
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
                    getCompletedMovedTitleIds(
                        syncStorageCopies(options.storageCopies, event.items)
                    )
                );
                options.onActionsChanged?.();
                return;

            case DELETE_SOCKET_EVENT.changed:
                options.onServerAvailable();
                reconcileRemovedTitles(
                    getCompletedDeletedTitleIds(
                        syncDeletes(options.deletes, event.items)
                    )
                );
                options.onActionsChanged?.();
                return;

            case LIBRARY_VALIDATE_SOCKET_EVENT.status: {
                options.onServerAvailable();
                options.onValidationStateChanged(
                    event.status !== 'complete' && event.status !== 'failed'
                );

                options.onLibraryValidateChanged(event);
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
