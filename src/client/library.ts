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
    LIBRARY_CONVERT_SOCKET_COMMAND,
    LIBRARY_VALIDATE_SOCKET_COMMAND,
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
