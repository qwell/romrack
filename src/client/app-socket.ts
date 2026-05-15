import {
    DownloadQueueItem,
    StorageCopyItem,
    StorageDeleteItem,
} from '../shared/shared.js';
import {
    type AppSocketCommand,
    type AppSocketEvent,
} from '../shared/socket.js';
import { TitleGroup } from '../shared/titles.js';
import { syncDownloadQueue } from './download.js';
import {
    markStorageCopiesComplete,
    markStorageDeletesComplete,
} from './library-state.js';
import { syncStorageCopies, syncStorageDeletes } from './storage.js';

type AppSocketOptions = {
    reconnectMs: number;
    onAvailable: () => void;
    onGone: () => void;
    onEvent: (event: AppSocketEvent) => void;
};

let appSocket: WebSocket | null = null;
let reconnectSocketTimer: number | null = null;
let appSocketOptions: AppSocketOptions | null = null;

function getSocketUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/api/socket`;
}

export function sendAppSocketCommand(command: AppSocketCommand): void {
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
            const data = JSON.parse(String(event.data)) as AppSocketEvent;
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

export type LibraryStatusTone = 'info' | 'success' | 'error';

type AppEventOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
    haystacks: WeakMap<TitleGroup, string>;
    getGroups: () => TitleGroup[];
    onServerAvailable: () => void;
    onGroupChanged: (group: TitleGroup) => void;
    onValidationStateChanged: (validating: boolean) => void;
    onLibraryStatusChanged: (message: string, tone: LibraryStatusTone) => void;
};

function formatValidationStatus(event: AppSocketEvent): string | null {
    if (event.type !== 'library.validationStatus') {
        return null;
    }

    switch (event.status) {
        case 'started':
            return 'Validating library...';

        case 'validating':
            return `Validating library... [${event.titleId}] ${event.titleName} [${event.titleKind}] (${event.sizeText})`;

        case 'validated':
            return `Validated library... [${event.titleId}] ${event.titleName} [${event.titleKind}] (${event.result})`;

        case 'complete':
            return event.failed === 0
                ? `Validation passed for ${event.total} titles.`
                : `Validation failed for ${event.failed} of ${event.total} titles. Check the server logs for details.`;
        case 'failed':
            return event.error
                ? `Failed to validate library. ${event.error}`
                : 'Failed to validate library.';
    }
}

export function createAppEventHandler(
    options: AppEventOptions
): (event: AppSocketEvent) => void {
    const getStorageCompletionOptions = () => ({
        groups: options.getGroups(),
        haystacks: options.haystacks,
        onGroupChanged: options.onGroupChanged,
    });

    const handle = (event: AppSocketEvent): void => {
        switch (event.type) {
            case 'app.connected':
                options.onServerAvailable();

                syncDownloadQueue(
                    options.downloads,
                    event.downloads,
                    options.haystacks,
                    options.getGroups()
                );

                syncStorageCopies(options.storageCopies, event.storageCopies);
                markStorageCopiesComplete(
                    event.storageCopies,
                    getStorageCompletionOptions()
                );
                syncStorageDeletes(
                    options.storageDeletes,
                    event.storageDeletes
                );
                markStorageDeletesComplete(
                    event.storageDeletes,
                    getStorageCompletionOptions()
                );

                if (event.libraryValidationStatus) {
                    handle(event.libraryValidationStatus);
                }
                return;

            case 'download.queueChanged':
                options.onServerAvailable();
                syncDownloadQueue(
                    options.downloads,
                    event.items,
                    options.haystacks,
                    options.getGroups()
                );
                return;

            case 'storage.copyChanged':
                options.onServerAvailable();
                syncStorageCopies(options.storageCopies, event.items);
                markStorageCopiesComplete(
                    event.items,
                    getStorageCompletionOptions()
                );
                return;

            case 'storage.deleteChanged':
                options.onServerAvailable();
                syncStorageDeletes(options.storageDeletes, event.items);
                markStorageDeletesComplete(
                    event.items,
                    getStorageCompletionOptions()
                );
                return;

            case 'library.validationStatus': {
                options.onServerAvailable();
                options.onValidationStateChanged(
                    event.status !== 'complete' && event.status !== 'failed'
                );

                const message = formatValidationStatus(event);
                if (!message) {
                    return;
                }

                const tone =
                    event.status === 'complete' && event.failed === 0
                        ? 'success'
                        : event.status === 'failed' ||
                            (event.status === 'complete' && event.failed !== 0)
                          ? 'error'
                          : 'info';

                options.onLibraryStatusChanged(message, tone);
                return;
            }
        }
    };

    return handle;
}
