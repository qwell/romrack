import { formatSize } from '../shared/shared.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
    STORAGE_ACTION,
} from '../shared/storage.js';
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

export function syncStorageDeletes(
    deletes: StorageDeleteItem[],
    nextDeletes: StorageDeleteItem[]
): StorageDeleteItem[] {
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
            createActionButton('Retry', STORAGE_ACTION.retryCopy, item.id),
            createActionButton('Clear', STORAGE_ACTION.clearCopy, item.id)
        );
        return detailsCell;
    }

    if (item.state === 'queued') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton('Clear', STORAGE_ACTION.clearCopy, item.id)
        );
        return detailsCell;
    }

    if (item.state === 'complete') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton('Clear', STORAGE_ACTION.clearCopy, item.id)
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
            createActionButton('Cancel', STORAGE_ACTION.cancelCopy, item.id)
        );
        return detailsCell;
    }

    detailsCell.textContent = formatStorageCopyDetails(item);
    return detailsCell;
}

export function retryStorageCopy(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_ACTION.retryCopy,
        id: itemId,
    });
}

export function clearStorageCopy(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_ACTION.clearCopy,
        id: itemId,
    });
}

export function cancelStorageCopy(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_ACTION.cancelCopy,
        id: itemId,
    });
}

export function formatStorageDeleteProgress(item: StorageDeleteItem): string {
    if (item.state === 'complete') {
        return 'Done';
    }

    if (item.totalCount !== null && item.totalCount > 0) {
        return `${item.deletedCount}/${item.totalCount}`;
    }

    return item.state === 'queued' ? '0' : '-';
}

export function formatStorageDeleteTitle(item: StorageDeleteItem): string {
    return item.titleName ?? item.titleId;
}

export function formatStorageDeleteState(item: StorageDeleteItem): string {
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

export function formatStorageDeleteIcon(item: StorageDeleteItem): string {
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

export function formatStorageDeleteDetails(item: StorageDeleteItem): string {
    if (item.error) {
        return item.error;
    }

    return item.message ?? formatStorageDeleteState(item);
}

export function renderStorageDeleteActionRow(
    item: StorageDeleteItem
): HTMLElement {
    const row = document.createElement('div');
    row.className = `action-bar-row action-bar-row-${item.state}`;
    row.dataset.itemId = item.id;
    row.dataset.itemState = item.state;
    row.dataset.storageDeleteItemId = item.id;
    row.dataset.state = item.state;

    const progress = createActionBarCell(
        'action-bar-progress',
        formatStorageDeleteProgress(item)
    );
    progress.dataset.storageDeleteProgress = 'true';

    const files = createActionBarCell('action-bar-files', '');
    files.dataset.storageDeleteFiles = 'true';

    const icon = createActionBarCell(
        'action-bar-icon',
        formatStorageDeleteIcon(item)
    );
    icon.dataset.storageDeleteIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatStorageDeleteState(item)
    );
    state.dataset.storageDeleteState = 'true';

    const size = createActionBarCell('action-bar-size', '');
    size.dataset.storageDeleteSize = 'true';

    const title = createActionBarCell(
        'action-bar-title',
        formatStorageDeleteTitle(item)
    );
    title.title = formatStorageDeleteTitle(item);
    title.dataset.storageDeleteTitle = 'true';

    const detailsCell = renderStorageDeleteControls(item);

    row.append(progress, files, icon, state, size, title, detailsCell);
    return row;
}

function renderStorageDeleteControls(item: StorageDeleteItem): HTMLDivElement {
    const detailsCell = document.createElement('div');
    detailsCell.className = 'action-bar-details-cell';

    if (item.state === 'failed') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.title = item.error ?? '';
        detailsCell.append(
            createActionButton('Retry', STORAGE_ACTION.retryDelete, item.id),
            createActionButton('Clear', STORAGE_ACTION.clearDelete, item.id)
        );
        return detailsCell;
    }

    if (item.state === 'queued' || item.state === 'complete') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton('Clear', STORAGE_ACTION.clearDelete, item.id)
        );
        return detailsCell;
    }

    const detailsText = formatStorageDeleteDetails(item);
    const detailsTextElement = document.createElement('span');
    detailsTextElement.className = 'action-bar-control-text';
    detailsTextElement.title = detailsText;
    detailsTextElement.textContent = detailsText;
    detailsTextElement.dataset.storageDeleteDetail = 'true';
    detailsCell.append(detailsTextElement);
    return detailsCell;
}

export function retryStorageDelete(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_ACTION.retryDelete,
        id: itemId,
    });
}

export function clearStorageDelete(itemId: string): void {
    sendAppSocketCommand({
        type: STORAGE_ACTION.clearDelete,
        id: itemId,
    });
}
