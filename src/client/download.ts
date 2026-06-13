import { type DownloadQueueItem } from '../shared/download.js';
import {
    formatActionProgress,
    formatActionStateIcon,
    type ActionState,
} from '../shared/action.js';
import { formatSize, formatTitleDisplay } from '../shared/shared.js';
import { type TitleGroup, TitleKinds } from '../shared/titles.js';
import { DOWNLOAD_SOCKET_COMMAND } from '../shared/socket.js';
import {
    createActionBarCell,
    createActionBarRow,
    createActionButton,
    updateActionBar,
} from './actionbar.js';
import { markSlotBadgeComplete, updateRenderedTitleGroup } from './titles.js';
import { refreshOpenDetailSidebarForGroup } from './sidebar.js';
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
    if (item.completedFiles === null || item.totalFiles === null) {
        return '';
    }

    const current =
        item.currentFileName && item.state === 'in-progress'
            ? Math.min(item.completedFiles + 1, item.totalFiles)
            : item.completedFiles;
    return `${current} / ${item.totalFiles} files`;
}

export function formatDownloadState(item: DownloadQueueItem): string {
    switch (item.state) {
        case 'in-progress':
            return item.speedText ?? 'Downloading';
        case 'queued':
            return 'Queued';
        case 'failed':
            return 'Failed';
        case 'complete':
            return 'Downloaded';
        case 'cancelled':
            return 'Cancelled';
    }
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

export function getDownloadDedupeKey(item: DownloadQueueItem): string {
    return `${item.family}\0${item.kind}\0${item.titleId}`;
}

export function syncDownloadQueue(
    queue: DownloadQueueItem[],
    nextQueue: DownloadQueueItem[],
    haystacks: WeakMap<TitleGroup, string>,
    groups: TitleGroup[],
    onDownloadComplete?: (item: DownloadQueueItem) => void
): void {
    const previousById = new Map(queue.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    queue.splice(0, queue.length, ...nextQueue);

    for (const item of queue) {
        const previous = previousById.get(item.id);

        if (
            ((previous && previous.state !== 'complete') ||
                shouldReconcileCompleted) &&
            item.state === 'complete'
        ) {
            markSlotBadgeComplete(item.family, item.kind);
            onDownloadComplete?.(item);
            markDownloadComplete(queue, haystacks, groups, item);
        }
    }

    updateActionBar();
    renderDownloadMarkers(queue);
}

export function renderDownloadActionRow(item: DownloadQueueItem): HTMLElement {
    const progress = createActionBarCell(
        'action-bar-progress',
        formatDownloadProgress(item)
    );
    progress.dataset.downloadProgress = 'true';

    const files = createActionBarCell(
        'action-bar-files',
        formatDownloadFileCount(item)
    );
    files.dataset.downloadFiles = 'true';

    const icon = createActionBarCell(
        'action-bar-icon',
        formatDownloadIcon(item)
    );
    icon.dataset.downloadIcon = 'true';

    const state = createActionBarCell(
        'action-bar-state',
        formatDownloadState(item)
    );
    state.dataset.downloadState = 'true';

    const size = createActionBarCell(
        'action-bar-size',
        formatSize(item.currentFileSizeBytes)
    );
    size.dataset.downloadSize = 'true';

    const downloadTitle = formatDownloadTitle(item);
    const title = createActionBarCell('action-bar-title', downloadTitle);
    title.title = downloadTitle;
    title.dataset.downloadTitle = 'true';

    const detailsCell = renderDownloadControls(item);

    return createActionBarRow({
        id: item.id,
        state: item.state,
        cells: [progress, files, icon, state, size, title, detailsCell],
        itemIdDataKey: 'downloadItemId',
    });
}

function renderDownloadControls(item: DownloadQueueItem): HTMLDivElement {
    const detailsCell = document.createElement('div');
    detailsCell.className = 'action-bar-details-cell';

    if (item.state === 'failed') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.title = item.error ?? '';
        detailsCell.append(
            createActionButton('Retry', DOWNLOAD_SOCKET_COMMAND.retry, item.id),
            createActionButton('Clear', DOWNLOAD_SOCKET_COMMAND.clear, item.id)
        );
        return detailsCell;
    }

    if (item.state === 'queued') {
        detailsCell.classList.add('action-bar-controls');
        detailsCell.append(
            createActionButton(
                'Cancel',
                DOWNLOAD_SOCKET_COMMAND.cancel,
                item.id
            )
        );
        return detailsCell;
    }

    if (item.state === 'complete' || item.state === 'cancelled') {
        detailsCell.classList.add('action-bar-controls');
        const clearButton = createActionButton(
            'Clear',
            DOWNLOAD_SOCKET_COMMAND.clear,
            item.id
        );
        detailsCell.append(clearButton);
        return detailsCell;
    }

    if (item.state === 'in-progress') {
        detailsCell.classList.add('action-bar-controls');

        const detailsText = formatDownloadDetails(item);
        const detailsTextElement = document.createElement('span');
        detailsTextElement.className = 'action-bar-control-text';
        detailsTextElement.title = detailsText;
        detailsTextElement.textContent = detailsText;
        detailsTextElement.dataset.downloadDetail = 'true';

        detailsCell.append(
            detailsTextElement,
            createActionButton(
                'Cancel',
                DOWNLOAD_SOCKET_COMMAND.cancel,
                item.id
            )
        );
        return detailsCell;
    }

    const detailsText = formatDownloadDetails(item);
    detailsCell.title = detailsText;
    detailsCell.textContent = detailsText;
    return detailsCell;
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
    updateActionBar();
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
    item: DownloadQueueItem
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
                updateRenderedTitleGroup(group);
                refreshOpenDetailSidebarForGroup(group);
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
    updateRenderedTitleGroup(group);
    refreshOpenDetailSidebarForGroup(group);
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
