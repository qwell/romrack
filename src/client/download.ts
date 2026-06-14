import { type DownloadQueueItem } from '../shared/download.js';
import {
    formatActionFileCount,
    formatActionProgress,
    formatActionState,
    formatActionStateIcon,
    type ActionState,
} from '../shared/action.js';
import { formatSize, formatTitleDisplay } from '../shared/shared.js';
import { type TitleGroup, TitleKinds } from '../shared/titles.js';
import { DOWNLOAD_SOCKET_COMMAND } from '../shared/socket.js';
import { syncGroupStatusFromSlots } from './library.js';
import { sendAppSocketCommand } from './app-socket.js';

export function getDownloadState(
    queue: DownloadQueueItem[],
    family: string,
    kind: TitleKinds
): ActionState | null {
    return getDownloadItem(queue, family, kind)?.state ?? null;
}

export function getDownloadItem(
    queue: DownloadQueueItem[],
    family: string,
    kind: TitleKinds,
    titleId?: string
): DownloadQueueItem | null {
    return (
        queue.find(
            (item) =>
                item.family === family &&
                item.kind === kind &&
                (!titleId || item.titleId === titleId) &&
                item.state !== 'complete' &&
                item.state !== 'cancelled'
        ) ?? null
    );
}

export function formatDownloadIcon(item: DownloadQueueItem): string {
    return formatActionStateIcon(item.state, '↓');
}

export function formatDownloadProgress(item: DownloadQueueItem): string {
    return formatActionProgress(item.state, item.progress);
}

export function formatDownloadFileCount(item: DownloadQueueItem): string {
    return formatActionFileCount(
        item.completedFiles,
        item.totalFiles,
        Boolean(item.currentFileName && item.state === 'in-progress')
    );
}

export function formatDownloadState(item: DownloadQueueItem): string {
    return formatActionState(item.state, {
        'in-progress': item.speedText ?? 'Downloading',
        complete: 'Downloaded',
    });
}

export function formatDownloadTitle(item: DownloadQueueItem): string {
    return formatTitleDisplay(
        item.installedTitleName ?? item.groupName,
        item.titleId,
        item.kind,
        null
    );
}

export function formatDownloadDetails(item: DownloadQueueItem): string {
    if (item.error) {
        return item.error;
    }

    return item.currentFileName ?? item.speedText ?? '';
}

export function getDownloadActionBarEntries(items: DownloadQueueItem[]) {
    return items.map((item) => {
        const title = formatDownloadTitle(item);
        const terminal =
            item.state === 'complete' || item.state === 'cancelled';
        return {
            key: `download:${item.id}`,
            id: item.id,
            state: item.state,
            clearCommand: DOWNLOAD_SOCKET_COMMAND.clear,
            cells: [
                {
                    className: 'action-bar-progress',
                    text: formatDownloadProgress(item),
                },
                {
                    className: 'action-bar-files',
                    text: formatDownloadFileCount(item),
                },
                {
                    className: 'action-bar-icon',
                    text: formatDownloadIcon(item),
                },
                {
                    className: 'action-bar-state',
                    text: formatDownloadState(item),
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
                        ? formatDownloadDetails(item)
                        : undefined,
                title: item.state === 'failed' ? (item.error ?? '') : undefined,
                buttons:
                    item.state === 'failed'
                        ? [
                              {
                                  text: 'Retry',
                                  command: DOWNLOAD_SOCKET_COMMAND.retry,
                              },
                              {
                                  text: 'Clear',
                                  command: DOWNLOAD_SOCKET_COMMAND.clear,
                              },
                          ]
                        : [
                              {
                                  text: terminal ? 'Clear' : 'Cancel',
                                  command: terminal
                                      ? DOWNLOAD_SOCKET_COMMAND.clear
                                      : DOWNLOAD_SOCKET_COMMAND.cancel,
                              },
                          ],
            },
        };
    });
}

export function handleDownloadActionBarCommand(
    action: string,
    itemId: string,
    downloads: DownloadQueueItem[]
): boolean {
    const getIds = () => {
        const item = downloads.find((candidate) => candidate.id === itemId);

        return item
            ? downloads
                  .filter(
                      (candidate) =>
                          candidate.state !== 'complete' &&
                          candidate.state !== 'cancelled' &&
                          getDownloadDedupeKey(candidate) ===
                              getDownloadDedupeKey(item)
                  )
                  .map((candidate) => candidate.id)
            : [itemId];
    };

    const handlers: Record<string, () => void> = {
        [DOWNLOAD_SOCKET_COMMAND.cancel]: () =>
            getIds().forEach(cancelDownload),
        [DOWNLOAD_SOCKET_COMMAND.retry]: () => getIds().forEach(retryDownload),
        [DOWNLOAD_SOCKET_COMMAND.clear]: () => clearDownload(itemId),
    };

    const handler = handlers[action];

    if (!handler) {
        return false;
    }

    handler();
    return true;
}

export function getDownloadDedupeKey(item: DownloadQueueItem): string {
    return `${item.family}\0${item.kind}\0${item.titleId}`;
}

export function syncDownloadQueue(
    queue: DownloadQueueItem[],
    nextQueue: DownloadQueueItem[],
    haystacks: WeakMap<TitleGroup, string>,
    groups: TitleGroup[],
    onGroupChanged: (group: TitleGroup) => void
): void {
    const previousById = new Map(queue.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    queue.splice(0, queue.length, ...nextQueue);

    const completedItems = queue.filter((item) => {
        const previous = previousById.get(item.id);
        return (
            ((previous && previous.state !== 'complete') ||
                shouldReconcileCompleted) &&
            item.state === 'complete'
        );
    });

    renderDownloadMarkers(queue);

    for (const item of completedItems) {
        try {
            markDownloadComplete(
                queue,
                haystacks,
                groups,
                item,
                onGroupChanged
            );
        } catch (error) {
            console.error('Failed to reconcile completed download', error);
        }
    }
}

export function queueDownloads(
    queue: DownloadQueueItem[],
    items: DownloadQueueItem[]
): DownloadQueueItem[] {
    const seen = new Set<string>();

    const addedItems = items.filter((item) => {
        const key = getDownloadDedupeKey(item);

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);

        return !getDownloadItem(queue, item.family, item.kind, item.titleId);
    });

    if (addedItems.length === 0) {
        return [];
    }

    queue.push(...addedItems);
    renderDownloadMarkers(queue);

    sendAppSocketCommand({
        type: DOWNLOAD_SOCKET_COMMAND.queue,
        items: addedItems,
    });
    return addedItems;
}

export function retryDownload(itemId: string): void {
    sendAppSocketCommand({
        type: DOWNLOAD_SOCKET_COMMAND.retry,
        id: itemId,
    });
}

export function clearDownload(itemId: string): void {
    sendAppSocketCommand({
        type: DOWNLOAD_SOCKET_COMMAND.clear,
        id: itemId,
    });
}

export function cancelDownload(itemId: string): void {
    sendAppSocketCommand({
        type: DOWNLOAD_SOCKET_COMMAND.cancel,
        id: itemId,
    });
}

export function renderDownloadMarkers(queue: DownloadQueueItem[]): void {
    for (const badge of document.querySelectorAll<HTMLElement>(
        '.title-slot-badge'
    )) {
        const family = badge.dataset.family;
        const kind = badge.dataset.kind as TitleKinds | undefined;
        const marker = badge.querySelector<HTMLElement>(
            '.title-slot-badge-download'
        );

        if (!family || !kind || !marker) {
            continue;
        }

        const state = getDownloadState(queue, family, kind);
        marker.textContent = formatActionStateIcon(state, '↓');
        marker.hidden = state === null;
        badge.dataset.downloadState = state ?? '';
    }
}

function markDownloadComplete(
    queue: DownloadQueueItem[],
    haystacks: WeakMap<TitleGroup, string>,
    groups: TitleGroup[],
    item: DownloadQueueItem,
    onGroupChanged: (group: TitleGroup) => void
): void {
    const group = groups.find((candidate) => candidate.family === item.family);

    if (!group) {
        return;
    }

    const alreadyDownloaded = group.entries.some(
        (entry) => entry.kind === item.kind && entry.titleId === item.titleId
    );

    const installedSizeBytes = item.installedSizeBytes ?? item.totalBytes ?? 0;
    const installedVersion = item.installedVersion ?? 0;
    const installedTitleName = item.installedTitleName ?? group.name;

    if (!alreadyDownloaded) {
        group.entries.push({
            titleId: item.titleId,
            version: installedVersion,
            name: installedTitleName,
            region: group.region,
            iconUrl: group.iconUrl,
            kind: item.kind,
            sizeBytes: installedSizeBytes,
            copyCount: 1,
        });
        haystacks.delete(group);
    } else {
        const existingEntry = group.entries.find(
            (entry) =>
                entry.kind === item.kind && entry.titleId === item.titleId
        );

        if (existingEntry) {
            if (installedVersion < existingEntry.version) {
                syncGroupStatusFromSlots(group);
                onGroupChanged(group);
                return;
            }
            existingEntry.version = installedVersion;
            existingEntry.name = installedTitleName;
            existingEntry.sizeBytes = installedSizeBytes;
            haystacks.delete(group);
        }
    }

    group.availableEntries = group.availableEntries.filter(
        (entry) => !(entry.kind === item.kind && entry.titleId === item.titleId)
    );

    syncGroupStatusFromSlots(group);
    onGroupChanged(group);
}

export function collectSelectedDownloads(
    root: HTMLElement,
    selectedOnly = true
): DownloadQueueItem[] {
    const selector = selectedOnly
        ? '.sidebar-download-checkbox:checked:not(:disabled)'
        : '.sidebar-download-checkbox:not(:disabled)';

    return Array.from(root.querySelectorAll<HTMLInputElement>(selector)).map(
        (checkbox) => ({
            id: crypto.randomUUID(),
            family: checkbox.dataset.family ?? '',
            groupName: checkbox.dataset.groupName ?? '',
            kind: checkbox.dataset.kind as TitleKinds,
            label: checkbox.dataset.label ?? '',
            titleId: checkbox.dataset.titleId ?? '',
            sizeText: checkbox.dataset.sizeText ?? null,
            totalBytes: checkbox.dataset.totalBytes
                ? Number(checkbox.dataset.totalBytes)
                : null,
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
        })
    );
}
