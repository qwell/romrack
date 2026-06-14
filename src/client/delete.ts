import { type DeleteItem } from '../shared/delete.js';
import { formatActionState, formatActionStateIcon } from '../shared/action.js';
import { requestJson, type DeleteQueuedResponse } from '../shared/api.js';
import { DELETE_SOCKET_COMMAND } from '../shared/socket.js';
import { sendAppSocketCommand } from './app-socket.js';
import { formatTitleDisplay } from '../shared/shared.js';
import { type TitleEntry } from '../shared/titles.js';

export function syncDeletes(
    deletes: DeleteItem[],
    nextDeletes: DeleteItem[]
): DeleteItem[] {
    const previousById = new Map(deletes.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    deletes.splice(0, deletes.length, ...nextDeletes);

    const completedItems = deletes.filter((item) => {
        const previous = previousById.get(item.id);
        return (
            item.state === 'complete' &&
            ((previous && previous.state !== 'complete') ||
                shouldReconcileCompleted)
        );
    });

    return completedItems;
}

export function getCompletedDeletedTitleIds(items: DeleteItem[]): string[] {
    return items
        .filter((item) => item.state === 'complete')
        .map((item) => item.titleId);
}

export function queueDelete(titleId: string): Promise<DeleteQueuedResponse> {
    const params = new URLSearchParams({ titleId });
    return requestJson(`/api/delete?${params}`);
}

export async function confirmAndQueueDeletes(
    titleIds: string[],
    entries: TitleEntry[],
    button: HTMLButtonElement,
    label = 'local'
): Promise<void> {
    const selected = new Set(titleIds);
    const selectedEntries = entries.filter((entry) =>
        selected.has(entry.titleId)
    );
    if (selectedEntries.length === 0) return;

    const names = selectedEntries
        .map((entry) =>
            formatTitleDisplay(
                entry.name,
                entry.titleId,
                entry.kind,
                entry.version
            )
        )
        .join('\n');
    const confirmed = window.confirm(
        selectedEntries.length === 1
            ? `Delete this ${label} title?\n\n${names}`
            : `Delete these ${selectedEntries.length} ${label} titles?\n\n${names}`
    );
    if (!confirmed) return;

    button.disabled = true;
    try {
        await Promise.all(titleIds.map(queueDelete));
    } finally {
        button.disabled = false;
    }
}

export function formatDeleteProgress(item: DeleteItem): string {
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

export function formatDeleteTitle(item: DeleteItem): string {
    return item.titleName ?? item.titleId;
}

export function formatDeleteState(item: DeleteItem): string {
    return formatActionState(item.state, {
        'in-progress': 'Deleting',
        complete: 'Deleted',
    });
}

export function formatDeleteIcon(item: DeleteItem): string {
    return formatActionStateIcon(item.state, '⌫');
}

export function formatDeleteDetails(item: DeleteItem): string {
    if (item.error) {
        return item.error;
    }

    return item.message ?? formatDeleteState(item);
}

export function getDeleteActionBarEntries(items: DeleteItem[]) {
    return items.map((item) => {
        const terminal =
            item.state === 'complete' || item.state === 'cancelled';

        const title = formatDeleteTitle(item);
        return {
            key: `delete:${item.id}`,
            id: item.id,
            state: item.state,
            clearCommand: DELETE_SOCKET_COMMAND.clear,
            cells: [
                {
                    className: 'action-bar-progress',
                    text: formatDeleteProgress(item),
                },
                { className: 'action-bar-files', text: '' },
                { className: 'action-bar-icon', text: formatDeleteIcon(item) },
                {
                    className: 'action-bar-state',
                    text: formatDeleteState(item),
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
                                  command: DELETE_SOCKET_COMMAND.retry,
                              },
                              {
                                  text: 'Clear',
                                  command: DELETE_SOCKET_COMMAND.clear,
                              },
                          ]
                        : [
                              {
                                  text: terminal ? 'Clear' : 'Cancel',
                                  command: terminal
                                      ? DELETE_SOCKET_COMMAND.clear
                                      : DELETE_SOCKET_COMMAND.cancel,
                              },
                          ],
            },
        };
    });
}

export function handleDeleteActionBarCommand(
    action: string,
    itemId: string
): boolean {
    if (action === DELETE_SOCKET_COMMAND.cancel) cancelDelete(itemId);
    else if (action === DELETE_SOCKET_COMMAND.retry) retryDelete(itemId);
    else if (action === DELETE_SOCKET_COMMAND.clear) clearDelete(itemId);
    else return false;
    return true;
}

export function retryDelete(itemId: string): void {
    sendAppSocketCommand({
        type: DELETE_SOCKET_COMMAND.retry,
        id: itemId,
    });
}

export function clearDelete(itemId: string): void {
    sendAppSocketCommand({
        type: DELETE_SOCKET_COMMAND.clear,
        id: itemId,
    });
}

export function cancelDelete(itemId: string): void {
    sendAppSocketCommand({
        type: DELETE_SOCKET_COMMAND.cancel,
        id: itemId,
    });
}
