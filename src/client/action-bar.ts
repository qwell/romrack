import {
    type DownloadActionBarCommand,
    type DownloadQueueItem,
} from '../shared/download.js';
import {
    DOWNLOAD_SOCKET_COMMAND,
    LIBRARY_VALIDATE_SOCKET_COMMAND,
    STORAGE_COPY_SOCKET_COMMAND,
    DELETE_SOCKET_COMMAND,
    type LibraryValidateStatusEvent,
} from '../shared/socket.js';
import { type TitleKinds } from '../shared/titles.js';
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
    formatStorageCopySize,
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
import { formatTitleKind } from './title-detail.js';
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
    onCommand: (action: ActionBarCommand, itemId: string) => void;
};

type ActionCommandOptions = {
    downloads: DownloadQueueItem[];
};

let actionBarRoot: HTMLElement | null = null;
let actionBarSignature = '';
let actionBarOptions: ActionBarOptions | null = null;

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
                'validating')
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
        }
    };
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
        deletes: options.deletes.map((item) => ({
            id: item.id,
            state: item.state,
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
                titleKind: item.kind ?? null,
            })
        ),
    });
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

    queueDownloads(downloads, [
        {
            id: crypto.randomUUID(),
            family: item.titleId.toLowerCase().slice(8),
            groupName: item.name ?? item.titleId,
            kind: item.kind as TitleKinds,
            label: formatTitleKind(item.kind),
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
            installedSizeBytes: null,
            installedVersion: null,
            installedTitleName: null,
            installedSourcePath: null,
        },
    ]);
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

    for (const item of options.deletes) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[data-delete-item-id="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        row.className = `action-bar-row action-bar-row-${item.state}`;
        row.dataset.itemState = item.state;
        row.dataset.state = item.state;

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
        validateRow.dataset.state = stateName;

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
            : '0%';
    }

    if (event.current !== undefined && event.total) {
        return `${Math.round((event.current / event.total) * 100)}%`;
    }

    return '0%';
}

function formatLibraryValidateFileCount(
    event: LibraryValidateStatusEvent
): string {
    if (event.current !== undefined && event.total !== undefined) {
        return `${event.current}/${event.total} titles`;
    }

    return '';
}

function formatLibraryValidateIcon(event: LibraryValidateStatusEvent): string {
    const state = getLibraryValidateActionState(event);
    return state === 'complete' ? '✓' : state === 'failed' ? '!' : '...';
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
        event.name &&
        event.kind &&
        event.titleId
    ) {
        return `${event.name} [${formatTitleKind(event.kind)}]`;
    }

    return 'Library validation';
}

function formatLibraryValidateSize(event: LibraryValidateStatusEvent): string {
    return event.status === 'validating' && event.sizeText
        ? event.sizeText
        : '-';
}

function formatLibraryValidateDetails(
    event: LibraryValidateStatusEvent
): string {
    const state = getLibraryValidateActionState(event);
    if (state === 'validating') {
        return 'Checking files...';
    }

    if (state === 'complete') {
        return `${event.total ?? 0} titles`;
    }

    if (event.status === 'complete') {
        return `${event.failed ?? 0}/${event.total ?? 0} failed`;
    }

    return event.error
        ? `Failed to validate library. ${event.error}`
        : 'Failed to validate library.';
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
            ? [
                  createActionButton(
                      'Download',
                      LIBRARY_VALIDATE_SOCKET_COMMAND.failureDownload,
                      getLibraryValidateFailureKey(event)
                  ),
              ]
            : []),
        createActionButton(
            'Clear',
            LIBRARY_VALIDATE_SOCKET_COMMAND.failureClear,
            getLibraryValidateFailureKey(event)
        )
    );
    return details;
}

function renderLibraryValidateFailureRow(
    event: LibraryValidateStatusEvent
): HTMLElement {
    const row = document.createElement('div');
    row.className =
        'action-bar-row action-bar-row-validate-failure action-bar-row-failed';
    row.dataset.libraryValidateFailure = 'true';
    row.dataset.itemState = 'failed';
    row.dataset.state = 'failed';

    const progress = createActionBarCell('action-bar-progress', '-');
    const files = createActionBarCell('action-bar-files', '');
    const icon = createActionBarCell('action-bar-icon', '!');
    const state = createActionBarCell('action-bar-state', 'Failed');
    const size = createActionBarCell('action-bar-size', '-');
    const titleText = formatLibraryValidateTitle(event);
    const title = createActionBarCell('action-bar-title', titleText);
    title.title = titleText;
    const details = renderLibraryValidateFailureDetails(event);

    row.append(progress, files, icon, state, size, title, details);
    return row;
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
    const row = document.createElement('div');
    const stateName = getLibraryValidateActionState(event);
    row.className = `action-bar-row action-bar-row-validate action-bar-row-${stateName}`;
    row.dataset.libraryValidate = 'true';
    row.dataset.itemState = stateName;
    row.dataset.state = stateName;

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

    row.append(progress, files, icon, state, size, title, details);
    return row;
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
    const activeCount =
        options.downloads.filter((item) => item.state === 'downloading')
            .length +
        options.storageCopies.filter((item) => item.state === 'copying')
            .length +
        options.deletes.filter((item) => item.state === 'deleting').length +
        (validateState === 'validating' ? 1 : 0);
    const queuedCount =
        options.downloads.filter((item) => item.state === 'queued').length +
        options.storageCopies.filter((item) => item.state === 'queued').length +
        options.deletes.filter((item) => item.state === 'queued').length;
    const failedCount =
        options.downloads.filter((item) => item.state === 'failed').length +
        options.storageCopies.filter((item) => item.state === 'failed').length +
        options.deletes.filter((item) => item.state === 'failed').length +
        options.libraryValidateFailures.length +
        (validateState === 'failed' ? 1 : 0);
    const finishedCount =
        options.downloads.filter((item) => item.state === 'complete').length +
        options.storageCopies.filter((item) => item.state === 'complete')
            .length +
        options.deletes.filter((item) => item.state === 'complete').length +
        (validateState === 'complete' ? 1 : 0);

    actionBarRoot.replaceChildren();

    if (
        options.downloads.length === 0 &&
        options.storageCopies.length === 0 &&
        options.deletes.length === 0 &&
        options.libraryValidate === null &&
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

    for (const item of options.downloads) {
        details.append(renderDownloadActionRow(item));
    }

    for (const item of options.storageCopies) {
        details.append(renderStorageCopyActionRow(item));
    }

    for (const item of options.deletes) {
        details.append(renderDeleteActionRow(item));
    }

    if (options.libraryValidate) {
        details.append(renderLibraryValidateActionRow(options.libraryValidate));
    }

    for (const item of options.libraryValidateFailures) {
        details.append(renderLibraryValidateFailureRow(item));
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
