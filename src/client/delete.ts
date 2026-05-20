import { type DeleteItem } from '../shared/delete.js';
import { requestJson, type DeleteQueuedResponse } from '../shared/api.js';
import { DELETE_SOCKET_COMMAND } from '../shared/socket.js';
import {
    createActionBarCell,
    createActionButton,
    updateActionBar,
} from './action-bar.js';
import { sendAppSocketCommand } from './app-socket.js';

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

    updateActionBar();
    return completedItems;
}

export function queueDelete(titleId: string): Promise<DeleteQueuedResponse> {
    const params = new URLSearchParams({ titleId });
    return requestJson(`/api/delete?${params}`);
}

export function formatDeleteProgress(item: DeleteItem): string {
    if (item.state === 'complete') {
        return 'Done';
    }

    if (item.totalCount !== null && item.totalCount > 0) {
        return `${item.deletedCount}/${item.totalCount}`;
    }

    return item.state === 'queued' ? '0' : '-';
}

export function formatDeleteTitle(item: DeleteItem): string {
    return item.titleName ?? item.titleId;
}

export function formatDeleteState(item: DeleteItem): string {
    switch (item.state) {
        case 'deleting':
            return 'Deleting';
        case 'queued':
            return 'Queued';
        case 'failed':
            return 'Failed';
        case 'complete':
            return 'Deleted';
    }
}

export function formatDeleteIcon(item: DeleteItem): string {
    switch (item.state) {
        case 'deleting':
            return '⌫';
        case 'queued':
            return '○';
        case 'complete':
            return '✓';
        case 'failed':
            return '!';
    }
}

export function formatDeleteDetails(item: DeleteItem): string {
    if (item.error) {
        return item.error;
    }

    return item.message ?? formatDeleteState(item);
}

export function renderDeleteActionRow(item: DeleteItem): HTMLElement {
    const row = document.createElement('div');
    row.className = `action-bar-row action-bar-row-${item.state}`;
    row.dataset.itemId = item.id;
    row.dataset.itemState = item.state;
    row.dataset.deleteItemId = item.id;
    row.dataset.state = item.state;

    const progress = createActionBarCell(
        'action-bar-progress',
        formatDeleteProgress(item)
    );
    progress.dataset.deleteProgress = 'true';

    const files = createActionBarCell('action-bar-files', '');
    files.dataset.deleteFiles = 'true';

    const icon = createActionBarCell('action-bar-icon', formatDeleteIcon(item));
    icon.dataset.deleteIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatDeleteState(item)
    );
    state.dataset.deleteState = 'true';

    const size = createActionBarCell('action-bar-size', '');
    size.dataset.deleteSize = 'true';

    const title = createActionBarCell(
        'action-bar-title',
        formatDeleteTitle(item)
    );
    title.title = formatDeleteTitle(item);
    title.dataset.deleteTitle = 'true';

    const detailsCell = renderDeleteControls(item);

    row.append(progress, files, icon, state, size, title, detailsCell);
    return row;
}

function renderDeleteControls(item: DeleteItem): HTMLDivElement {
    const detailsCell = document.createElement('div');
    detailsCell.className = 'action-bar-details-cell';

    if (item.state === 'failed') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.title = item.error ?? '';
        detailsCell.append(
            createActionButton('Retry', DELETE_SOCKET_COMMAND.retry, item.id),
            createActionButton('Clear', DELETE_SOCKET_COMMAND.clear, item.id)
        );
        return detailsCell;
    }

    if (item.state === 'queued' || item.state === 'complete') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton('Clear', DELETE_SOCKET_COMMAND.clear, item.id)
        );
        return detailsCell;
    }

    const detailsText = formatDeleteDetails(item);
    const detailsTextElement = document.createElement('span');
    detailsTextElement.className = 'action-bar-control-text';
    detailsTextElement.title = detailsText;
    detailsTextElement.textContent = detailsText;
    detailsTextElement.dataset.deleteDetail = 'true';
    detailsCell.append(detailsTextElement);
    return detailsCell;
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
