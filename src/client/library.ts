import {
    type AvailableTitleEntry,
    type ChildKind,
    PARENT_KINDS,
    type TitleEntry,
    type TitleGroup,
    TitleKinds,
} from '../shared/titles.js';
import { type DeleteItem } from '../shared/delete.js';
import { type StorageCopyItem } from '../shared/storage.js';
import {
    createActionBarCell,
    createActionBarRow,
    createActionButton,
} from './actionbar.js';
import type {
    LibraryValidateStatusEvent,
    LibraryConvertItem,
} from '../shared/socket.js';
import type { DownloadQueueItem } from '../shared/download.js';
import { formatTitleDisplay } from '../shared/shared.js';
import { formatSize } from '../shared/shared.js';
import {
    formatActionProgress,
    formatActionStateIcon,
} from '../shared/action.js';
import {
    LIBRARY_VALIDATE_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_COMMAND,
} from '../shared/socket.js';

export type SlotBadgeState =
    | 'complete'
    | 'incomplete'
    | 'na'
    | 'unavailable'
    | 'unknown';

type MarkStorageCompleteOptions = {
    groups: TitleGroup[];
    haystacks: WeakMap<TitleGroup, string>;
    onGroupChanged: (group: TitleGroup) => void;
};

export type LibraryActionBarCommand =
    | (typeof LIBRARY_VALIDATE_SOCKET_COMMAND)[keyof typeof LIBRARY_VALIDATE_SOCKET_COMMAND]
    | (typeof LIBRARY_CONVERT_SOCKET_COMMAND)[keyof typeof LIBRARY_CONVERT_SOCKET_COMMAND];

export function getEntry(
    group: TitleGroup,
    kinds: TitleKinds | readonly TitleKinds[]
): TitleEntry | null {
    const kindList = Array.isArray(kinds) ? kinds : [kinds];
    return group.entries.find((entry) => kindList.includes(entry.kind)) ?? null;
}

function getAvailableEntry(
    group: TitleGroup,
    kind: TitleKinds
): TitleGroup['availableEntries'][number] | null {
    return group.availableEntries.find((entry) => entry.kind === kind) ?? null;
}

function isChildExpected(group: TitleGroup, childKind: ChildKind): boolean {
    return group.expectedChildren.includes(childKind);
}

export function isAvailableEntryKind(
    kind: TitleKinds
): kind is AvailableTitleEntry['kind'] {
    return (
        kind === TitleKinds.Base ||
        kind === TitleKinds.Update ||
        kind === TitleKinds.DLC
    );
}

export function createAvailableEntry(
    entry: TitleEntry
): AvailableTitleEntry | null {
    if (!isAvailableEntryKind(entry.kind)) {
        return null;
    }

    return {
        kind: entry.kind,
        titleId: entry.titleId.toLowerCase(),
        versions: entry.version > 0 ? [entry.version] : [],
        availableOnCdn: true,
    };
}

export function addAvailableEntry(
    group: TitleGroup,
    entry: AvailableTitleEntry
): boolean {
    const hasAvailableEntry = group.availableEntries.some(
        (candidate) =>
            candidate.kind === entry.kind &&
            candidate.titleId.toLowerCase() === entry.titleId.toLowerCase()
    );

    if (hasAvailableEntry) {
        return false;
    }

    group.availableEntries.push(entry);
    return true;
}

export function getBaseBadgeState(group: TitleGroup): SlotBadgeState {
    if (!group.titleInDatabase) {
        return 'unknown';
    }

    if (getEntry(group, PARENT_KINDS)) {
        return 'complete';
    }

    const availableEntry = getAvailableEntry(group, TitleKinds.Base);
    if (availableEntry && !availableEntry.availableOnCdn) {
        return 'unavailable';
    }

    return 'incomplete';
}

export function getChildBadgeState(
    group: TitleGroup,
    childKind: ChildKind
): SlotBadgeState {
    if (!isChildExpected(group, childKind)) {
        return 'na';
    }

    const entry = getEntry(group, childKind);
    if (entry) {
        return 'complete';
    }

    const availableEntry = getAvailableEntry(group, childKind);
    if (availableEntry && !availableEntry.availableOnCdn) {
        return 'unavailable';
    }

    return 'incomplete';
}

export function syncGroupStatusFromSlots(group: TitleGroup): void {
    const baseState = getBaseBadgeState(group);
    const updateState = getChildBadgeState(group, TitleKinds.Update);
    const dlcState = getChildBadgeState(group, TitleKinds.DLC);

    if (
        baseState === 'complete' &&
        (updateState === 'complete' || updateState === 'na') &&
        (dlcState === 'complete' || dlcState === 'na')
    ) {
        group.status = 'complete';
        return;
    }

    if (
        baseState === 'complete' ||
        updateState === 'complete' ||
        dlcState === 'complete'
    ) {
        group.status = 'incomplete';
        return;
    }

    if (
        baseState === 'unavailable' ||
        updateState === 'unavailable' ||
        dlcState === 'unavailable'
    ) {
        group.status = 'unavailable';
        return;
    }

    if (group.titleInDatabase) {
        group.status = 'missing';
        return;
    }

    group.status = 'unknown';
}

function restoreDeletedEntryAvailability(
    group: TitleGroup,
    entry: TitleEntry
): void {
    if (!group.titleInDatabase) {
        return;
    }

    const availableEntry = createAvailableEntry(entry);
    if (!availableEntry) {
        return;
    }

    addAvailableEntry(group, availableEntry);
}

function removeCompletedStorageTitleIdsFromGroup(
    group: TitleGroup,
    completedTitleIds: Set<string>,
    options: MarkStorageCompleteOptions
): void {
    const deletedEntries = group.entries.filter((entry) =>
        completedTitleIds.has(entry.titleId)
    );

    if (deletedEntries.length === 0) {
        return;
    }

    group.entries = group.entries.filter(
        (entry) => !completedTitleIds.has(entry.titleId)
    );
    for (const entry of deletedEntries) {
        restoreDeletedEntryAvailability(group, entry);
    }

    options.haystacks.delete(group);
    syncGroupStatusFromSlots(group);
    options.onGroupChanged(group);
}

export function markStorageCopiesComplete(
    items: StorageCopyItem[],
    options: MarkStorageCompleteOptions
): void {
    const completedMoveTitleIds = new Set(
        items
            .filter(
                (item) =>
                    item.state === 'complete' &&
                    item.operation === 'move' &&
                    item.titleId !== null
            )
            .map((item) => item.titleId as string)
    );

    if (completedMoveTitleIds.size === 0) {
        return;
    }

    for (const group of options.groups) {
        removeCompletedStorageTitleIdsFromGroup(
            group,
            completedMoveTitleIds,
            options
        );
    }
}

export function markDeletesComplete(
    items: DeleteItem[],
    options: MarkStorageCompleteOptions
): void {
    const completedTitleIds = new Set(
        items
            .filter((item) => item.state === 'complete')
            .map((item) => item.titleId)
    );

    if (completedTitleIds.size === 0) {
        return;
    }

    for (const group of options.groups) {
        removeCompletedStorageTitleIdsFromGroup(
            group,
            completedTitleIds,
            options
        );
    }
}

export function formatLibraryValidateProgress(
    item: LibraryValidateStatusEvent
): string {
    if (item.status === 'complete') {
        return '100%';
    }

    if (item.status === 'failed') {
        return item.current !== undefined && item.total
            ? `${Math.round((item.current / item.total) * 100)}%`
            : '-';
    }

    if (item.current !== undefined && item.total) {
        return `${Math.round((item.current / item.total) * 100)}%`;
    }

    return '-';
}

export function formatLibraryValidateFileCount(
    item: LibraryValidateStatusEvent
): string {
    if (item.current !== undefined && item.total !== undefined) {
        const current =
            item.status === 'validating'
                ? Math.min(item.current + 1, item.total)
                : item.current;
        return `${current}/${item.total} titles`;
    }

    return '';
}

export function formatLibraryValidateIcon(
    item: LibraryValidateStatusEvent
): string {
    return formatActionStateIcon(item.state);
}

export function formatLibraryValidateState(
    item: LibraryValidateStatusEvent
): string {
    const state = item.state;
    return state === 'complete'
        ? 'Complete'
        : state === 'failed'
          ? 'Failed'
          : state === 'cancelled'
            ? 'Cancelled'
            : 'Validating';
}

export function formatLibraryValidateTitle(
    item: LibraryValidateStatusEvent
): string {
    if (
        (item.status === 'validating' || item.status === 'validated') &&
        item.kind &&
        item.titleId
    ) {
        return formatTitleDisplay(
            item.name ?? null,
            item.titleId,
            item.kind,
            null
        );
    }

    return '';
}

export function formatLibraryValidateSize(
    item: LibraryValidateStatusEvent
): string {
    return item.status === 'validating'
        ? formatSize(item.currentFileSizeBytes ?? null)
        : '';
}

export function formatLibraryValidateDetails(
    item: LibraryValidateStatusEvent
): string {
    const state = item.state;
    if (state === 'in-progress') {
        return item.currentFileName
            ? item.currentFileName
            : 'Checking files...';
    }

    if (state === 'complete') {
        return `${item.total ?? 0} titles`;
    }

    if (item.status === 'complete') {
        return `${item.failed ?? 0}/${item.total ?? 0} failed`;
    }

    return '';
}

export function getLibraryValidateFailureKey(
    item: LibraryValidateStatusEvent
): string {
    return item.titleId ?? item.name ?? 'unknown';
}

export function getLibraryValidateId(item: LibraryValidateStatusEvent): string {
    return isLibraryValidateFailure(item)
        ? getLibraryValidateFailureKey(item)
        : 'main';
}

function isLibraryValidateFailureDownloadQueued(
    item: LibraryValidateStatusEvent,
    downloads?: DownloadQueueItem[]
): boolean {
    if (!item.titleId || !item.kind) {
        return false;
    }

    const family = item.titleId.toLowerCase().slice(8);

    return (
        downloads?.some(
            (download) =>
                download.state !== 'complete' &&
                download.state !== 'cancelled' &&
                download.family === family &&
                download.kind === item.kind &&
                download.titleId.toLowerCase() === item.titleId?.toLowerCase()
        ) ?? false
    );
}

function createLibraryValidateFailureDownloadButton(
    item: LibraryValidateStatusEvent,
    downloads?: DownloadQueueItem[]
): HTMLButtonElement {
    const button = createActionButton(
        'Download',
        LIBRARY_VALIDATE_SOCKET_COMMAND.download,
        getLibraryValidateFailureKey(item)
    );
    button.disabled = isLibraryValidateFailureDownloadQueued(item, downloads);
    return button;
}

function renderLibraryValidateControls(
    item: LibraryValidateStatusEvent,
    downloads?: DownloadQueueItem[]
): HTMLDivElement {
    const detailsCell = document.createElement('div');
    detailsCell.className = 'action-bar-details-cell action-bar-controls';

    if (item.state === 'in-progress' || isLibraryValidateFailure(item)) {
        const detailsText = formatLibraryValidateDetails(item);
        const detailsTextElement = document.createElement('span');
        detailsTextElement.className = 'action-bar-control-text';
        detailsTextElement.title = detailsText;
        detailsTextElement.textContent = detailsText;
        detailsTextElement.dataset.libraryValidateDetail = 'true';
        detailsCell.append(detailsTextElement);
    }

    if (isLibraryValidateFailure(item) && item.titleId) {
        detailsCell.append(
            createLibraryValidateFailureDownloadButton(item, downloads)
        );
    }

    if (item.state === 'in-progress') {
        detailsCell.append(
            createActionButton(
                'Cancel',
                LIBRARY_VALIDATE_SOCKET_COMMAND.cancel,
                getLibraryValidateId(item)
            )
        );
    } else {
        detailsCell.append(
            createActionButton(
                'Clear',
                LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
                getLibraryValidateId(item)
            )
        );
    }

    return detailsCell;
}

export function isLibraryValidateFailure(
    item: LibraryValidateStatusEvent
): boolean {
    return item.status === 'validated' && item.result === 'failed';
}

export function renderLibraryValidateActionRow(
    item: LibraryValidateStatusEvent,
    downloads?: DownloadQueueItem[]
): HTMLElement {
    const progress = createActionBarCell(
        'action-bar-progress',
        formatLibraryValidateProgress(item)
    );
    progress.dataset.libraryValidateProgress = 'true';

    const files = createActionBarCell(
        'action-bar-files',
        formatLibraryValidateFileCount(item)
    );
    files.dataset.libraryValidateFiles = 'true';

    const icon = createActionBarCell(
        'action-bar-icon',
        formatLibraryValidateIcon(item)
    );
    icon.dataset.libraryValidateIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatLibraryValidateState(item)
    );
    state.dataset.libraryValidateState = 'true';

    const size = createActionBarCell(
        'action-bar-size',
        formatLibraryValidateSize(item)
    );
    size.dataset.libraryValidateSize = 'true';

    const titleText = formatLibraryValidateTitle(item);
    const title = createActionBarCell('action-bar-title', titleText);
    title.title = titleText;
    title.dataset.libraryValidateTitle = 'true';

    const detailsCell = renderLibraryValidateControls(item, downloads);
    return createActionBarRow({
        id: getLibraryValidateId(item),
        state: item.state,
        cells: [progress, files, icon, state, size, title, detailsCell],
        itemIdDataKey: 'libraryValidateItemId',
    });
}

export function formatLibraryConvertProgress(item: LibraryConvertItem): string {
    const progress =
        item.current !== null && item.total
            ? (item.current / item.total) * 100
            : null;
    return formatActionProgress(item.state, progress);
}

export function formatLibraryConvertFileCount(
    item: LibraryConvertItem
): string {
    if (item.current === null || item.total === null) {
        return '';
    }

    const current =
        item.currentFileName && item.state === 'in-progress'
            ? Math.min(item.current + 1, item.total)
            : item.current;
    return `${current} / ${item.total} files`;
}

export function formatLibraryConvertIcon(item: LibraryConvertItem): string {
    return formatActionStateIcon(item.state);
}

export function formatLibraryConvertState(item: LibraryConvertItem): string {
    switch (item.state) {
        case 'queued':
            return 'Queued';
        case 'in-progress':
            return 'Converting';
        case 'complete':
            return 'Complete';
        case 'cancelled':
            return 'Cancelled';
        case 'failed':
            return 'Failed';
    }
}

export function formatLibraryConvertTitle(item: LibraryConvertItem): string {
    return formatTitleDisplay(item.name, item.titleId, item.kind, null);
}

export function formatLibraryConvertDetails(item: LibraryConvertItem): string {
    return (
        item.error ??
        item.currentFileName ??
        (item.state === 'complete'
            ? `${item.converted ?? 0} title(s) converted`
            : item.state === 'queued'
              ? 'Queued'
              : item.state === 'cancelled'
                ? ''
                : 'Reading WUD/WUX image...')
    );
}

function renderLibraryConvertControls(
    item: LibraryConvertItem
): HTMLDivElement {
    const detailsCell = createActionBarCell('action-bar-details-cell', '');
    detailsCell.classList.add('action-bar-controls');

    if (item.state === 'in-progress') {
        const details = formatLibraryConvertDetails(item);
        const detailsTextCell = createActionBarCell(
            'action-bar-control-text',
            details
        );
        detailsTextCell.title = details;
        detailsTextCell.dataset.libraryConvertDetail = 'true';
        detailsCell.append(
            detailsTextCell,
            createActionButton(
                'Cancel',
                LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'queued') {
        detailsCell.append(
            createActionButton(
                'Cancel',
                LIBRARY_CONVERT_SOCKET_COMMAND.cancel,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'failed') {
        detailsCell.append(
            createActionButton(
                'Retry',
                LIBRARY_CONVERT_SOCKET_COMMAND.retry,
                item.id
            ),
            createActionButton(
                'Clear',
                LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                item.id
            )
        );
        return detailsCell;
    }

    const clearButton = createActionButton(
        'Clear',
        LIBRARY_CONVERT_SOCKET_COMMAND.clear,
        item.id
    );
    detailsCell.append(clearButton);

    return detailsCell;
}

export function renderLibraryConvertActionRow(
    item: LibraryConvertItem
): HTMLElement {
    const progress = createActionBarCell(
        'action-bar-progress',
        formatLibraryConvertProgress(item)
    );
    progress.dataset.libraryConvertProgress = 'true';

    const files = createActionBarCell(
        'action-bar-files',
        formatLibraryConvertFileCount(item)
    );
    files.dataset.libraryConvertFiles = 'true';

    const icon = createActionBarCell(
        'action-bar-icon',
        formatLibraryConvertIcon(item)
    );
    icon.dataset.libraryConvertIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatLibraryConvertState(item)
    );
    state.dataset.libraryConvertState = 'true';

    const size = createActionBarCell(
        'action-bar-size',
        formatSize(item.currentFileSizeBytes)
    );
    size.dataset.libraryConvertSize = 'true';

    const titleText = formatLibraryConvertTitle(item);
    const title = createActionBarCell('action-bar-title', titleText);
    title.title = titleText;
    title.dataset.libraryConvertTitle = 'true';

    const detailsCell = renderLibraryConvertControls(item);

    return createActionBarRow({
        id: item.id,
        state: item.state,
        cells: [progress, files, icon, state, size, title, detailsCell],
        itemIdDataKey: 'libraryConvertItemId',
    });
}
