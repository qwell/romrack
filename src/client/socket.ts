import { StorageCopyItem, StorageDeleteItem } from '../shared/storage.js';
import { DownloadQueueItem } from '../shared/download.js';
import { type AppSocketEvent } from '../shared/socket.js';
import { TitleGroup } from '../shared/titles.js';
import { syncDownloadQueue } from './download.js';
import {
    markStorageCopiesComplete,
    markStorageDeletesComplete,
} from './library-state.js';
import { syncStorageCopies, syncStorageDeletes } from './storage.js';

export function getSocketUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/api/socket`;
}

export type LibraryStatusSeverity = 'info' | 'success' | 'error';

type AppEventOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
    haystacks: WeakMap<TitleGroup, string>;
    getGroups: () => TitleGroup[];
    onServerAvailable: () => void;
    onGroupChanged: (group: TitleGroup) => void;
    onValidationStateChanged: (validating: boolean) => void;
    onLibraryStatusChanged: (
        message: string,
        severity: LibraryStatusSeverity
    ) => void;
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

                const severity =
                    event.status === 'complete' && event.failed === 0
                        ? 'success'
                        : event.status === 'failed' ||
                            (event.status === 'complete' && event.failed !== 0)
                          ? 'error'
                          : 'info';

                options.onLibraryStatusChanged(message, severity);
                return;
            }
        }
    };

    return handle;
}
