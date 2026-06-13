import { formatSize } from '../shared/shared.js';
import { formatActionStateIcon } from '../shared/action.js';
import { STORAGE_COPY_SOCKET_COMMAND } from '../shared/socket.js';
import { type StorageCopyItem } from '../shared/storage.js';
import {
    createActionBarCell,
    createActionBarRow,
    createActionButton,
    updateActionBar,
} from './actionbar.js';
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
        return '-';
    }

    if (item.state === 'failed') {
        return item.progress !== null ? `${Math.round(item.progress)}%` : '-';
    }

    if (item.state === 'complete') {
        return 'Done';
    }

    if (item.state === 'cancelled') {
        return '-';
    }

    return item.progress !== null ? `${Math.round(item.progress)}%` : '-';
}

export function formatStorageCopyFileCount(item: StorageCopyItem): string {
    if (item.completedFiles !== null && item.totalFiles !== null) {
        const current =
            item.currentFileName && item.state === 'in-progress'
                ? Math.min(item.completedFiles + 1, item.totalFiles)
                : item.completedFiles;
        return `${current} / ${item.totalFiles} files`;
    }

    return item.state === 'in-progress' ? '-' : '';
}

export function formatStorageCopyTitle(item: StorageCopyItem): string {
    return item.sourceName;
}

export function formatStorageCopyState(item: StorageCopyItem): string {
    switch (item.state) {
        case 'in-progress':
            return item.operation === 'move' ? 'Moving' : 'Copying';
        case 'queued':
            return 'Queued';
        case 'failed':
            return 'Failed';
        case 'complete':
            return item.operation === 'move' ? 'Moved' : 'Copied';
        case 'cancelled':
            return 'Cancelled';
    }
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

export function renderStorageCopyActionRow(item: StorageCopyItem): HTMLElement {
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
        formatSize(item.currentSizeBytes)
    );
    size.dataset.storageCopySize = 'true';

    const title = createActionBarCell(
        'action-bar-title',
        formatStorageCopyTitle(item)
    );
    title.title = formatStorageCopyTitle(item);
    title.dataset.storageCopyTitle = 'true';

    const detailsCell = renderStorageCopyControls(item);

    return createActionBarRow({
        id: item.id,
        state: item.state,
        cells: [progress, files, icon, state, size, title, detailsCell],
        itemIdDataKey: 'storageCopyItemId',
    });
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
                'Cancel',
                STORAGE_COPY_SOCKET_COMMAND.cancel,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'complete' || item.state === 'cancelled') {
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

    if (item.state === 'in-progress') {
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
