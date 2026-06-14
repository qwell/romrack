import {
    classifyTitleId,
    type AvailableTitleEntry,
    type ChildKind,
    PARENT_KINDS,
    type TitleEntry,
    type TitleGroup,
    TitleKinds,
} from '../shared/titles.js';
import { type LibraryValidateTitle } from '../shared/api.js';
import type {
    LibraryValidateStatusEvent,
    LibraryConvertItem,
    TitleValidationSocketEvent,
} from '../shared/socket.js';
import { formatTitleDisplay } from '../shared/shared.js';
import { formatSize } from '../shared/shared.js';
import {
    formatActionFileCount,
    formatActionProgress,
    formatActionState,
    formatActionStateIcon,
} from '../shared/action.js';
import {
    LIBRARY_VALIDATE_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_COMMAND,
} from '../shared/socket.js';
import { type DownloadQueueItem } from '../shared/download.js';
import { sendAppSocketCommand } from './app-socket.js';

export type SlotBadgeState =
    | 'complete'
    | 'incomplete'
    | 'na'
    | 'unavailable'
    | 'unknown';

export function isValidationFailed(
    event: TitleValidationSocketEvent | null
): boolean {
    return (
        event?.status === 'failed' ||
        event?.status === 'validating' ||
        (event?.status === 'complete' &&
            event.copies.some((copy) => copy.status === 'failed'))
    );
}

function validationToAvailableEntry(
    title: LibraryValidateTitle
): AvailableTitleEntry | null {
    if (
        title.status !== 'failed' ||
        title.titleId === null ||
        !isAvailableEntryKind(title.kind)
    ) {
        return null;
    }

    return createAvailableEntry({
        titleId: title.titleId,
        name: title.name,
        region: null,
        iconUrl: null,
        version: title.version ?? 0,
        kind: title.kind,
        sizeBytes: 0,
        copyCount: 1,
    });
}

export function mergeFailedValidationsIntoAvailable(
    groups: TitleGroup[],
    titles: LibraryValidateTitle[]
): TitleGroup[] {
    const changedGroups: TitleGroup[] = [];

    for (const title of titles) {
        const entry = validationToAvailableEntry(title);
        if (!entry) continue;

        const family = classifyTitleId(entry.titleId).family;
        const group = groups.find(
            (candidate) => candidate.family.toLowerCase() === family
        );
        if (!group) continue;

        const entryIndex = group.entries.findIndex(
            (candidate) =>
                candidate.kind === entry.kind &&
                candidate.titleId.toLowerCase() === entry.titleId
        );
        if (entryIndex !== -1) group.entries.splice(entryIndex, 1);
        addAvailableEntry(group, entry);
        if (!changedGroups.includes(group)) changedGroups.push(group);
    }

    return changedGroups;
}

type RemoveTitlesFromLibraryOptions = {
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

function removeTitlesFromGroup(
    group: TitleGroup,
    titleIds: Set<string>,
    options: RemoveTitlesFromLibraryOptions
): void {
    const removedEntries = group.entries.filter((entry) =>
        titleIds.has(entry.titleId)
    );

    if (removedEntries.length === 0) {
        return;
    }

    group.entries = group.entries.filter(
        (entry) => !titleIds.has(entry.titleId)
    );
    for (const entry of removedEntries) {
        restoreDeletedEntryAvailability(group, entry);
    }

    options.haystacks.delete(group);
    syncGroupStatusFromSlots(group);
    options.onGroupChanged(group);
}

export function removeTitlesFromLibrary(
    removedTitleIds: string[],
    options: RemoveTitlesFromLibraryOptions
): void {
    const titleIds = new Set(removedTitleIds);

    if (titleIds.size === 0) {
        return;
    }

    for (const group of options.groups) {
        removeTitlesFromGroup(group, titleIds, options);
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
    return formatActionState(item.state, {
        'in-progress': 'Validating',
        complete: 'Validated',
    });
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
        return `${item.failed ?? 0} / ${item.total ?? 0} failed`;
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

export function isLibraryValidateFailure(
    item: LibraryValidateStatusEvent
): boolean {
    return item.status === 'validated' && item.result === 'failed';
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
    return formatActionFileCount(
        item.current,
        item.total,
        Boolean(item.currentFileName && item.state === 'in-progress')
    );
}

export function formatLibraryConvertIcon(item: LibraryConvertItem): string {
    return formatActionStateIcon(item.state);
}

export function formatLibraryConvertState(item: LibraryConvertItem): string {
    return formatActionState(item.state, {
        'in-progress': 'Converting',
        complete: 'Converted',
    });
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

export function renderLibrarySidebarWud(
    group: TitleGroup,
    conversionBusy: boolean,
    queueConvert: (titleId: string) => Promise<unknown>
): { content: HTMLElement; action: HTMLElement } {
    const content = document.createElement('div');
    content.className = 'sidebar-download-content sidebar-wud-content';
    const titles = group.wudEntries.flatMap((entry) => entry.titles);
    const baseTitle = titles.find(
        (title) => classifyTitleId(title.titleId).kind === TitleKinds.Base
    );
    const conversionTitle = baseTitle ?? titles[0];

    const action = document.createElement('button');
    action.className = 'sidebar-button';
    action.type = 'button';
    action.textContent = 'Convert';
    action.disabled = conversionBusy;
    action.title = 'Convert the disc image to installable title content';
    action.addEventListener('click', () => {
        if (!conversionTitle || action.disabled) return;

        action.disabled = true;
        void queueConvert(conversionTitle.titleId).catch((error) => {
            console.error(error);
            action.disabled = false;
        });
    });

    const list = document.createElement('div');
    list.className = 'sidebar-download-list';
    for (const title of titles) {
        const row = document.createElement('div');
        row.className =
            'sidebar-download-row sidebar-wud-row sidebar-wud-row-muted';
        const space = document.createElement('span');
        const slot = document.createElement('span');
        slot.className = 'sidebar-download-slot';
        slot.textContent = `${classifyTitleId(title.titleId).kind} v${title.version}`;
        const id = document.createElement('span');
        id.className = 'sidebar-download-id';
        id.textContent = title.titleId;
        id.title = title.titleId;
        row.append(space, slot, id);
        list.append(row);
    }

    content.append(list);
    return { content, action };
}

export function getLibraryValidateActionBarEntries(
    items: LibraryValidateStatusEvent[],
    downloads: DownloadQueueItem[]
) {
    return items.map((item) => {
        const id = getLibraryValidateId(item);
        let downloadDisabled = false;
        if (isLibraryValidateFailure(item) && item.titleId && item.kind) {
            const family = item.titleId.toLowerCase().slice(8);
            downloadDisabled = downloads.some(
                (candidate) =>
                    candidate.state !== 'complete' &&
                    candidate.state !== 'cancelled' &&
                    candidate.family === family &&
                    candidate.kind === item.kind &&
                    candidate.titleId.toLowerCase() ===
                        item.titleId?.toLowerCase()
            );
        }

        const title = formatLibraryValidateTitle(item);
        return {
            key: `library-validate:${id}`,
            id,
            state: item.state,
            clearCommand: LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
            cells: [
                {
                    className: 'action-bar-progress',
                    text: formatLibraryValidateProgress(item),
                },
                {
                    className: 'action-bar-files',
                    text: formatLibraryValidateFileCount(item),
                },
                {
                    className: 'action-bar-icon',
                    text: formatLibraryValidateIcon(item),
                },
                {
                    className: 'action-bar-state',
                    text: formatLibraryValidateState(item),
                },
                {
                    className: 'action-bar-size',
                    text: formatLibraryValidateSize(item),
                },
                { className: 'action-bar-title', text: title, title },
            ],
            details: {
                text:
                    item.state === 'in-progress' ||
                    isLibraryValidateFailure(item)
                        ? formatLibraryValidateDetails(item)
                        : undefined,
                buttons: [
                    ...(isLibraryValidateFailure(item) && item.titleId
                        ? [
                              {
                                  text: 'Download',
                                  command:
                                      LIBRARY_VALIDATE_SOCKET_COMMAND.download,
                                  disabled: downloadDisabled,
                              },
                          ]
                        : []),
                    {
                        text: item.state === 'in-progress' ? 'Cancel' : 'Clear',
                        command:
                            item.state === 'in-progress'
                                ? LIBRARY_VALIDATE_SOCKET_COMMAND.cancel
                                : LIBRARY_VALIDATE_SOCKET_COMMAND.clear,
                    },
                ],
            },
        };
    });
}

export function getLibraryConvertActionBarEntries(items: LibraryConvertItem[]) {
    return items.map((item) => {
        const title = formatLibraryConvertTitle(item);
        return {
            key: `library-convert:${item.id}`,
            id: item.id,
            state: item.state,
            clearCommand: LIBRARY_CONVERT_SOCKET_COMMAND.clear,
            cells: [
                {
                    className: 'action-bar-progress',
                    text: formatLibraryConvertProgress(item),
                },
                {
                    className: 'action-bar-files',
                    text: formatLibraryConvertFileCount(item),
                },
                {
                    className: 'action-bar-icon',
                    text: formatLibraryConvertIcon(item),
                },
                {
                    className: 'action-bar-state',
                    text: formatLibraryConvertState(item),
                },
                {
                    className: 'action-bar-size',
                    text: formatSize(item.currentFileSizeBytes),
                },
                { className: 'action-bar-title', text: title, title },
            ],
            details: {
                text:
                    item.state === 'in-progress'
                        ? formatLibraryConvertDetails(item)
                        : undefined,
                buttons: [
                    ...(item.state === 'failed'
                        ? [
                              {
                                  text: 'Retry',
                                  command: LIBRARY_CONVERT_SOCKET_COMMAND.retry,
                              },
                          ]
                        : []),
                    {
                        text:
                            item.state === 'in-progress' ||
                            item.state === 'queued'
                                ? 'Cancel'
                                : 'Clear',
                        command:
                            item.state === 'in-progress' ||
                            item.state === 'queued'
                                ? LIBRARY_CONVERT_SOCKET_COMMAND.cancel
                                : LIBRARY_CONVERT_SOCKET_COMMAND.clear,
                    },
                ],
            },
        };
    });
}

export function syncLibraryValidateActions(
    items: LibraryValidateStatusEvent[],
    event: LibraryValidateStatusEvent | null
): void {
    if (event?.status === 'started') items.splice(0);

    if (event?.status === 'validated' && event.result === 'failed') {
        const failed = { ...event, state: 'failed' as const };
        const key = getLibraryValidateFailureKey(failed);
        const index = items.findIndex(
            (item) =>
                isLibraryValidateFailure(item) &&
                getLibraryValidateFailureKey(item) === key
        );
        if (index >= 0) items.splice(index, 1, failed);
        else items.push(failed);
        return;
    }

    const index = items.findIndex((item) => !isLibraryValidateFailure(item));
    if (event === null && index >= 0) items.splice(index, 1);
    else if (event && index >= 0) items.splice(index, 1, event);
    else if (event) items.push(event);
}

export function handleLibraryActionBarCommand(
    action: string,
    itemId: string,
    validations: LibraryValidateStatusEvent[],
    queueValidationDownloads: (items: DownloadQueueItem[]) => void
): boolean {
    if (action === LIBRARY_VALIDATE_SOCKET_COMMAND.clear) {
        const index = validations.findIndex(
            (item) => getLibraryValidateId(item) === itemId
        );
        if (index >= 0) validations.splice(index, 1);
    } else if (action === LIBRARY_VALIDATE_SOCKET_COMMAND.cancel) {
        sendAppSocketCommand({ type: LIBRARY_VALIDATE_SOCKET_COMMAND.cancel });
    } else if (action === LIBRARY_VALIDATE_SOCKET_COMMAND.download) {
        const item = validations.find(
            (candidate) => getLibraryValidateId(candidate) === itemId
        );
        if (!item?.titleId || !item.kind) return true;
        queueValidationDownloads([
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
    } else if (
        action === LIBRARY_CONVERT_SOCKET_COMMAND.cancel ||
        action === LIBRARY_CONVERT_SOCKET_COMMAND.clear ||
        action === LIBRARY_CONVERT_SOCKET_COMMAND.retry
    ) {
        sendAppSocketCommand({ type: action, id: itemId });
    } else {
        return false;
    }
    return true;
}
