import { type DownloadQueueItem } from '../shared/shared.js';
import {
    cancelStorageCopy,
    removeStorageCopy,
    removeStorageDelete,
    retryStorageCopy,
    retryStorageDelete,
} from './storage.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
} from '../shared/shared.js';
import {
    cancelDownload,
    type DownloadActionBarCommand,
    formatDownloadIcon,
    formatDownloadProgress,
    formatDownloadState,
    formatDownloadTitle,
    getDownloadDedupeKey,
    removeDownload,
    renderDownloadActionRow,
    retryDownload,
} from './download.js';
import {
    type StorageActionBarCommand,
    formatStorageCopyDetails,
    formatStorageCopyFileCount,
    formatStorageCopyIcon,
    formatStorageCopyProgress,
    formatStorageCopySize,
    formatStorageCopyState,
    formatStorageCopyTitle,
    formatStorageDeleteDetails,
    formatStorageDeleteIcon,
    formatStorageDeleteProgress,
    formatStorageDeleteState,
    formatStorageDeleteTitle,
    renderStorageCopyActionRow,
    renderStorageDeleteActionRow,
} from './storage.js';

export type ActionBarCommand =
    | DownloadActionBarCommand
    | StorageActionBarCommand;

type ActionBarOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
    onCommand: (action: ActionBarCommand, itemId: string) => void;
};

type ActionCommandOptions = {
    downloads: DownloadQueueItem[];
};

let actionBarRoot: HTMLElement | null = null;
let actionBarSignature = '';
let actionBarOptions: ActionBarOptions | null = null;

function configureActionButton(
    button: HTMLButtonElement,
    action: ActionBarCommand,
    itemId: string
): void {
    button.dataset.action = action;
    button.dataset.itemId = itemId;
}

function getMatchingDownloadIds(
    itemId: string,
    downloads: DownloadQueueItem[]
): string[] {
    const item = downloads.find((candidate) => candidate.id === itemId);

    if (!item) {
        return [itemId];
    }

    const key = getDownloadDedupeKey(item);

    const ids = downloads
        .filter(
            (candidate) =>
                candidate.state !== 'complete' &&
                getDownloadDedupeKey(candidate) === key
        )
        .map((candidate) => candidate.id);

    return ids.length > 0 ? ids : [itemId];
}

function sendDownloadCommandForMatches(
    itemId: string,
    downloads: DownloadQueueItem[],
    send: (id: string) => void
): void {
    for (const id of getMatchingDownloadIds(itemId, downloads)) {
        send(id);
    }
}

export function createActionBarCommandHandler(
    options: ActionCommandOptions
): (action: ActionBarCommand, itemId: string) => void {
    return (action, itemId) => {
        switch (action) {
            case 'download.cancel':
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    cancelDownload
                );
                return;

            case 'download.remove':
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    removeDownload
                );
                return;

            case 'download.retry':
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    retryDownload
                );
                return;

            case 'storage.copy.cancel':
                cancelStorageCopy(itemId);
                return;

            case 'storage.copy.remove':
                removeStorageCopy(itemId);
                return;

            case 'storage.copy.retry':
                retryStorageCopy(itemId);
                return;

            case 'storage.delete.remove':
                removeStorageDelete(itemId);
                return;

            case 'storage.delete.retry':
                retryStorageDelete(itemId);
                return;
        }
    };
}

function isActionBarCommand(value: string | null): value is ActionBarCommand {
    switch (value) {
        case 'download.cancel':
        case 'download.remove':
        case 'download.retry':
        case 'storage.copy.cancel':
        case 'storage.copy.remove':
        case 'storage.copy.retry':
        case 'storage.delete.remove':
        case 'storage.delete.retry':
            return true;
        default:
            return false;
    }
}

function getActionBarSignature(options: ActionBarOptions): string {
    return JSON.stringify({
        downloads: options.downloads.map((item) => ({
            id: item.id,
            state: item.state,
        })),
        copies: options.storageCopies.map((item) => ({
            id: item.id,
            state: item.state,
        })),
        deletes: options.storageDeletes.map((item) => ({
            id: item.id,
            state: item.state,
        })),
    });
}

function updateActionBarRowsInPlace(options: ActionBarOptions): void {
    if (!actionBarRoot) {
        return;
    }

    for (const item of options.downloads) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[data-download-item-id="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        row.className = `action-bar-row action-bar-row-${item.state}`;
        row.dataset.itemState = item.state;
        row.dataset.state = item.state;

        const progress = row.querySelector<HTMLElement>(
            '[data-download-progress]'
        );
        const files = row.querySelector<HTMLElement>('[data-download-files]');
        const icon = row.querySelector<HTMLElement>('[data-download-icon]');
        const state = row.querySelector<HTMLElement>('[data-download-state]');
        const title = row.querySelector<HTMLElement>('[data-download-title]');
        const detail = row.querySelector<HTMLElement>('[data-download-detail]');

        if (progress) {
            progress.textContent = formatDownloadProgress(item);
        }

        if (files) {
            files.textContent =
                item.completedFiles !== null && item.totalFiles !== null
                    ? `${item.completedFiles}/${item.totalFiles} files`
                    : '';
        }

        if (icon) {
            icon.textContent = formatDownloadIcon(item.state) || '↓';
        }

        if (state) {
            state.textContent = formatDownloadState(item);
        }

        if (title) {
            const downloadTitle = formatDownloadTitle(item);
            title.textContent = downloadTitle;
            title.title = downloadTitle;
        }

        if (detail) {
            const detailText =
                item.error ?? item.currentFileName ?? item.speedText ?? '';
            detail.textContent = detailText;
            detail.title = detailText;
        }
    }

    for (const item of options.storageCopies) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[data-storage-copy-item-id="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        row.className = `action-bar-row action-bar-row-${item.state}`;
        row.dataset.itemState = item.state;
        row.dataset.state = item.state;

        const progress = row.querySelector<HTMLElement>(
            '[data-storage-copy-progress]'
        );
        const files = row.querySelector<HTMLElement>(
            '[data-storage-copy-files]'
        );
        const icon = row.querySelector<HTMLElement>('[data-storage-copy-icon]');
        const state = row.querySelector<HTMLElement>(
            '[data-storage-copy-state]'
        );
        const size = row.querySelector<HTMLElement>('[data-storage-copy-size]');
        const title = row.querySelector<HTMLElement>(
            '[data-storage-copy-title]'
        );
        const detail = row.querySelector<HTMLElement>(
            '[data-storage-copy-detail]'
        );

        if (progress) {
            progress.textContent = formatStorageCopyProgress(item);
        }

        if (files) {
            files.textContent = formatStorageCopyFileCount(item);
        }

        if (icon) {
            icon.textContent = formatStorageCopyIcon(item);
        }

        if (state) {
            state.textContent = formatStorageCopyState(item);
        }

        if (size) {
            size.textContent = formatStorageCopySize(item);
        }

        if (title) {
            title.textContent = formatStorageCopyTitle(item);
            title.title = formatStorageCopyTitle(item);
        }

        if (detail) {
            const detailText = formatStorageCopyDetails(item);
            detail.textContent = detailText;
            detail.title = detailText;
        }
    }

    for (const item of options.storageDeletes) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[data-storage-delete-item-id="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        row.className = `action-bar-row action-bar-row-${item.state}`;
        row.dataset.itemState = item.state;
        row.dataset.state = item.state;

        const progress = row.querySelector<HTMLElement>(
            '[data-storage-delete-progress]'
        );
        const icon = row.querySelector<HTMLElement>(
            '[data-storage-delete-icon]'
        );
        const state = row.querySelector<HTMLElement>(
            '[data-storage-delete-state]'
        );
        const title = row.querySelector<HTMLElement>(
            '[data-storage-delete-title]'
        );
        const detail = row.querySelector<HTMLElement>(
            '[data-storage-delete-detail]'
        );

        if (progress) {
            progress.textContent = formatStorageDeleteProgress(item);
        }

        if (icon) {
            icon.textContent = formatStorageDeleteIcon(item);
        }

        if (state) {
            state.textContent = formatStorageDeleteState(item);
        }

        if (title) {
            title.textContent = formatStorageDeleteTitle(item);
            title.title = formatStorageDeleteTitle(item);
        }

        if (detail) {
            const detailText = formatStorageDeleteDetails(item);
            detail.textContent = detailText;
            detail.title = detailText;
        }
    }
}

export function updateActionBar(): void {
    if (!actionBarRoot || !actionBarOptions) {
        return;
    }

    const isEmpty =
        actionBarOptions.downloads.length === 0 &&
        actionBarOptions.storageCopies.length === 0 &&
        actionBarOptions.storageDeletes.length === 0;
    actionBarRoot.hidden = isEmpty;

    if (isEmpty) {
        if (actionBarSignature !== '') {
            actionBarSignature = '';
            actionBarRoot.replaceChildren();
        }

        return;
    }

    const nextSignature = getActionBarSignature(actionBarOptions);

    if (nextSignature === actionBarSignature) {
        updateActionBarRowsInPlace(actionBarOptions);

        return;
    }

    actionBarSignature = nextSignature;
    rebuildActionBar(actionBarOptions);
}

export function createActionBarCell(
    className: string,
    textContent = ''
): HTMLDivElement {
    const cell = document.createElement('div');
    cell.className = className;
    cell.textContent = textContent;
    return cell;
}

export function createActionButton(
    text: string,
    action: ActionBarCommand,
    itemId: string
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-bar-button';
    button.textContent = text;
    configureActionButton(button, action, itemId);
    return button;
}

function rebuildActionBar(options: ActionBarOptions): void {
    if (!actionBarRoot) {
        return;
    }

    const activeCount =
        options.downloads.filter((item) => item.state === 'downloading')
            .length +
        options.storageCopies.filter((item) => item.state === 'copying')
            .length +
        options.storageDeletes.filter((item) => item.state === 'deleting')
            .length;
    const queuedCount =
        options.downloads.filter((item) => item.state === 'queued').length +
        options.storageCopies.filter((item) => item.state === 'queued').length +
        options.storageDeletes.filter((item) => item.state === 'queued').length;
    const failedCount =
        options.downloads.filter((item) => item.state === 'failed').length +
        options.storageCopies.filter((item) => item.state === 'failed').length +
        options.storageDeletes.filter((item) => item.state === 'failed').length;
    const finishedCount =
        options.downloads.filter((item) => item.state === 'complete').length +
        options.storageCopies.filter((item) => item.state === 'complete')
            .length +
        options.storageDeletes.filter((item) => item.state === 'complete')
            .length;

    actionBarRoot.replaceChildren();

    if (
        options.downloads.length === 0 &&
        options.storageCopies.length === 0 &&
        options.storageDeletes.length === 0
    ) {
        return;
    }

    const summary = document.createElement('div');
    summary.className = 'action-bar-summary';

    const counts = document.createElement('div');
    counts.textContent = `Actions: ${activeCount} active, ${queuedCount} queued, ${failedCount} failed, ${finishedCount} finished`;

    const current = document.createElement('div');
    current.className = 'action-bar-current';
    const visibleActionCount =
        options.downloads.length +
        options.storageCopies.length +
        options.storageDeletes.length;
    current.textContent =
        visibleActionCount === 1
            ? 'One visible action'
            : `${visibleActionCount} visible actions`;

    const size = document.createElement('div');
    size.textContent = '';

    summary.append(counts, current, size);
    actionBarRoot.append(summary);

    const details = document.createElement('div');
    details.className = 'action-bar-details';

    for (const item of options.downloads) {
        details.append(renderDownloadActionRow(item));
    }

    for (const item of options.storageCopies) {
        details.append(renderStorageCopyActionRow(item));
    }

    for (const item of options.storageDeletes) {
        details.append(renderStorageDeleteActionRow(item));
    }

    actionBarRoot.append(details);
}

function buildActionBar(): HTMLElement {
    const strip = document.createElement('section');
    strip.className = 'action-bar';
    strip.hidden = true;
    strip.setAttribute('aria-label', 'Action bar');
    return strip;
}

export function mountActionBar(options: ActionBarOptions): void {
    actionBarOptions = options;

    if (actionBarRoot) {
        updateActionBar();
        return;
    }

    actionBarRoot = buildActionBar();

    actionBarRoot.addEventListener('click', (event) => {
        const target = event.target;

        if (!(target instanceof Element)) {
            return;
        }

        const closestButton = target.closest(
            'button[data-action][data-item-id]'
        );

        if (
            !(closestButton instanceof HTMLButtonElement) ||
            !actionBarRoot?.contains(closestButton)
        ) {
            return;
        }

        const actionValue = closestButton.getAttribute('data-action');
        const itemId = closestButton.getAttribute('data-item-id');

        if (!isActionBarCommand(actionValue) || !itemId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        actionBarOptions?.onCommand(actionValue, itemId);
    });

    document.body.append(actionBarRoot);
    updateActionBar();
}
