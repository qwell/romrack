import {
    formatActionFileCount,
    formatActionProgress,
    formatActionState,
    formatActionStateIcon,
} from '../shared/action.js';
import {
    STORAGE_COPY_SOCKET_COMMAND,
    STORAGE_DELETE_SOCKET_COMMAND,
} from '../shared/socket.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
} from '../shared/storage.js';
import { sendAppSocketCommand } from './app-socket.js';
import { formatSize, formatTitleDisplay } from '../shared/utils.js';
import { type TitleEntry } from '../shared/titles.js';
import { queueStorageDelete } from './api.js';

export function syncStorageCopies(
    copies: StorageCopyItem[],
    nextCopies: StorageCopyItem[]
): string[] {
    const previousById = new Map(copies.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    copies.splice(0, copies.length, ...nextCopies);

    return copies
        .filter((item) => {
            const previous = previousById.get(item.id);
            return (
                item.state === 'complete' &&
                item.operation === 'move' &&
                item.titleId !== null &&
                ((previous && previous.state !== 'complete') ||
                    shouldReconcileCompleted)
            );
        })
        .map((item) => item.titleId as string);
}

export function formatStorageCopyProgress(item: StorageCopyItem): string {
    return formatActionProgress(item.state, item.progress);
}

export function formatStorageCopyFileCount(item: StorageCopyItem): string {
    return (
        formatActionFileCount(
            item.completedFiles,
            item.totalFiles,
            Boolean(item.currentFileName && item.state === 'in-progress')
        ) || (item.state === 'in-progress' ? '-' : '')
    );
}

export function formatStorageCopyTitle(item: StorageCopyItem): string {
    return item.sourceName;
}

export function formatStorageCopyState(item: StorageCopyItem): string {
    return formatActionState(item.state, {
        'in-progress': item.operation === 'move' ? 'Moving' : 'Copying',
        complete: item.operation === 'move' ? 'Moved' : 'Copied',
    });
}

export function formatStorageCopyIcon(item: StorageCopyItem): string {
    return formatActionStateIcon(
        item.state,
        item.operation === 'move' ? '→' : '⇄'
    );
}

export function formatStorageCopyDetails(item: StorageCopyItem): string {
    if (item.error) {
        return item.error;
    }

    if (!item.currentFileName) {
        return item.message ?? formatStorageCopyState(item);
    }

    return item.currentFileName;
}

export function getStorageCopyActionBarEntries(items: StorageCopyItem[]) {
    return items.map((item) => {
        const title = formatStorageCopyTitle(item);
        const terminal =
            item.state === 'complete' || item.state === 'cancelled';
        return {
            key: `storage-copy:${item.id}`,
            id: item.id,
            state: item.state,
            clearCommand: STORAGE_COPY_SOCKET_COMMAND.clear,
            cells: [
                {
                    className: 'action-bar-progress',
                    text: formatStorageCopyProgress(item),
                },
                {
                    className: 'action-bar-files',
                    text: formatStorageCopyFileCount(item),
                },
                {
                    className: 'action-bar-icon',
                    text: formatStorageCopyIcon(item),
                },
                {
                    className: 'action-bar-state',
                    text: formatStorageCopyState(item),
                },
                {
                    className: 'action-bar-size',
                    text: formatSize(item.currentSizeBytes),
                },
                { className: 'action-bar-title', text: title, title },
            ],
            details: {
                text:
                    item.state === 'in-progress'
                        ? formatStorageCopyDetails(item)
                        : undefined,
                title: item.error ?? item.destinationName,
                buttons:
                    item.state === 'failed'
                        ? [
                              {
                                  text: 'Retry',
                                  command: STORAGE_COPY_SOCKET_COMMAND.retry,
                              },
                              {
                                  text: 'Clear',
                                  command: STORAGE_COPY_SOCKET_COMMAND.clear,
                              },
                          ]
                        : [
                              {
                                  text: terminal ? 'Clear' : 'Cancel',
                                  command: terminal
                                      ? STORAGE_COPY_SOCKET_COMMAND.clear
                                      : STORAGE_COPY_SOCKET_COMMAND.cancel,
                              },
                          ],
            },
        };
    });
}

export function handleStorageCopyActionBarCommand(
    action: string,
    itemId: string
): boolean {
    const handlers: Record<string, (itemId: string) => void> = {
        [STORAGE_COPY_SOCKET_COMMAND.cancel]: cancelStorageCopy,
        [STORAGE_COPY_SOCKET_COMMAND.retry]: retryStorageCopy,
        [STORAGE_COPY_SOCKET_COMMAND.clear]: clearStorageCopy,
    };

    const handler = handlers[action];

    if (!handler) {
        return false;
    }

    handler(itemId);
    return true;
}

export function retryStorageCopy(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_COPY_SOCKET_COMMAND.retry,
        id: itemId,
    });
}

export function clearStorageCopy(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_COPY_SOCKET_COMMAND.clear,
        id: itemId,
    });
}

export function cancelStorageCopy(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_COPY_SOCKET_COMMAND.cancel,
        id: itemId,
    });
}

export function syncStorageDeletes(
    storageDeletes: StorageDeleteItem[],
    nextDeletes: StorageDeleteItem[]
): string[] {
    const previousById = new Map(storageDeletes.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    storageDeletes.splice(0, storageDeletes.length, ...nextDeletes);

    return storageDeletes
        .filter((item) => {
            const previous = previousById.get(item.id);
            return (
                item.state === 'complete' &&
                ((previous && previous.state !== 'complete') ||
                    shouldReconcileCompleted)
            );
        })
        .map((item) => item.titleId);
}

export async function confirmAndQueueStorageDeletes(
    titleIds: string[],
    entries: TitleEntry[],
    button: HTMLButtonElement,
    platform: TitleEntry['platform'],
    label = 'local'
): Promise<void> {
    const selected = new Set(titleIds);
    const selectedEntries = entries.filter((entry) =>
        selected.has(entry.titleId)
    );
    if (selectedEntries.length === 0) {
        return;
    }

    const names = selectedEntries
        .map((entry) =>
            formatTitleDisplay(
                entry.name,
                entry.titleId,
                entry.version,
                platform
            )
        )
        .join('\n');
    const confirmed = window.confirm(
        selectedEntries.length === 1
            ? `Delete this ${label} title?\n\n${names}`
            : `Delete these ${selectedEntries.length} ${label} titles?\n\n${names}`
    );
    if (!confirmed) {
        return;
    }

    button.disabled = true;
    try {
        await Promise.all(
            titleIds.map((titleId) => queueStorageDelete(titleId, platform))
        );
    } finally {
        button.disabled = false;
    }
}

export function formatStorageDeleteProgress(item: StorageDeleteItem): string {
    if (item.state === 'complete') {
        return 'Done';
    }

    if (item.state === 'cancelled') {
        return '-';
    }

    if (item.totalCount !== null && item.totalCount > 0) {
        return `${item.deletedCount}/${item.totalCount}`;
    }

    return '-';
}

export function formatStorageDeleteTitle(item: StorageDeleteItem): string {
    return item.titleName ?? item.titleId;
}

export function formatStorageDeleteState(item: StorageDeleteItem): string {
    return formatActionState(item.state, {
        'in-progress': 'Deleting',
        complete: 'Deleted',
    });
}

export function formatStorageDeleteIcon(item: StorageDeleteItem): string {
    return formatActionStateIcon(item.state, '⌫');
}

export function getStorageDeleteActionBarEntries(items: StorageDeleteItem[]) {
    return items.map((item) => {
        const terminal =
            item.state === 'complete' || item.state === 'cancelled';

        const title = formatStorageDeleteTitle(item);
        return {
            key: `storage-delete:${item.id}`,
            id: item.id,
            state: item.state,
            clearCommand: STORAGE_DELETE_SOCKET_COMMAND.clear,
            cells: [
                {
                    className: 'action-bar-progress',
                    text: formatStorageDeleteProgress(item),
                },
                { className: 'action-bar-files', text: '' },
                {
                    className: 'action-bar-icon',
                    text: formatStorageDeleteIcon(item),
                },
                {
                    className: 'action-bar-state',
                    text: formatStorageDeleteState(item),
                },
                { className: 'action-bar-size', text: '' },
                { className: 'action-bar-title', text: title, title },
            ],
            details: {
                title: item.error ?? '',
                buttons:
                    item.state === 'failed'
                        ? [
                              {
                                  text: 'Retry',
                                  command: STORAGE_DELETE_SOCKET_COMMAND.retry,
                              },
                              {
                                  text: 'Clear',
                                  command: STORAGE_DELETE_SOCKET_COMMAND.clear,
                              },
                          ]
                        : [
                              {
                                  text: terminal ? 'Clear' : 'Cancel',
                                  command: terminal
                                      ? STORAGE_DELETE_SOCKET_COMMAND.clear
                                      : STORAGE_DELETE_SOCKET_COMMAND.cancel,
                              },
                          ],
            },
        };
    });
}

export function handleStorageDeleteActionBarCommand(
    action: string,
    itemId: string
): boolean {
    const handlers: Record<string, (itemId: string) => void> = {
        [STORAGE_DELETE_SOCKET_COMMAND.cancel]: cancelStorageDelete,
        [STORAGE_DELETE_SOCKET_COMMAND.retry]: retryStorageDelete,
        [STORAGE_DELETE_SOCKET_COMMAND.clear]: clearStorageDelete,
    };

    const handler = handlers[action];

    if (!handler) {
        return false;
    }

    handler(itemId);
    return true;
}

export function retryStorageDelete(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_DELETE_SOCKET_COMMAND.retry,
        id: itemId,
    });
}

export function clearStorageDelete(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_DELETE_SOCKET_COMMAND.clear,
        id: itemId,
    });
}

export function cancelStorageDelete(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_DELETE_SOCKET_COMMAND.cancel,
        id: itemId,
    });
}
