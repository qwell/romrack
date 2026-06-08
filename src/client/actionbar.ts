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
import { formatSize } from '../shared/shared.js';
import { isTerminalActionState, type ActionState } from '../shared/action.js';
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
    cancelDelete,
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
    formatDownloadDetails,
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
import type { LibraryActionBarCommand } from './library.js';
import {
    renderLibraryValidateActionRow,
    renderLibraryConvertActionRow,
    formatLibraryValidateProgress,
    formatLibraryValidateFileCount,
    formatLibraryValidateIcon,
    formatLibraryValidateState,
    formatLibraryValidateTitle,
    formatLibraryValidateSize,
    formatLibraryValidateDetails,
    formatLibraryConvertProgress,
    formatLibraryConvertFileCount,
    formatLibraryConvertIcon,
    formatLibraryConvertState,
    formatLibraryConvertTitle,
    formatLibraryConvertDetails,
    isLibraryValidateFailure,
    getLibraryValidateFailureKey,
    getLibraryValidateId,
} from './library.js';

export type ActionBarCommand =
    | DownloadActionBarCommand
    | StorageActionBarCommand
    | DeleteActionBarCommand
    | LibraryActionBarCommand;

type ActionBarOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    deletes: DeleteItem[];
    libraryValidations: LibraryValidateStatusEvent[];
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
    deleteCancel: DELETE_SOCKET_COMMAND.cancel,
    libraryValidateCancel: LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
    libraryValidateClear: LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
    libraryValidateDownload: LIBRARY_VALIDATE_SOCKET_COMMAND.download,
    libraryConvertCancel: LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
    libraryConvertClear: LIBRARY_CONVERT_SOCKET_COMMAND.clear,
    libraryConvertRetry: LIBRARY_CONVERT_SOCKET_COMMAND.retry,
} as const;

const DATA_ATTR = {
    DOWNLOAD_ITEM_ID: 'data-download-item-id',
    DOWNLOAD_PROGRESS: 'data-download-progress',
    DOWNLOAD_FILES: 'data-download-files',
    DOWNLOAD_ICON: 'data-download-icon',
    DOWNLOAD_STATE: 'data-download-state',
    DOWNLOAD_SIZE: 'data-download-size',
    DOWNLOAD_TITLE: 'data-download-title',
    DOWNLOAD_DETAIL: 'data-download-detail',
    STORAGE_COPY_ITEM_ID: 'data-storage-copy-item-id',
    STORAGE_COPY_PROGRESS: 'data-storage-copy-progress',
    STORAGE_COPY_FILES: 'data-storage-copy-files',
    STORAGE_COPY_ICON: 'data-storage-copy-icon',
    STORAGE_COPY_STATE: 'data-storage-copy-state',
    STORAGE_COPY_SIZE: 'data-storage-copy-size',
    STORAGE_COPY_TITLE: 'data-storage-copy-title',
    STORAGE_COPY_DETAIL: 'data-storage-copy-detail',
    DELETE_ITEM_ID: 'data-delete-item-id',
    DELETE_PROGRESS: 'data-delete-progress',
    DELETE_ICON: 'data-delete-icon',
    DELETE_STATE: 'data-delete-state',
    DELETE_TITLE: 'data-delete-title',
    DELETE_DETAIL: 'data-delete-detail',
    LIBRARY_VALIDATE_ITEM_ID: 'data-library-validate-item-id',
    LIBRARY_VALIDATE_PROGRESS: 'data-library-validate-progress',
    LIBRARY_VALIDATE_FILES: 'data-library-validate-files',
    LIBRARY_VALIDATE_ICON: 'data-library-validate-icon',
    LIBRARY_VALIDATE_STATE: 'data-library-validate-state',
    LIBRARY_VALIDATE_TITLE: 'data-library-validate-title',
    LIBRARY_VALIDATE_SIZE: 'data-library-validate-size',
    LIBRARY_VALIDATE_DETAIL: 'data-library-validate-detail',
    LIBRARY_CONVERT_ITEM_ID: 'data-library-convert-item-id',
    LIBRARY_CONVERT_PROGRESS: 'data-library-convert-progress',
    LIBRARY_CONVERT_FILES: 'data-library-convert-files',
    LIBRARY_CONVERT_ICON: 'data-library-convert-icon',
    LIBRARY_CONVERT_STATE: 'data-library-convert-state',
    LIBRARY_CONVERT_TITLE: 'data-library-convert-title',
    LIBRARY_CONVERT_SIZE: 'data-library-convert-size',
    LIBRARY_CONVERT_DETAIL: 'data-library-convert-detail',
};

function countByState<T extends { state: ActionState }>(
    arr: T[],
    state: ActionState
) {
    return arr.filter((i) => i.state === state).length;
}

function isActionBarCommand<T extends ActionBarCommand>(
    command: string | null,
    type?: T | readonly T[] | Record<string, T>
): command is T {
    if (command === null) {
        return false;
    }

    if (!type) {
        return Object.values(ACTION_BAR_COMMAND).includes(
            command as ActionBarCommand
        );
    }

    const allowed: T[] = Array.isArray(type)
        ? (type as T[])
        : typeof type === 'object'
          ? Object.values(type)
          : [type];

    return allowed.includes(command as T);
}

function isClearableActionBarItem(options: ActionBarOptions): boolean {
    return (
        options.downloads.some((item) => isTerminalActionState(item.state)) ||
        options.storageCopies.some((item) =>
            isTerminalActionState(item.state)
        ) ||
        options.deletes.some((item) => isTerminalActionState(item.state)) ||
        options.libraryValidations.some((item) =>
            isTerminalActionState(item.state)
        ) ||
        options.libraryConversions.some((item) =>
            isTerminalActionState(item.state)
        )
    );
}

function clearAllActionBarItems(options: ActionBarOptions): void {
    const commands: Array<[ActionBarCommand, string]> = [];

    for (const item of options.downloads) {
        if (isTerminalActionState(item.state)) {
            commands.push([DOWNLOAD_SOCKET_COMMAND.clear, item.id]);
        }
    }

    for (const item of options.storageCopies) {
        if (isTerminalActionState(item.state)) {
            commands.push([STORAGE_COPY_SOCKET_COMMAND.clear, item.id]);
        }
    }

    for (const item of options.deletes) {
        if (isTerminalActionState(item.state)) {
            commands.push([DELETE_SOCKET_COMMAND.clear, item.id]);
        }
    }

    for (const item of options.libraryValidations) {
        if (isTerminalActionState(item.state)) {
            commands.push([
                LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
                getLibraryValidateId(item),
            ]);
        }
    }

    for (const item of options.libraryConversions) {
        if (isTerminalActionState(item.state)) {
            commands.push([LIBRARY_CONVERT_SOCKET_COMMAND.clear, item.id]);
        }
    }

    for (const [command, itemId] of commands) {
        options.onCommand(command, itemId);
    }
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
                candidate.state !== 'cancelled' &&
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
    function downloadHandler(action: ActionBarCommand, itemId: string) {
        switch (action) {
            case DOWNLOAD_SOCKET_COMMAND.cancel:
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    cancelDownload
                );
                return;
            case DOWNLOAD_SOCKET_COMMAND.clear:
                clearDownload(itemId);
                return;
            case DOWNLOAD_SOCKET_COMMAND.retry:
                sendDownloadCommandForMatches(
                    itemId,
                    options.downloads,
                    retryDownload
                );
                return;
        }
    }

    function storageHandler(action: ActionBarCommand, itemId: string) {
        switch (action) {
            case STORAGE_COPY_SOCKET_COMMAND.cancel:
                cancelStorageCopy(itemId);
                return;
            case STORAGE_COPY_SOCKET_COMMAND.clear:
                clearStorageCopy(itemId);
                return;
            case STORAGE_COPY_SOCKET_COMMAND.retry:
                retryStorageCopy(itemId);
                return;
        }
    }

    function deleteHandler(action: ActionBarCommand, itemId: string) {
        switch (action) {
            case DELETE_SOCKET_COMMAND.clear:
                clearDelete(itemId);
                return;
            case DELETE_SOCKET_COMMAND.cancel:
                cancelDelete(itemId);
                return;
            case DELETE_SOCKET_COMMAND.retry:
                retryDelete(itemId);
                return;
        }
    }

    function libraryHandler(action: ActionBarCommand, itemId: string) {
        switch (action) {
            case LIBRARY_VALIDATE_SOCKET_COMMAND.cancel:
                sendAppSocketCommand({
                    type: LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
                });
                return;
            case LIBRARY_VALIDATE_SOCKET_COMMAND.clear:
                clearLibraryValidation(itemId);
                return;
            case LIBRARY_VALIDATE_SOCKET_COMMAND.download:
                queueLibraryValidationDownload(options.downloads, itemId);
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
    }

    return (action, itemId) => {
        if (
            isActionBarCommand(action, [
                DOWNLOAD_SOCKET_COMMAND.cancel,
                DOWNLOAD_SOCKET_COMMAND.clear,
                DOWNLOAD_SOCKET_COMMAND.retry,
            ])
        ) {
            downloadHandler(action, itemId);
            return;
        }

        if (
            isActionBarCommand(action, [
                STORAGE_COPY_SOCKET_COMMAND.cancel,
                STORAGE_COPY_SOCKET_COMMAND.clear,
                STORAGE_COPY_SOCKET_COMMAND.retry,
            ])
        ) {
            storageHandler(action, itemId);
            return;
        }

        if (
            isActionBarCommand(action, [
                DELETE_SOCKET_COMMAND.clear,
                DELETE_SOCKET_COMMAND.cancel,
                DELETE_SOCKET_COMMAND.retry,
            ])
        ) {
            deleteHandler(action, itemId);
            return;
        }

        if (
            isActionBarCommand(action, [
                LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
                LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
                LIBRARY_VALIDATE_SOCKET_COMMAND.download,
                LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
                LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                LIBRARY_CONVERT_SOCKET_COMMAND.retry,
            ])
        ) {
            libraryHandler(action, itemId);
            return;
        }
    };
}

function getActionBarSignature(options: ActionBarOptions): string {
    const entries = getOrderedActionBarEntries(options);

    return JSON.stringify(
        entries.map((entry) => ({
            key: entry.key,
            state: entry.state,
        }))
    );
}

type ActionBarEntry = {
    key: string;
    state: ActionState;
} & (
    | {
          type: 'download';
          item: DownloadQueueItem;
      }
    | {
          type: 'storageCopy';
          item: StorageCopyItem;
      }
    | {
          type: 'delete';
          item: DeleteItem;
      }
    | {
          type: 'libraryValidate';
          item: LibraryValidateStatusEvent;
      }
    | {
          type: 'libraryConvert';
          item: LibraryConvertItem;
      }
);

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
            state: item.state,
            type: 'download' as const,
            item,
        })),
        ...options.storageCopies.map((item) => ({
            key: `storage-copy:${item.id}`,
            state: item.state,
            type: 'storageCopy' as const,
            item,
        })),
        ...options.deletes.map((item) => ({
            key: `delete:${item.id}`,
            state: item.state,
            type: 'delete' as const,
            item,
        })),
        ...options.libraryValidations.map((item) => ({
            key: `library-validate:${getLibraryValidateId(item)}`,
            state: item.state,
            type: 'libraryValidate' as const,
            item,
        })),
        ...options.libraryConversions.map((item) => ({
            key: `library-convert:${item.id}`,
            state: item.state,
            type: 'libraryConvert' as const,
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
        actionBarOptions.libraryValidations.splice(0);
    }

    if (event?.status === 'validated' && event.result === 'failed') {
        addLibraryValidateFailure(event);
        updateActionBar();
        return;
    }

    const existingMainIndex = actionBarOptions.libraryValidations.findIndex(
        (item) => !isLibraryValidateFailure(item)
    );
    if (event === null) {
        if (existingMainIndex >= 0) {
            actionBarOptions.libraryValidations.splice(existingMainIndex, 1);
        }
    } else if (existingMainIndex >= 0) {
        actionBarOptions.libraryValidations.splice(existingMainIndex, 1, event);
    } else {
        actionBarOptions.libraryValidations.push(event);
    }
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
    const failedEvent: LibraryValidateStatusEvent = {
        ...event,
        state: 'failed',
    };
    const key = getLibraryValidateFailureKey(failedEvent);
    if (!actionBarOptions) {
        return;
    }

    const existingIndex = actionBarOptions.libraryValidations.findIndex(
        (item) =>
            isLibraryValidateFailure(item) &&
            getLibraryValidateFailureKey(item) === key
    );

    if (existingIndex >= 0) {
        actionBarOptions.libraryValidations.splice(
            existingIndex,
            1,
            failedEvent
        );
        return;
    }

    actionBarOptions.libraryValidations.push(failedEvent);
}

function clearLibraryValidation(itemId: string): void {
    if (!actionBarOptions) {
        return;
    }

    const nextValidations = actionBarOptions.libraryValidations.filter(
        (item) => {
            return getLibraryValidateId(item) !== itemId;
        }
    );
    actionBarOptions.libraryValidations.splice(
        0,
        actionBarOptions.libraryValidations.length,
        ...nextValidations
    );
    updateActionBar();
}

function queueLibraryValidationDownload(
    downloads: DownloadQueueItem[],
    itemId: string
): void {
    const item =
        actionBarOptions?.libraryValidations.find(
            (candidate) =>
                isLibraryValidateFailure(candidate) &&
                getLibraryValidateFailureKey(candidate) === itemId
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
        clearLibraryValidation(itemId);
    }
}

function updateActionBarRowState(row: HTMLElement, state: ActionState): void {
    row.className = `action-bar-row action-bar-row-${state}`;
    row.dataset.itemState = state;
}

function updateActionBarCell(
    row: HTMLElement,
    dataAttribute: string,
    text: string,
    setTitle = false
): void {
    const cell = row.querySelector<HTMLElement>(`[${dataAttribute}]`);
    if (!cell) {
        return;
    }

    cell.textContent = text;
    if (setTitle) {
        cell.title = text;
    }
}

function updateActionBarRowsInPlace(options: ActionBarOptions): void {
    if (!actionBarRoot) {
        return;
    }

    for (const item of options.downloads) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[${DATA_ATTR.DOWNLOAD_ITEM_ID}="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        updateActionBarRowState(row, item.state);
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_PROGRESS,
            formatDownloadProgress(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_FILES,
            formatDownloadFileCount(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_ICON,
            formatDownloadIcon(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_STATE,
            formatDownloadState(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_SIZE,
            formatSize(item.currentFileSizeBytes)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_TITLE,
            formatDownloadTitle(item),
            true
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DOWNLOAD_DETAIL,
            formatDownloadDetails(item),
            true
        );
    }

    for (const item of options.storageCopies) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[${DATA_ATTR.STORAGE_COPY_ITEM_ID}="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        updateActionBarRowState(row, item.state);
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_PROGRESS,
            formatStorageCopyProgress(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_FILES,
            formatStorageCopyFileCount(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_ICON,
            formatStorageCopyIcon(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_STATE,
            formatStorageCopyState(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_SIZE,
            formatSize(item.currentSizeBytes)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_TITLE,
            formatStorageCopyTitle(item),
            true
        );
        updateActionBarCell(
            row,
            DATA_ATTR.STORAGE_COPY_DETAIL,
            formatStorageCopyDetails(item),
            true
        );
    }

    for (const item of options.deletes) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[${DATA_ATTR.DELETE_ITEM_ID}="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        updateActionBarRowState(row, item.state);
        updateActionBarCell(
            row,
            DATA_ATTR.DELETE_PROGRESS,
            formatDeleteProgress(item)
        );
        updateActionBarCell(row, DATA_ATTR.DELETE_ICON, formatDeleteIcon(item));
        updateActionBarCell(
            row,
            DATA_ATTR.DELETE_STATE,
            formatDeleteState(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DELETE_TITLE,
            formatDeleteTitle(item),
            true
        );
        updateActionBarCell(
            row,
            DATA_ATTR.DELETE_DETAIL,
            formatDeleteDetails(item),
            true
        );
    }

    for (const item of options.libraryValidations) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[${DATA_ATTR.LIBRARY_VALIDATE_ITEM_ID}="${CSS.escape(
                getLibraryValidateId(item)
            )}"]`
        );

        if (!row) {
            continue;
        }

        updateActionBarRowState(row, item.state);
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_PROGRESS,
            formatLibraryValidateProgress(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_FILES,
            formatLibraryValidateFileCount(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_ICON,
            formatLibraryValidateIcon(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_STATE,
            formatLibraryValidateState(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_SIZE,
            formatLibraryValidateSize(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_TITLE,
            formatLibraryValidateTitle(item),
            true
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_VALIDATE_DETAIL,
            formatLibraryValidateDetails(item),
            true
        );
    }

    for (const item of options.libraryConversions) {
        const row = actionBarRoot.querySelector<HTMLElement>(
            `[${DATA_ATTR.LIBRARY_CONVERT_ITEM_ID}="${CSS.escape(item.id)}"]`
        );

        if (!row) {
            continue;
        }

        updateActionBarRowState(row, item.state);
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_PROGRESS,
            formatLibraryConvertProgress(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_FILES,
            formatLibraryConvertFileCount(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_ICON,
            formatLibraryConvertIcon(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_STATE,
            formatLibraryConvertState(item)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_SIZE,
            formatSize(item.currentFileSizeBytes)
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_TITLE,
            formatLibraryConvertTitle(item),
            true
        );
        updateActionBarCell(
            row,
            DATA_ATTR.LIBRARY_CONVERT_DETAIL,
            formatLibraryConvertDetails(item),
            true
        );
    }
}

export function updateActionBar(): void {
    if (!actionBarRoot || !actionBarOptions) {
        return;
    }

    const isEmpty =
        actionBarOptions.downloads.length === 0 &&
        actionBarOptions.storageCopies.length === 0 &&
        actionBarOptions.deletes.length === 0 &&
        actionBarOptions.libraryValidations.length === 0 &&
        actionBarOptions.libraryConversions.length === 0;
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
    state: ActionState;
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

    const activeCount =
        countByState(options.downloads, 'in-progress') +
        countByState(options.storageCopies, 'in-progress') +
        countByState(options.deletes, 'in-progress') +
        countByState(options.libraryValidations, 'in-progress') +
        countByState(options.libraryConversions, 'in-progress');

    const queuedCount =
        countByState(options.downloads, 'queued') +
        countByState(options.storageCopies, 'queued') +
        countByState(options.deletes, 'queued') +
        countByState(options.libraryValidations, 'queued') +
        countByState(options.libraryConversions, 'queued');

    const failedCount =
        countByState(options.downloads, 'failed') +
        countByState(options.storageCopies, 'failed') +
        countByState(options.deletes, 'failed') +
        countByState(options.libraryValidations, 'failed') +
        countByState(options.libraryConversions, 'failed');

    const finishedCount =
        countByState(options.downloads, 'complete') +
        countByState(options.storageCopies, 'complete') +
        countByState(options.deletes, 'complete') +
        countByState(options.libraryValidations, 'complete') +
        countByState(options.libraryConversions, 'complete') +
        countByState(options.downloads, 'cancelled') +
        countByState(options.storageCopies, 'cancelled') +
        countByState(options.deletes, 'cancelled') +
        countByState(options.libraryValidations, 'cancelled') +
        countByState(options.libraryConversions, 'cancelled');

    actionBarRoot.replaceChildren();

    if (
        options.downloads.length === 0 &&
        options.storageCopies.length === 0 &&
        options.deletes.length === 0 &&
        options.libraryValidations.length === 0 &&
        options.libraryConversions.length === 0
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
                details.append(
                    renderLibraryValidateActionRow(
                        entry.item,
                        options.downloads
                    )
                );
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
