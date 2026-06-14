import {
    formatActionFileCount,
    formatActionProgress,
    formatActionState,
    formatActionStateIcon,
} from '../shared/action.js';
import { STORAGE_COPY_SOCKET_COMMAND } from '../shared/socket.js';
import { type StorageCopyItem } from '../shared/storage.js';
import { sendAppSocketCommand } from './app-socket.js';
import { formatSize } from '../shared/shared.js';

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
    if (action === STORAGE_COPY_SOCKET_COMMAND.cancel)
        cancelStorageCopy(itemId);
    else if (action === STORAGE_COPY_SOCKET_COMMAND.retry)
        retryStorageCopy(itemId);
    else if (action === STORAGE_COPY_SOCKET_COMMAND.clear)
        clearStorageCopy(itemId);
    else return false;
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
