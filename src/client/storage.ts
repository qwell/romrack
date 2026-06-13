import { formatSize } from '../shared/shared.js';
import {
    formatActionFileCount,
    formatActionProgress,
    formatActionState,
    formatActionStateIcon,
} from '../shared/action.js';
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
