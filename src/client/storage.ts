import { formatSize } from '../shared/shared.js';
import { STORAGE_COPY_SOCKET_COMMAND } from '../shared/socket.js';
import { type StorageCopyItem } from '../shared/storage.js';
import {
    createActionBarCell,
    createActionButton,
    updateActionBar,
} from './action-bar.js';
import { sendAppSocketCommand } from './app-socket.js';

export function syncStorageCopies(
    copies: StorageCopyItem[],
    nextCopies: StorageCopyItem[]
): StorageCopyItem[] {
    const previousById = new Map(copies.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    copies.splice(0, copies.length, ...nextCopies);

    const completedItems = copies.filter((item) => {
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

export function formatStorageCopyProgress(item: StorageCopyItem): string {
    if (item.state === 'queued') {
        return '0%';
    }

    if (item.state === 'failed') {
        return item.progress !== null ? `${Math.round(item.progress)}%` : '0%';
    }

    if (item.state === 'complete') {
        return 'Done';
    }

    return item.progress !== null ? `${Math.round(item.progress)}%` : '0%';
}

export function formatStorageCopyFileCount(item: StorageCopyItem): string {
    if (item.completedFiles !== null && item.totalFiles !== null) {
        return `${item.completedFiles}/${item.totalFiles} files`;
    }

    return item.state === 'copying' ? '-' : '';
}

export function formatStorageCopySize(item: StorageCopyItem): string {
    return item.sourceSizeBytes !== null
        ? formatSize(item.sourceSizeBytes)
        : '-';
}

export function formatStorageCopyTitle(item: StorageCopyItem): string {
    return item.sourceName;
}

export function formatStorageCopyState(item: StorageCopyItem): string {
    switch (item.state) {
        case 'copying':
            return item.operation === 'move' ? 'Moving' : 'Copying';
        case 'queued':
            return 'Queued';
        case 'failed':
            return 'Failed';
        case 'complete':
            return item.operation === 'move' ? 'Moved' : 'Copied';
    }
}

export function formatStorageCopyIcon(item: StorageCopyItem): string {
    switch (item.state) {
        case 'copying':
            return item.operation === 'move' ? '→' : '⇄';
        case 'queued':
            return '○';
        case 'complete':
            return '✓';
        case 'failed':
            return '!';
        default:
            return '';
    }
}

export function formatStorageCopyDetails(item: StorageCopyItem): string {
    if (item.error) {
        return item.error;
    }

    if (!item.currentFileName) {
        return item.message ?? formatStorageCopyState(item);
    }

    return item.currentSizeBytes !== null
        ? `${item.currentFileName} (${formatSize(item.currentSizeBytes)})`
        : item.currentFileName;
}

export function renderStorageCopyActionRow(item: StorageCopyItem): HTMLElement {
    const row = document.createElement('div');
    row.className = `action-bar-row action-bar-row-${item.state}`;
    row.dataset.itemId = item.id;
    row.dataset.itemState = item.state;
    row.dataset.storageCopyItemId = item.id;
    row.dataset.state = item.state;

    const progress = createActionBarCell(
        'action-bar-progress',
        formatStorageCopyProgress(item)
    );
    progress.dataset.storageCopyProgress = 'true';

    const files = createActionBarCell(
        'action-bar-files',
        formatStorageCopyFileCount(item)
    );
    files.dataset.storageCopyFiles = 'true';

    const icon = createActionBarCell(
        'action-bar-icon',
        formatStorageCopyIcon(item)
    );
    icon.dataset.storageCopyIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatStorageCopyState(item)
    );
    state.dataset.storageCopyState = 'true';

    const size = createActionBarCell(
        'action-bar-size',
        formatStorageCopySize(item)
    );
    size.dataset.storageCopySize = 'true';

    const title = createActionBarCell(
        'action-bar-title',
        formatStorageCopyTitle(item)
    );
    title.title = formatStorageCopyTitle(item);
    title.dataset.storageCopyTitle = 'true';

    const detailsCell = renderStorageCopyControls(item);

    row.append(progress, files, icon, state, size, title, detailsCell);
    return row;
}

function renderStorageCopyControls(item: StorageCopyItem): HTMLDivElement {
    const detailsCell = document.createElement('div');
    detailsCell.className = 'action-bar-details-cell';
    detailsCell.title = item.destinationName;

    if (item.state === 'failed') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.title = item.error ?? '';
        detailsCell.append(
            createActionButton(
                'Retry',
                STORAGE_COPY_SOCKET_COMMAND.retry,
                item.id
            ),
            createActionButton(
                'Clear',
                STORAGE_COPY_SOCKET_COMMAND.clear,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'queued') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton(
                'Clear',
                STORAGE_COPY_SOCKET_COMMAND.clear,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'complete') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton(
                'Clear',
                STORAGE_COPY_SOCKET_COMMAND.clear,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'copying') {
        detailsCell.classList.add('action-bar-controls');

        const detailsText = formatStorageCopyDetails(item);
        const detailsTextElement = document.createElement('span');
        detailsTextElement.className = 'action-bar-control-text';
        detailsTextElement.title = detailsText;
        detailsTextElement.textContent = detailsText;
        detailsTextElement.dataset.storageCopyDetail = 'true';

        detailsCell.append(
            detailsTextElement,
            createActionButton(
                'Cancel',
                STORAGE_COPY_SOCKET_COMMAND.cancel,
                item.id
            )
        );
        return detailsCell;
    }

    detailsCell.textContent = formatStorageCopyDetails(item);
    return detailsCell;
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
