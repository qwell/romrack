import {
    type DownloadActionBarCommand,
    type DownloadQueueItem,
} from '../shared/download.js';
import {
    DOWNLOAD_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_COMMAND,
    LIBRARY_VALIDATE_SOCKET_COMMAND,
    STORAGE_COPY_SOCKET_COMMAND,
    DELETE_SOCKET_COMMAND,
    type LibraryConvertItem,
    type LibraryValidateStatusEvent,
} from '../shared/socket.js';
import { formatSize, formatTitleDisplay } from '../shared/shared.js';
import {
    type DeleteActionBarCommand,
    type DeleteItem,
} from '../shared/delete.js';
import {
    type StorageActionBarCommand,
    type StorageCopyItem,
} from '../shared/storage.js';
import {
    formatStorageCopyDetails,
    formatStorageCopyFileCount,
    formatStorageCopyIcon,
    formatStorageCopyProgress,
    formatStorageCopyState,
    formatStorageCopyTitle,
    renderStorageCopyActionRow,
    cancelStorageCopy,
    clearStorageCopy,
    retryStorageCopy,
} from './storage.js';
import {
    clearDelete,
    formatDeleteDetails,
    formatDeleteIcon,
    formatDeleteProgress,
    formatDeleteState,
    formatDeleteTitle,
    renderDeleteActionRow,
    retryDelete,
} from './delete.js';

import {
    cancelDownload,
    formatDownloadFileCount,
    formatDownloadIcon,
    formatDownloadProgress,
    formatDownloadState,
    formatDownloadTitle,
    getDownloadDedupeKey,
    clearDownload,
    queueDownloads,
    renderDownloadActionRow,
    retryDownload,
} from './download.js';
import { sendAppSocketCommand } from './app-socket.js';
import { LibraryActionBarCommand } from './library.js';

export const ACTION_BAR_COMMAND = {
    downloadQueue: DOWNLOAD_SOCKET_COMMAND.queue,
    downloadRetry: DOWNLOAD_SOCKET_COMMAND.retry,
    downloadClear: DOWNLOAD_SOCKET_COMMAND.clear,
    downloadCancel: DOWNLOAD_SOCKET_COMMAND.cancel,
    storageCopyRetry: STORAGE_COPY_SOCKET_COMMAND.retry,
    storageCopyCancel: STORAGE_COPY_SOCKET_COMMAND.cancel,
    storageCopyClear: STORAGE_COPY_SOCKET_COMMAND.clear,
    deleteRetry: DELETE_SOCKET_COMMAND.retry,
    deleteClear: DELETE_SOCKET_COMMAND.clear,
    libraryValidateCancel: LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
    libraryValidateClear: LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
    libraryValidateFailureClear: LIBRARY_VALIDATE_SOCKET_COMMAND.failureClear,
    libraryValidateFailureDownload:
        LIBRARY_VALIDATE_SOCKET_COMMAND.failureDownload,
    libraryConvertCancel: LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
    libraryConvertClear: LIBRARY_CONVERT_SOCKET_COMMAND.clear,
    libraryConvertRetry: LIBRARY_CONVERT_SOCKET_COMMAND.retry,
} as const;

export type ActionBarCommand =
    | DownloadActionBarCommand
    | StorageActionBarCommand
    | DeleteActionBarCommand
    | LibraryActionBarCommand;

type ActionBarOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    deletes: DeleteItem[];
    libraryValidate: LibraryValidateStatusEvent | null;
    libraryValidateFailures: LibraryValidateStatusEvent[];
    libraryConversions: LibraryConvertItem[];
    onCommand: (action: ActionBarCommand, itemId: string) => void;
};

type ActionCommandOptions = {
    downloads: DownloadQueueItem[];
};

let actionBarRoot: HTMLElement | null = null;
let actionBarSignature = '';
let actionBarOptions: ActionBarOptions | null = null;
let actionBarOrderCounter = 0;
const actionBarItemOrder = new Map<string, number>();

function isActionBarCommand<T extends ActionBarCommand>(
    command: string | null,
    type?: T | readonly T[] | Record<string, T>
): command is T {
    if (!type) {
        if (command === null) {
            return false;
        }
        return Object.values(ACTION_BAR_COMMAND).includes(
            command as ActionBarCommand
        );
    }
    if (typeof type === 'object' && !Array.isArray(type)) {
        return Object.values(type).includes(command as T);
    }
    if (Array.isArray(type)) {
        return type.includes(command);
    }
    return type === command;
}

function isClearableActionBarItem(options: ActionBarOptions): boolean {
    return (
        options.downloads.some((item) => item.state !== 'downloading') ||
        options.storageCopies.some((item) => item.state !== 'copying') ||
        options.deletes.some((item) => item.state !== 'deleting') ||
        options.libraryValidateFailures.length > 0 ||
        (options.libraryValidate !== null &&
            getLibraryValidateActionState(options.libraryValidate) !==
                'validating') ||
        options.libraryConversions.some((item) => item.state !== 'converting')
    );
}

function clearAllActionBarItems(options: ActionBarOptions): void {
    for (const item of options.downloads) {
        if (item.state !== 'downloading') {
            options.onCommand(DOWNLOAD_SOCKET_COMMAND.clear, item.id);
        }
    }

    for (const item of options.storageCopies) {
        if (item.state !== 'copying') {
            options.onCommand(STORAGE_COPY_SOCKET_COMMAND.clear, item.id);
        }
    }

    for (const item of options.deletes) {
        if (item.state !== 'deleting') {
            options.onCommand(DELETE_SOCKET_COMMAND.clear, item.id);
        }
    }

    if (
        options.libraryValidate !== null &&
        getLibraryValidateActionState(options.libraryValidate) !== 'validating'
    ) {
        setLibraryValidateAction(null);
    }

    for (const item of options.libraryConversions) {
        if (item.state !== 'converting') {
            sendAppSocketCommand({
                type: LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                id: item.id,
            });
        }
    }

    options.libraryValidateFailures.splice(
        0,
        options.libraryValidateFailures.length
    );
    updateActionBar();
}

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
            case DOWNLOAD_SOCKET_COMMAND.cancel:
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    cancelDownload
                );
                return;

            case DOWNLOAD_SOCKET_COMMAND.clear:
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    clearDownload
                );
                return;

            case DOWNLOAD_SOCKET_COMMAND.retry:
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    retryDownload
                );
                return;

            case STORAGE_COPY_SOCKET_COMMAND.cancel:
                cancelStorageCopy(itemId);
                return;

            case STORAGE_COPY_SOCKET_COMMAND.clear:
                clearStorageCopy(itemId);
                return;

            case STORAGE_COPY_SOCKET_COMMAND.retry:
                retryStorageCopy(itemId);
                return;

            case DELETE_SOCKET_COMMAND.clear:
                clearDelete(itemId);
                return;

            case DELETE_SOCKET_COMMAND.retry:
                retryDelete(itemId);
                return;

            case LIBRARY_VALIDATE_SOCKET_COMMAND.cancel:
                sendAppSocketCommand({
                    type: LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
                });
                return;

            case LIBRARY_VALIDATE_SOCKET_COMMAND.clear:
                setLibraryValidateAction(null);
                return;

            case LIBRARY_VALIDATE_SOCKET_COMMAND.failureClear:
                clearLibraryValidateFailure(itemId);
                return;

            case LIBRARY_VALIDATE_SOCKET_COMMAND.failureDownload:
                queueLibraryValidateFailureDownload(options.downloads, itemId);
                return;

            case LIBRARY_CONVERT_SOCKET_COMMAND.cancel:
                sendAppSocketCommand({
                    type: LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
                    id: itemId,
                });
                return;

            case LIBRARY_CONVERT_SOCKET_COMMAND.clear:
                sendAppSocketCommand({
                    type: LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                    id: itemId,
                });
                return;

            case LIBRARY_CONVERT_SOCKET_COMMAND.retry:
                sendAppSocketCommand({
                    type: LIBRARY_CONVERT_SOCKET_COMMAND.retry,
                    id: itemId,
                });
                return;
        }
    };
}

function getActionBarSignature(options: ActionBarOptions): string {
    const entries = getOrderedActionBarEntries(options);

    return JSON.stringify({
        entries: entries.map((entry) => ({
            key: entry.key,
            state: getActionBarEntryState(entry),
        })),
        libraryValidate: options.libraryValidate
            ? {
                  status: getLibraryValidateActionState(
                      options.libraryValidate
                  ),
                  failed: options.libraryValidate.failed ?? null,
                  total: options.libraryValidate.total ?? null,
                  error: options.libraryValidate.error ?? null,
              }
            : null,
        libraryValidateFailures: options.libraryValidateFailures.map(
            (item) => ({
                titleId: item.titleId ?? null,
                titleName: item.name ?? null,
                titleVersion: item.version ?? null,
                titleKind: item.kind ?? null,
            })
        ),
        libraryConversions: options.libraryConversions,
    });
}

type ActionBarEntry =
    | {
          key: string;
          type: 'download';
          item: DownloadQueueItem;
      }
    | {
          key: string;
          type: 'storageCopy';
          item: StorageCopyItem;
      }
    | {
          key: string;
          type: 'delete';
          item: DeleteItem;
      }
    | {
          key: string;
          type: 'libraryValidate';
          item: LibraryValidateStatusEvent;
      }
    | {
          key: string;
          type: 'libraryValidateFailure';
          item: LibraryValidateStatusEvent;
      }
    | {
          key: string;
          type: 'libraryConvert';
          item: LibraryConvertItem;
      };

function getActionBarEntryState(entry: ActionBarEntry): string {
    switch (entry.type) {
        case 'download':
        case 'storageCopy':
        case 'delete':
            return entry.item.state;
        case 'libraryValidate':
        case 'libraryValidateFailure':
            return getLibraryValidateActionState(entry.item);
        case 'libraryConvert':
            return getLibraryConvertActionState(entry.item);
    }
}

function trackActionBarEntry(key: string): void {
    if (actionBarItemOrder.has(key)) {
        return;
    }

    actionBarItemOrder.set(key, actionBarOrderCounter);
    actionBarOrderCounter += 1;
}

function getOrderedActionBarEntries(
    options: ActionBarOptions
): ActionBarEntry[] {
    const entries: ActionBarEntry[] = [
        ...options.downloads.map((item) => ({
            key: `download:${item.id}`,
            type: 'download' as const,
            item,
        })),
        ...options.storageCopies.map((item) => ({
            key: `storage-copy:${item.id}`,
            type: 'storageCopy' as const,
            item,
        })),
        ...options.deletes.map((item) => ({
            key: `delete:${item.id}`,
            type: 'delete' as const,
            item,
        })),
        ...(options.libraryValidate
            ? [
                  {
                      key: 'library-validate',
                      type: 'libraryValidate' as const,
                      item: options.libraryValidate,
                  },
              ]
            : []),
        ...options.libraryConversions.map((item) => ({
            key: `library-convert:${item.id}`,
            type: 'libraryConvert' as const,
            item,
        })),
        ...options.libraryValidateFailures.map((item) => ({
            key: `library-validate-failure:${getLibraryValidateFailureKey(item)}`,
            type: 'libraryValidateFailure' as const,
            item,
        })),
    ];

    const activeKeys = new Set(entries.map((entry) => entry.key));
    for (const key of actionBarItemOrder.keys()) {
        if (!activeKeys.has(key)) {
            actionBarItemOrder.delete(key);
        }
    }

    for (const entry of entries) {
        trackActionBarEntry(entry.key);
    }

    return entries.sort(
        (left, right) =>
            (actionBarItemOrder.get(left.key) ?? 0) -
            (actionBarItemOrder.get(right.key) ?? 0)
    );
}

export function setLibraryValidateAction(
    event: LibraryValidateStatusEvent | null
): void {
    if (!actionBarOptions) {
        return;
    }

    if (event?.status === 'started') {
        actionBarOptions.libraryValidateFailures.splice(
            0,
            actionBarOptions.libraryValidateFailures.length
        );
    }

    if (event?.status === 'validated' && event.result === 'failed') {
        addLibraryValidateFailure(event);
    }

    actionBarOptions.libraryValidate = event;
    updateActionBar();
}

export function syncLibraryConvertActions(items: LibraryConvertItem[]): void {
    if (!actionBarOptions) {
        return;
    }

    actionBarOptions.libraryConversions.splice(
        0,
        actionBarOptions.libraryConversions.length,
        ...items
    );
    updateActionBar();
}

function addLibraryValidateFailure(event: LibraryValidateStatusEvent): void {
    const key = getLibraryValidateFailureKey(event);
    const existingIndex = actionBarOptions?.libraryValidateFailures.findIndex(
        (item) => getLibraryValidateFailureKey(item) === key
    );
    if (existingIndex === undefined) {
        return;
    }

    if (existingIndex >= 0) {
        actionBarOptions?.libraryValidateFailures.splice(
            existingIndex,
            1,
            event
        );
        return;
    }

    actionBarOptions?.libraryValidateFailures.push(event);
}

function clearLibraryValidateFailure(itemId: string): void {
    if (!actionBarOptions) {
        return;
    }

    const nextFailures = actionBarOptions.libraryValidateFailures.filter(
        (item) => getLibraryValidateFailureKey(item) !== itemId
    );
    actionBarOptions.libraryValidateFailures.splice(
        0,
        actionBarOptions.libraryValidateFailures.length,
        ...nextFailures
    );
    updateActionBar();
}

function queueLibraryValidateFailureDownload(
    downloads: DownloadQueueItem[],
    itemId: string
): void {
    const item =
        actionBarOptions?.libraryValidateFailures.find(
            (candidate) => getLibraryValidateFailureKey(candidate) === itemId
        ) ?? null;

    if (!item?.titleId || !item.kind) {
        return;
    }

    const addedItems = queueDownloads(downloads, [
        {
            id: crypto.randomUUID(),
            family: item.titleId.toLowerCase().slice(8),
            groupName: item.name ?? item.titleId,
            kind: item.kind,
            label: item.kind,
            titleId: item.titleId,
            sizeText: null,
            totalBytes: null,
            state: 'queued',
            error: null,
            progress: 0,
            downloadedBytes: null,
            speedText: null,
            completedFiles: null,
            totalFiles: null,
            currentFileName: null,
            currentFileSizeBytes: null,
            installedSizeBytes: null,
            installedVersion: null,
            installedTitleName: null,
            installedSourcePath: null,
        },
    ]);
    if (addedItems.length > 0) {
        clearLibraryValidateFailure(itemId);
    }
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

        const progress = row.querySelector<HTMLElement>(
            '[data-download-progress]'
        );
        const files = row.querySelector<HTMLElement>('[data-download-files]');
        const icon = row.querySelector<HTMLElement>('[data-download-icon]');
        const state = row.querySelector<HTMLElement>('[data-download-state]');
        const size = row.querySelector<HTMLElement>('.action-bar-size');
        const title = row.querySelector<HTMLElement>('[data-download-title]');
        const detail = row.querySelector<HTMLElement>('[data-download-detail]');

        if (progress) {
            progress.textContent = formatDownloadProgress(item);
        }

        if (files) {
            files.textContent = formatDownloadFileCount(item);
        }

        if (icon) {
            icon.textContent = formatDownloadIcon(item.state) || '↓';
        }

        if (state) {
            state.textContent = formatDownloadState(item);
        }

        if (size) {
            size.textContent = formatSize(item.currentFileSizeBytes);
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
            size.textContent = formatSize(item.currentSizeBytes);
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

    for (const item of options.deletes) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[data-delete-item-id="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        row.className = `action-bar-row action-bar-row-${item.state}`;
        row.dataset.itemState = item.state;

        const progress = row.querySelector<HTMLElement>(
            '[data-delete-progress]'
        );
        const icon = row.querySelector<HTMLElement>('[data-delete-icon]');
        const state = row.querySelector<HTMLElement>('[data-delete-state]');
        const title = row.querySelector<HTMLElement>('[data-delete-title]');
        const detail = row.querySelector<HTMLElement>('[data-delete-detail]');

        if (progress) {
            progress.textContent = formatDeleteProgress(item);
        }

        if (icon) {
            icon.textContent = formatDeleteIcon(item);
        }

        if (state) {
            state.textContent = formatDeleteState(item);
        }

        if (title) {
            title.textContent = formatDeleteTitle(item);
            title.title = formatDeleteTitle(item);
        }

        if (detail) {
            const detailText = formatDeleteDetails(item);
            detail.textContent = detailText;
            detail.title = detailText;
        }
    }

    const validateRow = actionBarRoot.querySelector<HTMLElement>(
        '[data-library-validate]'
    );
    if (validateRow && options.libraryValidate) {
        const event = options.libraryValidate;
        const stateName = getLibraryValidateActionState(event);
        validateRow.className = `action-bar-row action-bar-row-validate action-bar-row-${stateName}`;
        validateRow.dataset.itemState = stateName;

        const progress = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-progress]'
        );
        const icon = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-icon]'
        );
        const state = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-state]'
        );
        const title = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-title]'
        );
        const detail = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-detail]'
        );

        if (progress) {
            progress.textContent = formatLibraryValidateProgress(event);
        }

        const files = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-files]'
        );
        const size = validateRow.querySelector<HTMLElement>(
            '[data-library-validate-size]'
        );

        if (files) {
            files.textContent = formatLibraryValidateFileCount(event);
        }

        if (icon) {
            icon.textContent = formatLibraryValidateIcon(event);
        }

        if (state) {
            state.textContent = formatLibraryValidateState(event);
        }

        if (title) {
            const titleText = formatLibraryValidateTitle(event);
            title.textContent = titleText;
            title.title = titleText;
        }

        if (size) {
            size.textContent = formatLibraryValidateSize(event);
        }

        if (detail) {
            const detailText = formatLibraryValidateDetails(event);
            detail.title = detailText;
            const detailTextElement = detail.querySelector<HTMLElement>(
                '[data-library-validate-detail-text]'
            );
            if (detailTextElement) {
                detailTextElement.textContent = detailText;
                detailTextElement.title = detailText;
            } else {
                detail.textContent = detailText;
            }
        }
    }
}

function formatLibraryValidateProgress(
    event: LibraryValidateStatusEvent
): string {
    if (event.status === 'complete') {
        return '100%';
    }

    if (event.status === 'failed') {
        return event.current !== undefined && event.total
            ? `${Math.round((event.current / event.total) * 100)}%`
            : '-';
    }

    if (event.current !== undefined && event.total) {
        return `${Math.round((event.current / event.total) * 100)}%`;
    }

    return '-';
}

function formatLibraryValidateFileCount(
    event: LibraryValidateStatusEvent
): string {
    if (event.current !== undefined && event.total !== undefined) {
        const current =
            event.status === 'validating'
                ? Math.min(event.current + 1, event.total)
                : event.current;
        return `${current}/${event.total} titles`;
    }

    return '';
}

function formatLibraryValidateIcon(event: LibraryValidateStatusEvent): string {
    const state = getLibraryValidateActionState(event);
    return state === 'complete' ? '✓' : state === 'failed' ? '!' : '⋯';
}

function formatLibraryValidateState(event: LibraryValidateStatusEvent): string {
    const state = getLibraryValidateActionState(event);
    return state === 'complete'
        ? 'Complete'
        : state === 'failed'
          ? 'Failed'
          : 'Validating';
}

function formatLibraryValidateTitle(event: LibraryValidateStatusEvent): string {
    if (
        (event.status === 'validating' || event.status === 'validated') &&
        event.kind &&
        event.titleId
    ) {
        return formatTitleDisplay(
            event.name ?? null,
            event.titleId,
            event.kind,
            event.version ?? null
        );
    }

    return 'Library validation';
}

function formatLibraryValidateSize(event: LibraryValidateStatusEvent): string {
    return event.status === 'validating' && event.sizeText
        ? event.sizeText
        : '';
}

function formatLibraryValidateDetails(
    event: LibraryValidateStatusEvent
): string {
    const state = getLibraryValidateActionState(event);
    if (state === 'validating') {
        return event.currentFileName
            ? event.currentFileName
            : 'Checking files...';
    }

    if (state === 'complete') {
        return `${event.total ?? 0} titles`;
    }

    if (event.status === 'complete') {
        return `${event.failed ?? 0}/${event.total ?? 0} failed`;
    }

    return 'Library validation cancelled.';
}

function getLibraryValidateFailureKey(
    event: LibraryValidateStatusEvent
): string {
    return event.titleId ?? event.name ?? 'unknown';
}

function renderLibraryValidateDetails(
    event: LibraryValidateStatusEvent
): HTMLElement {
    const detailsText = formatLibraryValidateDetails(event);
    const details = createActionBarCell('action-bar-details-cell', '');
    details.title = detailsText;
    details.dataset.libraryValidateDetail = 'true';

    if (getLibraryValidateActionState(event) === 'validating') {
        details.classList.add('action-bar-controls');

        const detailsTextElement = document.createElement('span');
        detailsTextElement.className = 'action-bar-control-text';
        detailsTextElement.title = detailsText;
        detailsTextElement.textContent = detailsText;
        detailsTextElement.dataset.libraryValidateDetailText = 'true';

        details.append(
            detailsTextElement,
            createActionButton(
                'Cancel',
                LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
                'library-validate'
            )
        );
        return details;
    }

    details.classList.add('action-bar-controls');

    const detailsTextElement = document.createElement('span');
    detailsTextElement.className = 'action-bar-control-text';
    detailsTextElement.title = detailsText;
    detailsTextElement.textContent = detailsText;

    details.append(
        detailsTextElement,
        createActionButton(
            'Clear',
            LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
            'library-validate'
        )
    );
    return details;
}

function renderLibraryValidateFailureDetails(
    event: LibraryValidateStatusEvent
): HTMLElement {
    const detailsText = event.error ?? 'Validation failed';
    const details = createActionBarCell('action-bar-details-cell', '');
    details.classList.add('action-bar-controls');
    details.title = detailsText;

    const detailsTextElement = document.createElement('span');
    detailsTextElement.className = 'action-bar-control-text';
    detailsTextElement.title = detailsText;
    detailsTextElement.textContent = detailsText;

    details.append(
        detailsTextElement,
        ...(event.titleId
            ? [createLibraryValidateFailureDownloadButton(event)]
            : []),
        createActionButton(
            'Clear',
            LIBRARY_VALIDATE_SOCKET_COMMAND.failureClear,
            getLibraryValidateFailureKey(event)
        )
    );
    return details;
}

function createLibraryValidateFailureDownloadButton(
    event: LibraryValidateStatusEvent
): HTMLButtonElement {
    const button = createActionButton(
        'Download',
        LIBRARY_VALIDATE_SOCKET_COMMAND.failureDownload,
        getLibraryValidateFailureKey(event)
    );
    button.disabled = isLibraryValidateFailureDownloadQueued(event);
    return button;
}

function isLibraryValidateFailureDownloadQueued(
    event: LibraryValidateStatusEvent
): boolean {
    if (!event.titleId || !event.kind) {
        return false;
    }

    const family = event.titleId.toLowerCase().slice(8);

    return (
        actionBarOptions?.downloads.some(
            (item) =>
                item.state !== 'complete' &&
                item.family === family &&
                item.kind === event.kind &&
                item.titleId.toLowerCase() === event.titleId?.toLowerCase()
        ) ?? false
    );
}

function renderLibraryValidateFailureRow(
    event: LibraryValidateStatusEvent
): HTMLElement {
    const progress = createActionBarCell('action-bar-progress', '-');
    const files = createActionBarCell('action-bar-files', '');
    const icon = createActionBarCell('action-bar-icon', '!');
    const state = createActionBarCell('action-bar-state', 'Failed');
    const size = createActionBarCell('action-bar-size', '');
    const titleText = formatLibraryValidateTitle(event);
    const title = createActionBarCell('action-bar-title', titleText);
    title.title = titleText;
    const details = renderLibraryValidateFailureDetails(event);

    return createActionBarRow({
        state: 'failed',
        cells: [progress, files, icon, state, size, title, details],
        className: 'action-bar-row-validate-failure',
        data: { libraryValidateFailure: 'true' },
    });
}

function getLibraryValidateActionState(
    event: LibraryValidateStatusEvent
): 'validating' | 'complete' | 'failed' {
    if (event.status === 'failed') {
        return 'failed';
    }

    if (event.status === 'complete') {
        return event.failed === 0 ? 'complete' : 'failed';
    }

    return 'validating';
}

function renderLibraryValidateActionRow(
    event: LibraryValidateStatusEvent
): HTMLElement {
    const stateName = getLibraryValidateActionState(event);

    const progress = createActionBarCell(
        'action-bar-progress',
        formatLibraryValidateProgress(event)
    );
    progress.dataset.libraryValidateProgress = 'true';

    const files = createActionBarCell(
        'action-bar-files',
        formatLibraryValidateFileCount(event)
    );
    files.dataset.libraryValidateFiles = 'true';

    const icon = createActionBarCell(
        'action-bar-icon',
        formatLibraryValidateIcon(event)
    );
    icon.dataset.libraryValidateIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatLibraryValidateState(event)
    );
    state.dataset.libraryValidateState = 'true';

    const size = createActionBarCell(
        'action-bar-size',
        formatLibraryValidateSize(event)
    );
    size.dataset.libraryValidateSize = 'true';

    const titleText = formatLibraryValidateTitle(event);
    const title = createActionBarCell('action-bar-title', titleText);
    title.title = titleText;
    title.dataset.libraryValidateTitle = 'true';

    const details = renderLibraryValidateDetails(event);

    return createActionBarRow({
        state: stateName,
        cells: [progress, files, icon, state, size, title, details],
        className: 'action-bar-row-validate',
        data: { libraryValidate: 'true' },
    });
}

function getLibraryConvertActionState(
    event: LibraryConvertItem
): LibraryConvertItem['state'] {
    return event.state;
}

function renderLibraryConvertActionRow(event: LibraryConvertItem): HTMLElement {
    const stateName = getLibraryConvertActionState(event);
    const progress =
        stateName === 'complete'
            ? 'Done'
            : event.current !== null && event.total
              ? `${Math.round((event.current / event.total) * 100)}%`
              : '-';
    const files =
        event.current !== null && event.total !== null
            ? `${event.current}/${event.total} files`
            : '';
    const state =
        stateName === 'queued'
            ? 'Queued'
            : stateName === 'converting'
              ? 'Converting'
              : stateName === 'complete'
                ? 'Complete'
                : 'Failed';
    const details =
        event.currentFileName ??
        event.error ??
        (event.state === 'complete'
            ? `${event.converted ?? 0} title(s) converted`
            : event.state === 'queued'
              ? 'Queued'
              : 'Reading WUD/WUX image...');
    const detailsCell = createActionBarCell('action-bar-details-cell', '');
    detailsCell.classList.add('action-bar-controls');
    detailsCell.append(createActionBarCell('action-bar-control-text', details));
    if (stateName === 'queued' || stateName === 'converting') {
        detailsCell.append(
            createActionButton(
                'Cancel',
                LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
                event.id
            )
        );
    } else if (stateName === 'failed') {
        detailsCell.append(
            createActionButton(
                'Retry',
                LIBRARY_CONVERT_SOCKET_COMMAND.retry,
                event.id
            ),
            createActionButton(
                'Clear',
                LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                event.id
            )
        );
    } else {
        detailsCell.append(
            createActionButton(
                'Clear',
                LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                event.id
            )
        );
    }
    const titleText = formatTitleDisplay(
        event.name,
        event.titleId,
        event.kind,
        event.version
    );
    const title = createActionBarCell('action-bar-title', titleText);
    title.title = titleText;

    return createActionBarRow({
        state: stateName,
        cells: [
            createActionBarCell('action-bar-progress', progress),
            createActionBarCell('action-bar-files', files),
            createActionBarCell(
                'action-bar-icon',
                stateName === 'complete'
                    ? '✓'
                    : stateName === 'failed'
                      ? '!'
                      : '⋯'
            ),
            createActionBarCell('action-bar-state', state),
            createActionBarCell(
                'action-bar-size',
                formatSize(event.currentFileSizeBytes)
            ),
            title,
            detailsCell,
        ],
        className: 'action-bar-row-convert',
    });
}

export function updateActionBar(): void {
    if (!actionBarRoot || !actionBarOptions) {
        return;
    }

    const isEmpty =
        actionBarOptions.downloads.length === 0 &&
        actionBarOptions.storageCopies.length === 0 &&
        actionBarOptions.deletes.length === 0 &&
        actionBarOptions.libraryValidate === null &&
        actionBarOptions.libraryConversions.length === 0 &&
        actionBarOptions.libraryValidateFailures.length === 0;
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

export function createActionBarRow({
    id,
    state,
    cells,
    itemIdDataKey,
    className,
    data,
}: {
    id?: string;
    state: string;
    cells: HTMLElement[];
    itemIdDataKey?: string;
    className?: string;
    data?: Record<string, string>;
}): HTMLDivElement {
    const row = document.createElement('div');
    row.className = ['action-bar-row', `action-bar-row-${state}`, className]
        .filter(Boolean)
        .join(' ');
    row.dataset.itemState = state;
    if (id) {
        row.dataset.itemId = id;
        if (itemIdDataKey) {
            row.dataset[itemIdDataKey] = id;
        }
    }
    Object.assign(row.dataset, data);
    row.append(...cells);
    return row;
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

    const validateState = options.libraryValidate
        ? getLibraryValidateActionState(options.libraryValidate)
        : null;
    const convertStates = options.libraryConversions.map(
        getLibraryConvertActionState
    );
    const activeCount =
        options.downloads.filter((item) => item.state === 'downloading')
            .length +
        options.storageCopies.filter((item) => item.state === 'copying')
            .length +
        options.deletes.filter((item) => item.state === 'deleting').length +
        (validateState === 'validating' ? 1 : 0) +
        convertStates.filter((state) => state === 'converting').length;
    const queuedCount =
        options.downloads.filter((item) => item.state === 'queued').length +
        options.storageCopies.filter((item) => item.state === 'queued').length +
        options.deletes.filter((item) => item.state === 'queued').length +
        convertStates.filter((state) => state === 'queued').length;
    const failedCount =
        options.downloads.filter((item) => item.state === 'failed').length +
        options.storageCopies.filter((item) => item.state === 'failed').length +
        options.deletes.filter((item) => item.state === 'failed').length +
        options.libraryValidateFailures.length +
        (validateState === 'failed' ? 1 : 0) +
        convertStates.filter((state) => state === 'failed').length;
    const finishedCount =
        options.downloads.filter((item) => item.state === 'complete').length +
        options.storageCopies.filter((item) => item.state === 'complete')
            .length +
        options.deletes.filter((item) => item.state === 'complete').length +
        (validateState === 'complete' ? 1 : 0) +
        convertStates.filter((state) => state === 'complete').length;

    actionBarRoot.replaceChildren();

    if (
        options.downloads.length === 0 &&
        options.storageCopies.length === 0 &&
        options.deletes.length === 0 &&
        options.libraryValidate === null &&
        options.libraryConversions.length === 0 &&
        options.libraryValidateFailures.length === 0
    ) {
        return;
    }

    const summary = document.createElement('div');
    summary.className = 'action-bar-summary';

    const counts = document.createElement('div');
    counts.textContent = `Actions: ${activeCount} active, ${queuedCount} queued, ${failedCount} failed, ${finishedCount} finished`;

    const controls = document.createElement('div');
    controls.className = 'action-bar-summary-controls';

    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'action-bar-button action-bar-clear-all-button';
    clearAll.textContent = 'Clear All';
    clearAll.dataset.actionBarClearAll = 'true';
    clearAll.disabled = !isClearableActionBarItem(options);

    controls.append(clearAll);
    summary.append(counts, controls);
    actionBarRoot.append(summary);

    const details = document.createElement('div');
    details.className = 'action-bar-details';

    for (const entry of getOrderedActionBarEntries(options)) {
        switch (entry.type) {
            case 'download':
                details.append(renderDownloadActionRow(entry.item));
                break;
            case 'storageCopy':
                details.append(renderStorageCopyActionRow(entry.item));
                break;
            case 'delete':
                details.append(renderDeleteActionRow(entry.item));
                break;
            case 'libraryValidate':
                details.append(renderLibraryValidateActionRow(entry.item));
                break;
            case 'libraryValidateFailure':
                details.append(renderLibraryValidateFailureRow(entry.item));
                break;
            case 'libraryConvert':
                details.append(renderLibraryConvertActionRow(entry.item));
                break;
        }
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

        const clearAllButton = target.closest(
            'button[data-action-bar-clear-all]'
        );

        if (
            clearAllButton instanceof HTMLButtonElement &&
            actionBarRoot?.contains(clearAllButton)
        ) {
            event.preventDefault();
            event.stopPropagation();

            if (!clearAllButton.disabled && actionBarOptions) {
                clearAllActionBarItems(actionBarOptions);
            }

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

        if (!itemId || !isActionBarCommand(actionValue)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        actionBarOptions?.onCommand(actionValue, itemId);
    });

    document.body.append(actionBarRoot);
    updateActionBar();
}
