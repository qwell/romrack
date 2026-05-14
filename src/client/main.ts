import {
    DownloadActionBarCommand,
    cancelDownload,
    removeDownload,
    retryDownload,
    syncDownloadQueue,
    renderDownloadActionRow,
    getDownloadState,
    formatDownloadIcon,
    renderDownloadAvailabilityRow,
    queueDownloads,
    collectSelectedDownloads,
    renderDownloadMarkers,
    getDownloadDedupeKey,
    requestJson,
    formatDownloadProgress,
    formatDownloadTitle,
} from './download.js';
import {
    StorageActionBarCommand,
    cancelStorageCopy,
    removeStorageCopy,
    removeStorageDelete,
    retryStorageCopy,
    retryStorageDelete,
    syncStorageCopies,
    syncStorageDeletes,
    renderStorageCopyActionRow,
    renderStorageDeleteActionRow,
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
} from './storage.js';
import {
    type LibraryResponse,
    type TitleGroup,
    type TitleEntry,
    type AvailableTitleEntry,
    type TitleGroupStatus,
    type TitleDetails,
    type TitleInputControl,
    TitleKinds,
    type ChildKind,
    PARENT_KINDS,
    getVirtualConsolePlatform,
    VirtualConsolePlatform,
} from '../shared/titles.js';
import {
    DownloadQueueItem,
    formatSize,
    StorageCopyItem,
    StorageDeleteItem,
} from '../shared/shared.js';
import { type Fat32Volume } from '../shared/os.js';
import { AppSocketCommand, AppSocketEvent } from '../shared/socket.js';
import {
    type AppConfig,
    type AppConfigResponse,
    type AppConfigValidateRootResponse,
} from '../shared/config.js';

declare const __APP_VERSION__: string;
const SOCKET_RECONNECT_MS = 2000;

type SlotBadgeState =
    | 'complete'
    | 'incomplete'
    | 'na'
    | 'unavailable'
    | 'unknown';
type LibraryViewMode = 'table' | 'list';
type LibraryVcFilter = 'all' | 'vc' | 'non-vc' | VirtualConsolePlatform;
type LibraryStatusTone = 'info' | 'success' | 'error';
type LibraryControlState = {
    region: string;
    status: TitleGroupStatus | 'all';
    vc: LibraryVcFilter;
    search: string;
};
type LibraryContentOptions = {
    loading?: boolean;
    onRefresh?: () => void | Promise<void>;
};
type Fat32ListResponse = {
    runtimeOs: string;
    volumes: Fat32Volume[];
};

type ActionBarCommand = DownloadActionBarCommand | StorageActionBarCommand;

let showAllTitles = false;
let selectedFamily: string | null = null;
let currentGroups: TitleGroup[] = [];
let fat32ListPromise: Promise<Fat32ListResponse> | null = null;
let libraryControlState: LibraryControlState = {
    region: 'all',
    status: 'all',
    vc: 'all',
    search: '',
};
let libraryStatusMessage = '';
let libraryStatusTone: LibraryStatusTone = 'info';
let validatingLibrary = false;
let libraryLoading = false;
let activeLibraryRequestId = 0;
let settingsConfig: AppConfig | null = null;
let settingsStatusMessage = '';
let settingsStatusTone: LibraryStatusTone = 'info';
let settingsLoading = false;
let settingsSaving = false;
let settingsCheckingRoot = false;

const downloadQueue: DownloadQueueItem[] = [];
const storageCopies: StorageCopyItem[] = [];
const storageDeletes: StorageDeleteItem[] = [];

let iconObserver: IntersectionObserver | null = null;

const serverStatusModal = document.querySelector<HTMLDivElement>(
    '#server-status-modal'
);
const settingsRoot = document.querySelector<HTMLDivElement>('#settings-root');

let actionBarRoot: HTMLElement | null = null;
let actionBarSignature = '';
let appSocket: WebSocket | null = null;
let reconnectSocketTimer: number | null = null;

function resetIconObserver(): IntersectionObserver {
    iconObserver?.disconnect();
    iconObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    continue;
                }

                const image = entry.target;
                if (!(image instanceof HTMLImageElement)) {
                    continue;
                }

                const iconUrl = image.dataset.src;
                if (iconUrl) {
                    image.src = iconUrl;
                    delete image.dataset.src;
                }

                iconObserver?.unobserve(image);
            }
        },
        {
            rootMargin: '256px',
        }
    );
    return iconObserver;
}

function getViewMode(): LibraryViewMode {
    return localStorage.getItem('libraryViewMode') === 'list'
        ? 'list'
        : 'table';
}

function saveViewMode(viewMode: LibraryViewMode): void {
    localStorage.setItem('libraryViewMode', viewMode);
}

function isSettingsOpen(): boolean {
    return document.body.hasAttribute('data-settings-open');
}

function configureActionButton(
    button: HTMLButtonElement,
    action: ActionBarCommand,
    itemId: string
): void {
    button.dataset.action = action;
    button.dataset.itemId = itemId;
}

//FIXME
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

function getMatchingDownloadIds(itemId: string): string[] {
    const item = downloadQueue.find((candidate) => candidate.id === itemId);

    if (!item) {
        return [itemId];
    }

    const key = getDownloadDedupeKey(item);

    const ids = downloadQueue
        .filter(
            (candidate) =>
                candidate.state !== 'complete' &&
                getDownloadDedupeKey(candidate) === key
        )
        .map((candidate) => candidate.id);

    return ids.length > 0 ? ids : [itemId];
}

//FIXME
function handleActionBarCommand(
    action: ActionBarCommand | undefined,
    itemId: string
): void {
    switch (action) {
        case 'download.cancel':
            sendDownloadCommandForMatches(itemId, cancelDownload);
            return;

        case 'download.remove':
            sendDownloadCommandForMatches(itemId, removeDownload);
            return;

        case 'download.retry':
            sendDownloadCommandForMatches(itemId, retryDownload);
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
}

function updateSettingsStatus(
    message: string,
    tone: LibraryStatusTone = 'info'
): void {
    settingsStatusMessage = message;
    settingsStatusTone = tone;
    renderSettingsSidebar();
}

function formatRegion(region: string | null): {
    text: string;
    flag: string;
    class?: string;
} {
    switch (region) {
        case 'USA':
            return { text: 'USA', flag: '🇺🇸', class: 'distress' };
        case 'EUR':
            return { text: 'EUR', flag: '🇪🇺' };
        case 'JPN':
            return { text: 'JPN', flag: '🇯🇵' };
        case 'FRA':
            return { text: 'FRA', flag: '🇫🇷' };
        case 'GER':
            return { text: 'GER', flag: '🇩🇪' };
        case 'ITA':
            return { text: 'ITA', flag: '🇮🇹' };
        case 'SPA':
            return { text: 'SPA', flag: '🇪🇸' };
        case 'UNK':
            return { text: 'UNK', flag: '🏴‍☠️', class: 'arrr' };
        case 'ALL':
            return { text: 'ALL', flag: '🌐' };
        default:
            return { text: region ?? '', flag: '' };
    }
}

function formatCount(value: number, singular: string, plural: string): string {
    return `${value} ${value === 1 ? singular : plural}`;
}

function formatControlType(type: string): string {
    const labels: Record<string, string> = {
        balanceboard: 'Balance Board',
        classiccontroller: 'Classic Controller',
        gamecube: 'GameCube Controller',
        motionplus: 'MotionPlus',
        nunchuk: 'Nunchuk',
        pad: 'GamePad',
        procontroller: 'Pro Controller',
        wiimote: 'Wii Remote',
    };

    return labels[type] ?? type;
}

function formatInputControl(control: TitleInputControl): string {
    return `${formatControlType(control.type)} ${control.required ? 'required' : 'optional'}`;
}

function formatInput(details: TitleDetails): string {
    const parts: string[] = [];

    if (details.inputPlayers !== null) {
        parts.push(formatCount(details.inputPlayers, 'player', 'players'));
    }

    parts.push(...details.inputControls.map(formatInputControl));

    return parts.join('; ') || '-';
}

function hasLocalEntry(group: TitleGroup, kind: TitleKinds): boolean {
    return group.entries.some((entry) => entry.kind === kind);
}

function renderDetailRow(label: string, value: string | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'title-detail-row';

    const labelElement = document.createElement('dt');
    labelElement.textContent = label;

    const valueElement = document.createElement('dd');
    valueElement.textContent = value && value.length > 0 ? value : '-';

    row.append(labelElement, valueElement);
    return row;
}

function formatTitleKindLabel(kind: TitleKinds): string {
    return kind === TitleKinds.Base ? 'Game' : kind;
}

function renderDownloadedCopyRow(entry: TitleEntry): HTMLElement {
    const row = document.createElement('label');
    row.className = 'title-download-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'title-storage-copy-checkbox';
    checkbox.value = entry.titleId;
    checkbox.dataset.titleId = entry.titleId;

    const slot = document.createElement('span');
    slot.className = 'title-download-slot';
    slot.textContent = `${formatTitleKindLabel(entry.kind)} v${entry.version}`;

    const titleId = document.createElement('span');
    titleId.className = 'title-download-id';
    titleId.textContent = entry.titleId;

    const copyCount = document.createElement('span');
    copyCount.className = 'title-download-copy-count';
    copyCount.textContent =
        entry.copyCount > 1 ? `(${entry.copyCount} copies)` : '';

    const size = document.createElement('span');
    size.className = 'title-download-size';
    size.textContent = formatSize(entry.sizeBytes);

    row.append(checkbox, slot, titleId, copyCount, size);
    return row;
}

function getSelectedDownloadedTitleIds(
    root: HTMLElement,
    selectedOnly: boolean
): string[] {
    const selector = selectedOnly
        ? '.title-storage-copy-checkbox:checked'
        : '.title-storage-copy-checkbox';

    return Array.from(root.querySelectorAll<HTMLInputElement>(selector))
        .map((checkbox) => checkbox.dataset.titleId ?? '')
        .filter((titleId) => titleId.length > 0);
}

function isAvailableEntryKind(
    kind: TitleKinds
): kind is AvailableTitleEntry['kind'] {
    return (
        kind === TitleKinds.Base ||
        kind === TitleKinds.Update ||
        kind === TitleKinds.DLC
    );
}

function restoreDeletedEntryAvailability(
    group: TitleGroup,
    entry: TitleEntry
): void {
    if (!group.titleInDatabase || !isAvailableEntryKind(entry.kind)) {
        return;
    }

    const hasAvailableEntry = group.availableEntries.some(
        (candidate) =>
            candidate.kind === entry.kind && candidate.titleId === entry.titleId
    );

    if (hasAvailableEntry) {
        return;
    }

    group.availableEntries.push({
        kind: entry.kind,
        titleId: entry.titleId,
        versions: entry.version > 0 ? [entry.version] : [],
        availableOnCdn: true,
    });
}

function markStorageTitleIdsRemoved(
    haystacks: WeakMap<TitleGroup, string>,
    group: TitleGroup,
    completedTitleIds: Set<string>
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

    haystacks.delete(group);
    updateGroupStatusFromSlots(group);
    updateRenderedTitleGroup(group);
    refreshOpenDetailSidebarForGroup(group);
}

function markStorageCopyComplete(
    haystacks: WeakMap<TitleGroup, string>,
    group: TitleGroup,
    completedMoveTitleIds: Set<string>
): void {
    markStorageTitleIdsRemoved(haystacks, group, completedMoveTitleIds);
}

function markStorageDeleteComplete(
    haystacks: WeakMap<TitleGroup, string>,
    group: TitleGroup,
    completedTitleIds: Set<string>
): void {
    markStorageTitleIdsRemoved(haystacks, group, completedTitleIds);
}

function markStorageCopiesComplete(items: StorageCopyItem[]): void {
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

    for (const group of currentGroups) {
        markStorageCopyComplete(
            groupSearchHaystacks,
            group,
            completedMoveTitleIds
        );
    }
}

function markStorageDeletesComplete(items: StorageDeleteItem[]): void {
    const completedTitleIds = new Set(
        items
            .filter((item) => item.state === 'complete')
            .map((item) => item.titleId)
    );

    if (completedTitleIds.size === 0) {
        return;
    }

    for (const group of currentGroups) {
        markStorageDeleteComplete(
            groupSearchHaystacks,
            group,
            completedTitleIds
        );
    }
}

function formatFat32VolumeOption(volume: Fat32Volume): string {
    const label = volume.label ? `${volume.label} - ` : '';
    const size =
        volume.freeBytes === null
            ? ''
            : ` (${formatSize(volume.freeBytes)} free)`;
    return `${label}${volume.source}${size}`;
}

function getFat32Devices(): Promise<Fat32ListResponse> {
    fat32ListPromise ??= requestJson<Fat32ListResponse>(
        '/api/storage/list-fat32'
    ).catch((error) => {
        fat32ListPromise = null;
        throw error;
    });

    return fat32ListPromise;
}

async function populateFat32DeviceSelect(
    select: HTMLSelectElement,
    button: HTMLButtonElement
): Promise<void> {
    try {
        const response = await getFat32Devices();

        select.replaceChildren();
        for (const volume of response.volumes) {
            const option = document.createElement('option');
            option.value = volume.source;
            option.textContent = formatFat32VolumeOption(volume);
            select.append(option);
        }

        const hasVolumes = response.volumes.length > 0;
        select.disabled = !hasVolumes;
        button.disabled = !hasVolumes;

        if (!hasVolumes) {
            const option = document.createElement('option');
            option.textContent = 'No FAT32 devices found';
            select.append(option);
        }
    } catch {
        select.replaceChildren();
        const option = document.createElement('option');
        option.textContent = 'Failed to load FAT32 devices';
        select.append(option);
        select.disabled = true;
        button.disabled = true;
    }
}

function formatValidationStatus(event: AppSocketEvent): string | null {
    if (event.type !== 'library.validationStatus') {
        return null;
    }

    switch (event.status) {
        case 'started':
            return 'Validating library...';

        case 'validating':
            return `Validating library... [${event.titleId}] ${event.titleName} [${event.titleKind}] (${event.sizeText})`;

        case 'validated':
            return `Validated library... [${event.titleId}] ${event.titleName} [${event.titleKind}] (${event.result})`;

        case 'complete':
            return event.failed === 0
                ? `Validation passed for ${event.total} titles.`
                : `Validation failed for ${event.failed} of ${event.total} titles. Check the server logs for details.`;

        case 'failed':
            return event.error
                ? `Failed to validate library. ${event.error}`
                : 'Failed to validate library.';
    }
}

export function getPathDisplayName(value: string): string {
    const trimmed = value.replace(/[\\/]+$/, '');
    const name = trimmed.split(/[\\/]/).pop() || trimmed;
    return name.replace(/(?:\s+\[[^\]]+\])+$/g, '').trim() || name;
}

function getSocketUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/api/socket`;
}

export function sendAppSocketCommand(command: AppSocketCommand): void {
    if (!appSocket || appSocket.readyState !== WebSocket.OPEN) {
        showServerGoneModal();
        return;
    }

    appSocket.send(JSON.stringify(command));
}

function sendDownloadCommandForMatches(
    itemId: string,
    send: (id: string) => void
): void {
    for (const id of getMatchingDownloadIds(itemId)) {
        send(id);
    }
}

function handleAppSocketEvent(event: AppSocketEvent): void {
    switch (event.type) {
        case 'app.connected':
            hideServerGoneModal();

            syncDownloadQueue(
                downloadQueue,
                event.downloads,
                groupSearchHaystacks,
                currentGroups
            );

            syncStorageCopies(storageCopies, event.storageCopies);
            markStorageCopiesComplete(event.storageCopies);
            syncStorageDeletes(storageDeletes, event.storageDeletes);
            markStorageDeletesComplete(event.storageDeletes);

            if (event.libraryValidationStatus) {
                handleAppSocketEvent(event.libraryValidationStatus);
            }
            return;

        case 'download.queueChanged':
            hideServerGoneModal();
            syncDownloadQueue(
                downloadQueue,
                event.items,
                groupSearchHaystacks,
                currentGroups
            );

            return;

        case 'storage.copyChanged':
            hideServerGoneModal();
            syncStorageCopies(storageCopies, event.items);
            markStorageCopiesComplete(event.items);
            return;

        case 'storage.deleteChanged':
            hideServerGoneModal();
            syncStorageDeletes(storageDeletes, event.items);
            markStorageDeletesComplete(event.items);
            return;

        case 'library.validationStatus': {
            hideServerGoneModal();
            validatingLibrary =
                event.status !== 'complete' && event.status !== 'failed';
            updateValidationButtonState();

            const message = formatValidationStatus(event);
            if (!message) {
                return;
            }

            libraryStatusMessage = message;
            libraryStatusTone =
                event.status === 'complete' && event.failed === 0
                    ? 'success'
                    : event.status === 'failed' ||
                        (event.status === 'complete' && event.failed !== 0)
                      ? 'error'
                      : 'info';

            updateLibraryStatusLine();
            return;
        }
    }
}

function scheduleAppSocketReconnect(): void {
    if (reconnectSocketTimer !== null) {
        return;
    }

    reconnectSocketTimer = window.setTimeout(() => {
        reconnectSocketTimer = null;

        if (
            appSocket &&
            (appSocket.readyState === WebSocket.OPEN ||
                appSocket.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        connectAppSocket();
    }, SOCKET_RECONNECT_MS);
}

function connectAppSocket(): void {
    if (
        appSocket &&
        (appSocket.readyState === WebSocket.OPEN ||
            appSocket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    appSocket = new WebSocket(getSocketUrl());

    appSocket.addEventListener('open', () => {
        hideServerGoneModal();
    });

    appSocket.addEventListener('message', (event: MessageEvent) => {
        try {
            const data = JSON.parse(String(event.data)) as AppSocketEvent;
            handleAppSocketEvent(data);
        } catch (error) {
            console.error(error);
        }
    });

    appSocket.addEventListener('close', () => {
        showServerGoneModal();
        scheduleAppSocketReconnect();
    });

    appSocket.addEventListener('error', () => {
        showServerGoneModal();
        scheduleAppSocketReconnect();
    });
}

function maybeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getAvailableSizeText(entry: unknown): string | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const sizeBytes = maybeNumber((entry as { sizeBytes?: unknown }).sizeBytes);
    return sizeBytes === null ? null : formatSize(sizeBytes);
}

export function getAvailableSizeBytes(entry: unknown): number | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    return maybeNumber((entry as { sizeBytes?: unknown }).sizeBytes);
}

function getActionBarSignature(): string {
    const visibleDownloads = downloadQueue.filter(
        (item) => item.state !== 'complete'
    );

    const visibleCopies = storageCopies.filter(
        (item) => item.state !== 'complete'
    );

    const visibleDeletes = storageDeletes.filter(
        (item) => item.state !== 'complete'
    );

    return JSON.stringify({
        downloads: visibleDownloads.map((item) => ({
            id: item.id,
            state: item.state,
        })),
        copies: visibleCopies.map((item) => ({
            id: item.id,
            state: item.state,
        })),
        deletes: visibleDeletes.map((item) => ({
            id: item.id,
            state: item.state,
        })),
    });
}

function updateActionBarRowsInPlace(): void {
    if (!actionBarRoot) {
        return;
    }

    for (const item of downloadQueue.filter(
        (item) => item.state !== 'complete'
    )) {
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
            state.textContent =
                item.state === 'downloading'
                    ? 'Active'
                    : item.state === 'queued'
                      ? 'Queued'
                      : item.state === 'failed'
                        ? 'Failed'
                        : 'Complete';
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

    for (const item of storageCopies.filter(
        (item) => item.state !== 'complete'
    )) {
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

    for (const item of storageDeletes) {
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
    if (!actionBarRoot) {
        return;
    }

    const visibleDownloads = downloadQueue.filter(
        (item) => item.state !== 'complete'
    );
    const visibleCopies = storageCopies.filter(
        (item) => item.state !== 'complete'
    );
    const visibleDeletes = storageDeletes.filter(
        (item) => item.state !== 'complete'
    );

    const isEmpty =
        visibleDownloads.length === 0 &&
        visibleCopies.length === 0 &&
        visibleDeletes.length === 0;
    actionBarRoot.hidden = isEmpty;

    if (isEmpty) {
        if (actionBarSignature !== '') {
            actionBarSignature = '';
            actionBarRoot.replaceChildren();
        }

        return;
    }

    const nextSignature = getActionBarSignature();

    if (nextSignature === actionBarSignature) {
        updateActionBarRowsInPlace();

        return;
    }

    actionBarSignature = nextSignature;
    rebuildActionBar();
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

function rebuildActionBar(): void {
    if (!actionBarRoot) {
        return;
    }

    const incompleteDownloads = downloadQueue.filter(
        (item) => item.state !== 'complete'
    );
    const incompleteCopies = storageCopies.filter(
        (item) => item.state !== 'complete'
    );
    const visibleDeletes = storageDeletes.filter(
        (item) => item.state !== 'complete'
    );

    const activeCount =
        incompleteDownloads.filter((item) => item.state === 'downloading')
            .length +
        incompleteCopies.filter((item) => item.state === 'copying').length +
        visibleDeletes.filter((item) => item.state === 'deleting').length;
    const queuedCount =
        incompleteDownloads.filter((item) => item.state === 'queued').length +
        incompleteCopies.filter((item) => item.state === 'queued').length +
        visibleDeletes.filter((item) => item.state === 'queued').length;
    const failedCount =
        incompleteDownloads.filter((item) => item.state === 'failed').length +
        incompleteCopies.filter((item) => item.state === 'failed').length +
        visibleDeletes.filter((item) => item.state === 'failed').length;

    actionBarRoot.replaceChildren();

    if (
        incompleteDownloads.length === 0 &&
        incompleteCopies.length === 0 &&
        visibleDeletes.length === 0
    ) {
        return;
    }

    const summary = document.createElement('div');
    summary.className = 'action-bar-summary';

    const counts = document.createElement('div');
    counts.textContent = `Actions: ${activeCount} active, ${queuedCount} queued, ${failedCount} failed`;

    const current = document.createElement('div');
    current.className = 'action-bar-current';
    const visibleActionCount =
        incompleteDownloads.length +
        incompleteCopies.length +
        visibleDeletes.length;
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

    for (const item of incompleteDownloads) {
        details.append(renderDownloadActionRow(item));
    }

    for (const item of incompleteCopies) {
        details.append(renderStorageCopyActionRow(item));
    }

    for (const item of visibleDeletes) {
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

function mountActionBar(): void {
    if (actionBarRoot) {
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

        handleActionBarCommand(actionValue, itemId);
    });

    document.body.append(actionBarRoot);
    updateActionBar();
}

export function updateGroupStatusFromSlots(group: TitleGroup): void {
    const baseState = getGameBadgeState(group);
    const updateState = getSlotBadgeState(group, TitleKinds.Update);
    const dlcState = getSlotBadgeState(group, TitleKinds.DLC);

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

export function markSlotBadgeComplete(family: string, kind: TitleKinds): void {
    for (const badge of document.querySelectorAll<HTMLElement>(
        '.title-slot-badge'
    )) {
        if (badge.dataset.family !== family || badge.dataset.kind !== kind) {
            continue;
        }

        setSlotBadgeState(badge, 'complete');

        const marker = badge.querySelector<HTMLElement>(
            '.title-slot-badge-download'
        );

        if (marker) {
            marker.textContent = '';
            marker.hidden = true;
        }

        badge.dataset.downloadState = '';
    }
}

function setSlotBadgeState(badge: HTMLElement, state: SlotBadgeState): void {
    badge.classList.remove(
        'title-slot-badge-complete',
        'title-slot-badge-incomplete',
        'title-slot-badge-na',
        'title-slot-badge-unavailable',
        'title-slot-badge-unknown'
    );
    badge.classList.add(`title-slot-badge-${state}`);
}

function updateRenderedSlotBadge(
    root: HTMLElement,
    kind: TitleKinds,
    state: SlotBadgeState
): void {
    const badge = root.querySelector<HTMLElement>(
        `.title-slot-badge[data-kind="${CSS.escape(kind)}"]`
    );

    if (badge) {
        setSlotBadgeState(badge, state);
    }
}

export function updateRenderedTitleGroup(group: TitleGroup): void {
    const element = document.querySelector<HTMLElement>(
        `.title-group[data-family="${CSS.escape(group.family)}"]`
    );

    if (!element) {
        return;
    }

    element.classList.remove(
        'title-group-complete',
        'title-group-incomplete',
        'title-group-missing',
        'title-group-unavailable',
        'title-group-unknown'
    );

    element.classList.add(`title-group-${group.status}`);

    updateRenderedSlotBadge(element, TitleKinds.Base, getGameBadgeState(group));
    updateRenderedSlotBadge(
        element,
        TitleKinds.Update,
        getSlotBadgeState(group, TitleKinds.Update)
    );
    updateRenderedSlotBadge(
        element,
        TitleKinds.DLC,
        getSlotBadgeState(group, TitleKinds.DLC)
    );
}

export function refreshOpenDetailSidebarForGroup(group: TitleGroup): void {
    if (selectedFamily !== group.family) {
        return;
    }

    const body = document.querySelector<HTMLElement>('.title-detail-body');

    if (!body) {
        return;
    }

    body.replaceChildren(renderGroupDetailContent(group));
}

function getKindSortValue(kind: TitleKinds): number {
    switch (kind) {
        case TitleKinds.Base:
            return 0;
        case TitleKinds.Update:
            return 1;
        case TitleKinds.DLC:
            return 2;
        default:
            return 3;
    }
}

function renderDetailSection(title: string): HTMLElement {
    const heading = document.createElement('div');
    heading.className = 'title-detail-section';
    heading.textContent = title;
    return heading;
}

export function formatVersions(versions: number[]): string {
    return versions.length > 0
        ? versions.map((version) => `v${version}`).join(', ')
        : '';
}

function getEntry(
    group: TitleGroup,
    kinds: TitleKinds | readonly TitleKinds[]
): TitleEntry | null {
    const kindList = Array.isArray(kinds) ? kinds : [kinds];
    return group.entries.find((entry) => kindList.includes(entry.kind)) ?? null;
}

function isChildExpected(group: TitleGroup, childKind: ChildKind): boolean {
    return group.expectedChildren.includes(childKind);
}

function formatTooltip(group: TitleGroup): string {
    const parentEntry = getEntry(group, PARENT_KINDS);
    const updateEntry = getEntry(group, TitleKinds.Update);
    const dlcEntry = getEntry(group, TitleKinds.DLC);

    return [
        `Game: ${parentEntry ? `${formatSize(parentEntry.sizeBytes)} (${parentEntry.titleId})` : '-'}`,
        `Update: ${updateEntry ? `${formatSize(updateEntry.sizeBytes)} (${updateEntry.titleId})` : '-'}`,
        `DLC: ${dlcEntry ? `${formatSize(dlcEntry.sizeBytes)} (${dlcEntry.titleId})` : '-'}`,
    ].join('\n');
}

function getAvailableEntry(
    group: TitleGroup,
    kind: TitleKinds.Base | TitleKinds.Update | TitleKinds.DLC
): TitleGroup['availableEntries'][number] | null {
    return group.availableEntries.find((entry) => entry.kind === kind) ?? null;
}

function getGameBadgeState(group: TitleGroup): SlotBadgeState {
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

function getSlotBadgeState(
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

function renderSlotBadge(
    group: TitleGroup,
    label: TitleKinds,
    state: SlotBadgeState
): HTMLElement {
    const badge = document.createElement('div');
    badge.className = `title-slot-badge title-slot-badge-${state}`;
    badge.dataset.family = group.family;
    badge.dataset.kind = label;

    const text = document.createElement('span');
    text.textContent = label;

    const downloadMarker = document.createElement('span');
    downloadMarker.className = 'title-slot-badge-download';

    const downloadState = getDownloadState(downloadQueue, group.family, label);
    downloadMarker.textContent = formatDownloadIcon(downloadState);
    downloadMarker.hidden = downloadState === null;
    badge.dataset.downloadState = downloadState ?? '';

    badge.append(text, downloadMarker);
    return badge;
}

function renderVirtualConsoleBadge(group: TitleGroup): HTMLElement | null {
    const platform = getVirtualConsolePlatform(group.productCode);

    if (!platform) {
        return null;
    }

    const badge = document.createElement('div');
    badge.className = 'title-slot-badge title-slot-badge-vc';
    badge.textContent = platform.toString();
    badge.title = 'Virtual Console';

    return badge;
}

function renderGroupDetailContent(group: TitleGroup): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const summary = document.createElement('div');
    summary.className = 'title-detail-summary';

    const list = document.createElement('dl');
    list.className = 'title-detail-list';

    const metadata = group.details;
    list.append(
        renderDetailRow('TV Format', metadata?.tvFormat ?? null),
        renderDetailRow('Languages', metadata?.languages.join(', ') ?? null),
        renderDetailRow('Developer', metadata?.developer ?? null),
        renderDetailRow('Genre', metadata?.genre.join(', ') ?? null),
        renderDetailRow('Input', metadata ? formatInput(metadata) : null)
    );

    const bottom = document.createElement('div');
    bottom.className = 'title-detail-bottom';

    summary.append(list);
    fragment.append(summary);

    const synopsis = document.createElement('p');
    synopsis.className = 'title-detail-synopsis';
    synopsis.textContent = metadata?.synopsis?.replace(/\n+/g, '\n\n') ?? '';
    fragment.append(synopsis);

    const availability = document.createElement('div');
    availability.className = 'title-detail-availability';

    if (group.entries.length > 0) {
        const localList = document.createElement('div');
        localList.className = 'title-download-list';

        const localEntries = [...group.entries].sort(
            (a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind)
        );

        for (const entry of localEntries) {
            localList.append(renderDownloadedCopyRow(entry));
        }

        const actions = document.createElement('div');
        actions.className = 'title-download-actions title-storage-copy-actions';

        const destinationSelect = document.createElement('select');
        destinationSelect.className = 'title-storage-copy-destination';
        destinationSelect.disabled = true;
        const loadingOption = document.createElement('option');
        loadingOption.textContent = 'Loading FAT32 devices...';
        destinationSelect.append(loadingOption);

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.disabled = true;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';

        const updateDownloadedButtons = (): void => {
            const checkedCount = localList.querySelectorAll(
                '.title-storage-copy-checkbox:checked'
            ).length;

            copyButton.textContent =
                checkedCount === 0 ? 'Copy all to SD' : 'Copy selected to SD';
            deleteButton.textContent =
                checkedCount === 0 ? 'Delete all' : 'Delete selected';
        };

        updateDownloadedButtons();
        localList.addEventListener('change', updateDownloadedButtons);
        void populateFat32DeviceSelect(destinationSelect, copyButton);

        copyButton.addEventListener('click', () => {
            void (async () => {
                const hasSelection =
                    localList.querySelectorAll(
                        '.title-storage-copy-checkbox:checked'
                    ).length > 0;
                const titleIds = getSelectedDownloadedTitleIds(
                    localList,
                    hasSelection
                );
                const destination = destinationSelect.value;

                if (titleIds.length === 0 || !destination) {
                    return;
                }

                copyButton.disabled = true;
                try {
                    await Promise.all(
                        titleIds.map((titleId) => {
                            const params = new URLSearchParams({
                                titleId,
                                dest: destination,
                            });
                            return requestJson(`/api/storage/copy?${params}`);
                        })
                    );
                } finally {
                    copyButton.disabled = destinationSelect.disabled;
                }
            })();
        });

        deleteButton.addEventListener('click', () => {
            void (async () => {
                const hasSelection =
                    localList.querySelectorAll(
                        '.title-storage-copy-checkbox:checked'
                    ).length > 0;
                const titleIds = getSelectedDownloadedTitleIds(
                    localList,
                    hasSelection
                );

                if (titleIds.length === 0) {
                    return;
                }

                const titleCount = titleIds.length;
                const confirmed = window.confirm(
                    titleCount === 1
                        ? 'Delete this local title?'
                        : `Delete these ${titleCount} local titles?`
                );
                if (!confirmed) {
                    return;
                }

                deleteButton.disabled = true;
                try {
                    await Promise.all(
                        titleIds.map((titleId) => {
                            const params = new URLSearchParams({ titleId });
                            return requestJson(`/api/storage/delete?${params}`);
                        })
                    );
                } finally {
                    deleteButton.disabled = false;
                }
            })();
        });

        actions.append(destinationSelect, copyButton, deleteButton);

        const downloadedContent = document.createElement('div');
        downloadedContent.className =
            'title-download-content title-storage-copy-content';
        downloadedContent.append(localList, actions);

        availability.append(
            renderDetailSection('Downloaded'),
            downloadedContent
        );
    }

    const availableEntries = group.availableEntries
        .filter((entry) => !hasLocalEntry(group, entry.kind))
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));

    if (availableEntries.length > 0) {
        const availableList = document.createElement('div');
        availableList.className = 'title-download-list';

        for (const entry of availableEntries) {
            availableList.append(
                renderDownloadAvailabilityRow(downloadQueue, group, entry)
            );
        }

        const actions = document.createElement('div');
        actions.className = 'title-download-actions';

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        const updateDownloadButton = (): void => {
            const checkedCount = availableList.querySelectorAll(
                '.title-download-checkbox:checked'
            ).length;

            downloadButton.textContent =
                checkedCount === 0 ? 'Download all' : 'Download selected';
        };

        downloadButton.disabled = false;
        updateDownloadButton();

        availableList.addEventListener('change', updateDownloadButton);

        downloadButton.addEventListener('click', () => {
            const hasSelection =
                availableList.querySelectorAll(
                    '.title-download-checkbox:checked'
                ).length > 0;

            queueDownloads(
                downloadQueue,
                collectSelectedDownloads(availableList, hasSelection)
            );

            const body = document.querySelector('.title-detail-body');
            body?.replaceChildren(renderGroupDetailContent(group));
        });

        actions.append(downloadButton);
        const availableContent = document.createElement('div');
        availableContent.className = 'title-download-content';

        availableContent.append(availableList, actions);

        availability.append(renderDetailSection('Available'), availableContent);
    }

    bottom.append(availability);
    fragment.append(bottom);

    return fragment;
}

function closeDetailSidebar(sidebar: HTMLElement): void {
    selectedFamily = null;
    sidebar.hidden = true;
    document.body.removeAttribute('data-detail-open');
    sidebar.querySelector('.title-detail-body')?.replaceChildren();

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

function resetDetailSidebars(): void {
    selectedFamily = null;
    document.body.removeAttribute('data-detail-open');

    for (const sidebar of document.querySelectorAll<HTMLElement>(
        '.title-detail-sidebar'
    )) {
        sidebar.hidden = true;
        sidebar.querySelector('.title-detail-body')?.replaceChildren();
    }

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

function showDetailSidebar(sidebar: HTMLElement, group: TitleGroup): void {
    selectedFamily = group.family;
    sidebar.hidden = false;
    document.body.setAttribute('data-detail-open', '');

    const title = sidebar.querySelector('.title-detail-title');
    if (title) {
        title.textContent = group.name;
    }

    const thumbnail = sidebar.querySelector<HTMLElement>(
        '.title-detail-thumbnail'
    );
    if (thumbnail) {
        thumbnail.replaceChildren();

        if (group.iconUrl) {
            const image = document.createElement('img');
            image.src = group.iconUrl;
            image.alt = group.name;
            thumbnail.append(image);
        }
    }

    const body = sidebar.querySelector('.title-detail-body');
    body?.replaceChildren(renderGroupDetailContent(group));

    for (const groupElement of document.querySelectorAll('.title-group')) {
        groupElement.toggleAttribute(
            'data-selected',
            groupElement.getAttribute('data-family') === group.family
        );
    }
}

function toggleDetailSidebar(sidebar: HTMLElement, group: TitleGroup): void {
    if (selectedFamily === group.family) {
        closeDetailSidebar(sidebar);
        return;
    }

    showDetailSidebar(sidebar, group);
}

function buildDetailSidebar(): HTMLElement {
    const sidebar = document.createElement('aside');
    sidebar.className = 'title-detail-sidebar';
    sidebar.hidden = true;
    sidebar.setAttribute('aria-label', 'Title details');

    const header = document.createElement('div');
    header.className = 'title-detail-sidebar-header';

    const thumbnail = document.createElement('div');
    thumbnail.className = 'title-detail-thumbnail';

    const title = document.createElement('h2');
    title.className = 'title-detail-title';
    title.textContent = 'Title details';

    const closeButton = document.createElement('button');
    closeButton.className = 'title-detail-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close title details');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => closeDetailSidebar(sidebar));

    const body = document.createElement('div');
    body.className = 'title-detail-body';

    header.append(thumbnail, title, closeButton);
    sidebar.append(header, body);

    return sidebar;
}

function renderGroup(
    group: TitleGroup,
    onSelect: (group: TitleGroup) => void
): HTMLElement | null {
    if (!group.name) {
        return null;
    }

    const status = group.status;

    const root = document.createElement('div');
    root.className = `title-group title-group-${status}`;
    root.dataset.family = group.family;
    root.title = formatTooltip(group);
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', `Show details for ${group.name}`);

    if (group.family === selectedFamily) {
        root.setAttribute('data-selected', '');
    }

    if (group.iconUrl) {
        const image = document.createElement('img');
        image.className = 'title-icon';
        image.dataset.src = group.iconUrl;
        image.alt = group.name;
        image.loading = 'lazy';
        image.decoding = 'async';
        root.append(image);
        if (iconObserver) {
            iconObserver.observe(image);
        } else {
            image.src = group.iconUrl;
        }
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'title-icon-placeholder';
        root.append(placeholder);
    }

    const header = document.createElement('div');
    header.className = 'title-group-header';
    header.textContent = group.name;
    root.append(header);

    const badges = document.createElement('div');
    badges.className = 'title-slot-badges';

    const badgeList = document.createElement('div');
    badgeList.className = 'title-slot-badge-list';

    const virtualConsoleBadge = renderVirtualConsoleBadge(group);
    if (virtualConsoleBadge) {
        badgeList.append(virtualConsoleBadge);
    }
    badgeList.append(
        renderSlotBadge(group, TitleKinds.Base, getGameBadgeState(group)),
        renderSlotBadge(
            group,
            TitleKinds.Update,
            getSlotBadgeState(group, TitleKinds.Update)
        ),
        renderSlotBadge(
            group,
            TitleKinds.DLC,
            getSlotBadgeState(group, TitleKinds.DLC)
        )
    );

    badges.append(badgeList);

    if (group.region) {
        const formattedRegion = formatRegion(group.region);

        const regionParent = document.createElement('div');
        regionParent.className = 'title-region';

        const flag = document.createElement('span');
        flag.className = formattedRegion.class ?? '';
        flag.textContent = formattedRegion.flag;

        const region = document.createElement('span');
        region.className = 'region';
        region.textContent = formattedRegion.text;

        regionParent.append(flag, region);
        badges.append(regionParent);
    }

    root.append(badges);

    root.addEventListener('click', () => onSelect(group));
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(group);
        }
    });

    return root;
}

function normalizeSearchText(value: string | null | undefined): string {
    return (value ?? '').toLocaleLowerCase();
}

const groupSearchHaystacks = new WeakMap<TitleGroup, string>();

function getGroupSearchHaystack(group: TitleGroup): string {
    let haystack = groupSearchHaystacks.get(group);
    if (haystack === undefined) {
        const parts: (string | null)[] = [
            group.name,
            group.family,
            group.region,
        ];
        for (const entry of group.entries) {
            parts.push(
                entry.titleId,
                entry.titleName,
                entry.kind,
                entry.region
            );
        }
        haystack = parts.map(normalizeSearchText).join('\n');
        groupSearchHaystacks.set(group, haystack);
    }
    return haystack;
}

function groupMatchesSearch(group: TitleGroup, search: string): boolean {
    if (!search) {
        return true;
    }
    return getGroupSearchHaystack(group).includes(search);
}

function compareGroups(a: TitleGroup, b: TitleGroup): number {
    const options: Intl.CollatorOptions = { sensitivity: 'base' };
    return (
        a.name.localeCompare(b.name, undefined, options) ||
        (a.region ?? '').localeCompare(b.region ?? '', undefined, options)
    );
}

function collectRegions(groups: TitleGroup[]): string[] {
    const seen = new Set<string>();

    for (const group of groups) {
        if (group.region) {
            seen.add(group.region);
        }
    }

    return [...seen].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
}

function collectVirtualConsolePlatforms(
    groups: TitleGroup[]
): VirtualConsolePlatform[] {
    const seen = new Set<VirtualConsolePlatform>();

    for (const group of groups) {
        if (!group.productCode) {
            continue;
        }

        const platform = getVirtualConsolePlatform(group.productCode);
        if (platform) {
            seen.add(platform);
        }
    }

    return [...seen].sort((a, b) =>
        a.toString().localeCompare(b.toString(), undefined, {
            sensitivity: 'base',
        })
    );
}

function normalizeLibraryControlState(
    groups: TitleGroup[],
    controlState: LibraryControlState
): LibraryControlState {
    const regions = collectRegions(groups);
    const vcFilters: LibraryVcFilter[] = [
        'all',
        'vc',
        'non-vc',
        ...collectVirtualConsolePlatforms(groups),
    ];
    const region =
        controlState.region === 'all' || regions.includes(controlState.region)
            ? controlState.region
            : 'all';
    const vc = vcFilters.includes(controlState.vc) ? controlState.vc : 'all';

    return {
        ...controlState,
        region,
        vc,
    };
}

function renderGroups(
    allGroups: TitleGroup[],
    grid: HTMLDivElement,
    sidebar: HTMLElement,
    statusValue: TitleGroupStatus | 'all',
    regionValue: string,
    vcValue: LibraryVcFilter,
    searchValue: string
): void {
    currentGroups = allGroups;

    const normalizedSearch = normalizeSearchText(searchValue.trim());

    const filteredGroups = [...allGroups].filter((group) => {
        if (statusValue !== 'all' && group.status !== statusValue) {
            return false;
        }

        if (regionValue !== 'all' && group.region !== regionValue) {
            return false;
        }

        const vcPlatform = group.productCode
            ? getVirtualConsolePlatform(group.productCode)
            : null;
        if (vcValue === 'vc' && !vcPlatform) {
            return false;
        } else if (vcValue === 'non-vc' && vcPlatform) {
            return false;
        } else if (
            vcValue !== 'all' &&
            vcValue !== 'vc' &&
            vcValue !== 'non-vc' &&
            vcValue !== vcPlatform?.toString()
        ) {
            return false;
        }

        return groupMatchesSearch(group, normalizedSearch);
    });

    grid.replaceChildren();
    resetIconObserver();

    for (const group of filteredGroups) {
        const render = renderGroup(group, (selectedGroup) =>
            toggleDetailSidebar(sidebar, selectedGroup)
        );
        if (!render) {
            continue;
        }

        grid.append(render);
    }

    renderDownloadMarkers(downloadQueue);
}

function buildControls(
    groups: TitleGroup[],
    grid: HTMLDivElement,
    sidebar: HTMLElement,
    controlState: LibraryControlState,
    options: LibraryContentOptions = {}
): HTMLElement {
    const loading = options.loading ?? false;
    controlState = normalizeLibraryControlState(groups, controlState);
    const controls = document.createElement('div');
    controls.className = 'library-controls';

    const regionText = document.createElement('div');
    regionText.className = 'library-label library-label-region';
    regionText.textContent = 'Region';

    const statusText = document.createElement('div');
    statusText.className = 'library-label library-label-status';
    statusText.textContent = 'Status';

    const vcText = document.createElement('div');
    vcText.className = 'library-label library-label-vc';
    vcText.textContent = 'VC';

    const searchText = document.createElement('div');
    searchText.className = 'library-label library-label-search';
    searchText.textContent = 'Search';

    const titleText = document.createElement('div');
    titleText.className = 'library-label library-label-title';
    titleText.textContent = 'Titles';

    const regionSelect = document.createElement('select');
    regionSelect.className = 'library-select library-field-region';
    regionSelect.disabled = loading || groups.length === 0;

    const allRegionsOption = document.createElement('option');
    allRegionsOption.value = 'all';
    allRegionsOption.textContent = 'All';
    regionSelect.append(allRegionsOption);

    for (const region of collectRegions(groups)) {
        const option = document.createElement('option');
        option.value = region;
        option.textContent = region;
        regionSelect.append(option);
    }

    const statusSelect = document.createElement('select');
    statusSelect.className = 'library-select library-field-status';
    statusSelect.disabled = loading || groups.length === 0;

    const statusOptions: Array<{
        value: TitleGroupStatus | 'all';
        label: string;
    }> = [
        { value: 'all', label: 'All' },
        { value: 'complete', label: 'Complete' },
        { value: 'incomplete', label: 'Incomplete' },
        { value: 'missing', label: 'Missing' },
        { value: 'unavailable', label: 'Unavailable' },
        { value: 'unknown', label: 'Unknown' },
    ];

    for (const statusOption of statusOptions) {
        const option = document.createElement('option');
        option.value = statusOption.value;
        option.textContent = statusOption.label;
        statusSelect.append(option);
    }

    const vcSelect = document.createElement('select');
    vcSelect.className = 'library-select library-field-vc';
    vcSelect.disabled = loading || groups.length === 0;

    const vcOptions: Array<{
        value: LibraryVcFilter;
        label: string;
    }> = [
        { value: 'all', label: 'All' },
        { value: 'vc', label: 'VC only' },
        { value: 'non-vc', label: 'Non-VC' },
        ...collectVirtualConsolePlatforms(groups).map((platform) => ({
            value: platform,
            label: platform.toString(),
        })),
    ];

    for (const vcOption of vcOptions) {
        const option = document.createElement('option');
        option.value = vcOption.value;
        option.textContent = vcOption.label;
        vcSelect.append(option);
    }

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Name, title ID, or region';
    searchInput.className = 'library-search library-field-search';
    searchInput.disabled = loading || groups.length === 0;
    searchInput.value = controlState.search;

    const titleLabel = document.createElement('label');
    titleLabel.className = 'library-checkbox library-field-title';

    const titleCheckbox = document.createElement('input');
    titleCheckbox.type = 'checkbox';
    titleCheckbox.checked = showAllTitles;
    titleCheckbox.disabled = loading;

    const titleLabelText = document.createElement('span');
    titleLabelText.textContent = 'Show all';

    titleLabel.append(titleCheckbox, titleLabelText);

    const viewToggle = buildViewControl(grid);

    const refreshButton = document.createElement('button');
    refreshButton.className = 'library-field-refresh';
    refreshButton.type = 'button';
    refreshButton.title = 'Refresh library';
    refreshButton.setAttribute('aria-label', 'Refresh library');
    refreshButton.disabled = loading;

    const refreshIcon = document.createElement('i');
    refreshIcon.className = 'fa-solid fa-refresh';
    refreshButton.append(refreshIcon);

    const validateButton = document.createElement('button');
    validateButton.className = 'library-field-validate';
    validateButton.type = 'button';

    const validateIcon = document.createElement('i');
    validateButton.append(validateIcon);

    const settingsButton = document.createElement('button');
    settingsButton.className = 'library-field-settings';
    settingsButton.type = 'button';
    settingsButton.title = 'Open settings';
    settingsButton.setAttribute('aria-label', 'Open settings');

    const settingsIcon = document.createElement('i');
    settingsIcon.className = 'fa-solid fa-gear';
    settingsButton.append(settingsIcon);

    controls.append(
        regionText,
        statusText,
        vcText,
        searchText,
        titleText,
        regionSelect,
        statusSelect,
        vcSelect,
        searchInput,
        titleLabel,
        viewToggle,
        refreshButton,
        validateButton,
        settingsButton
    );

    regionSelect.value = controlState.region;
    statusSelect.value = controlState.status;
    vcSelect.value = controlState.vc;

    const update = (): void => {
        libraryControlState = {
            region: regionSelect.value,
            status: statusSelect.value as TitleGroupStatus | 'all',
            vc: vcSelect.value as LibraryVcFilter,
            search: searchInput.value,
        };

        renderGroups(
            groups,
            grid,
            sidebar,
            libraryControlState.status,
            libraryControlState.region,
            libraryControlState.vc,
            libraryControlState.search
        );
    };

    const refresh = (): void => {
        if (options.onRefresh) {
            void options.onRefresh();
        }
    };

    searchInput.addEventListener('input', update);
    regionSelect.addEventListener('change', update);
    statusSelect.addEventListener('change', update);
    vcSelect.addEventListener('change', update);

    titleCheckbox.addEventListener('change', () => {
        showAllTitles = titleCheckbox.checked;

        if (options.onRefresh) {
            refresh();
        }
    });

    refreshButton.addEventListener('click', () => {
        if (!refreshButton.disabled) {
            refresh();
        }
    });

    validateButton.addEventListener('click', () => {
        void (async () => {
            if (libraryLoading || validatingLibrary || groups.length === 0) {
                return;
            }

            validatingLibrary = true;
            updateValidationButtonState();

            libraryStatusMessage = 'Validating library...';
            libraryStatusTone = 'info';
            updateLibraryStatusLine();

            try {
                const result = await requestJson<{
                    status: 'ok' | 'failed';
                    total: number;
                    failed: number;
                }>('/api/library/validate');

                libraryStatusMessage =
                    result.failed === 0
                        ? `Validation passed for ${result.total} titles.`
                        : `Validation failed for ${result.failed} of ${result.total} titles. Check the server logs for details.`;

                libraryStatusTone = result.failed === 0 ? 'success' : 'error';
            } catch (error) {
                console.error(error);
                libraryStatusMessage = 'Failed to validate library.';
                libraryStatusTone = 'error';
            } finally {
                validatingLibrary = false;
                updateValidationButtonState();
                updateLibraryStatusLine();
            }
        })();
    });

    settingsButton.addEventListener('click', () => {
        openSettingsSidebar();
    });

    if (!loading && groups.length > 0) {
        update();
    }

    return controls;
}

function buildViewControl(grid: HTMLDivElement): HTMLDivElement {
    const viewToggle = document.createElement('div');
    viewToggle.className = 'library-view-toggle library-field-view';
    viewToggle.setAttribute('role', 'group');
    viewToggle.setAttribute('aria-label', 'Library view');

    const tableViewButton = document.createElement('button');
    tableViewButton.type = 'button';
    tableViewButton.className = 'library-view-button';
    tableViewButton.title = 'Table view';
    tableViewButton.setAttribute('aria-label', 'Table view');

    const tableIcon = document.createElement('i');
    tableIcon.className = 'fa-solid fa-table';
    tableViewButton.append(tableIcon);

    const listViewButton = document.createElement('button');
    listViewButton.type = 'button';
    listViewButton.className = 'library-view-button';
    listViewButton.title = 'List view';
    listViewButton.setAttribute('aria-label', 'List view');

    const listIcon = document.createElement('i');
    listIcon.className = 'fa-solid fa-list';
    listViewButton.append(listIcon);

    tableViewButton.addEventListener('click', () => {
        applyViewMode('table');
        saveViewMode('table');
    });

    listViewButton.addEventListener('click', () => {
        applyViewMode('list');
        saveViewMode('list');
    });

    viewToggle.append(tableViewButton, listViewButton);

    const applyViewMode = (viewMode: LibraryViewMode): void => {
        grid.dataset.view = viewMode;
        tableViewButton.dataset.active = String(viewMode === 'table');
        listViewButton.dataset.active = String(viewMode === 'list');
        tableViewButton.setAttribute(
            'aria-pressed',
            String(viewMode === 'table')
        );
        listViewButton.setAttribute(
            'aria-pressed',
            String(viewMode === 'list')
        );
    };

    applyViewMode(getViewMode());

    return viewToggle;
}

function buildLibraryContent(
    groups: TitleGroup[],
    controlState: LibraryControlState,
    options: LibraryContentOptions = {}
): DocumentFragment {
    const loading = options.loading ?? false;
    const fragment = document.createDocumentFragment();

    const grid = document.createElement('div');
    grid.className = 'library-grid';

    const sidebar = buildDetailSidebar();

    const normalizedControlState = normalizeLibraryControlState(
        groups,
        controlState
    );
    const controls = buildControls(
        groups,
        grid,
        sidebar,
        normalizedControlState,
        options
    );

    const loadingLine = document.createElement('div');
    loadingLine.className = `library-loading library-loading-${loading ? 'info' : libraryStatusTone}`;
    loadingLine.textContent = loading ? 'Loading...' : libraryStatusMessage;
    loadingLine.setAttribute('role', 'status');
    loadingLine.setAttribute('aria-live', 'polite');

    fragment.append(controls, loadingLine, grid, sidebar);

    return fragment;
}

function updateValidationButtonState(): void {
    const validateButton = document.querySelector<HTMLButtonElement>(
        '.library-field-validate'
    );
    const validateIcon = validateButton?.querySelector<HTMLElement>('i');

    if (!validateButton || !validateIcon) {
        return;
    }

    validateButton.title = validatingLibrary
        ? 'Validating library'
        : 'Validate library';
    validateButton.setAttribute(
        'aria-label',
        validatingLibrary ? 'Validating library' : 'Validate library'
    );
    validateButton.setAttribute('aria-busy', String(validatingLibrary));
    validateButton.disabled =
        libraryLoading || validatingLibrary || currentGroups.length === 0;
    validateIcon.className = validatingLibrary
        ? 'fa-solid fa-spinner fa-spin'
        : 'fa-solid fa-check-double';
}

function updateLibraryStatusLine(): void {
    const loadingLine =
        document.querySelector<HTMLDivElement>('.library-loading');

    if (!loadingLine) {
        return;
    }

    loadingLine.className = `library-loading library-loading-${libraryStatusTone}`;
    loadingLine.textContent = libraryStatusMessage;
}

async function loadLibrary(output: HTMLElement): Promise<void> {
    const requestId = ++activeLibraryRequestId;
    const nextControlState = { ...libraryControlState };

    libraryLoading = true;
    resetDetailSidebars();

    output.replaceChildren(
        buildLibraryContent([], nextControlState, {
            loading: true,
        })
    );

    updateValidationButtonState();

    try {
        const data = await requestJson<LibraryResponse>(
            showAllTitles ? '/api/library?includeAll=true' : '/api/library'
        );

        if (requestId !== activeLibraryRequestId) {
            return;
        }

        for (const group of data.groups) {
            group.entries.sort((a, b) => b.version - a.version);
            updateGroupStatusFromSlots(group);
        }

        const groups = [...data.groups].sort(compareGroups);
        libraryControlState = normalizeLibraryControlState(
            groups,
            nextControlState
        );

        output.replaceChildren(
            buildLibraryContent(groups, libraryControlState, {
                loading: false,
                onRefresh: () => loadLibrary(output),
            })
        );

        updateValidationButtonState();
    } catch (error) {
        if (requestId !== activeLibraryRequestId) {
            return;
        }

        console.error(error);

        output.replaceChildren();

        const message = document.createElement('div');
        message.textContent = 'Failed to load library.';
        output.append(message);
    } finally {
        if (requestId === activeLibraryRequestId) {
            libraryLoading = false;
            updateValidationButtonState();
        }
    }
}

async function refreshLibrary(): Promise<void> {
    const output = document.querySelector<HTMLElement>('#output');

    if (!output) {
        throw new Error('Missing #output');
    }

    await loadLibrary(output);
}

function buildSettingsRootRow(value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'settings-root-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-input settings-root-input';
    input.value = value;

    const checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'settings-button settings-root-check';
    checkButton.textContent = 'Check';
    checkButton.disabled = settingsCheckingRoot;
    checkButton.addEventListener('click', () => {
        void (async () => {
            if (settingsCheckingRoot) {
                return;
            }

            const root = input.value.trim();
            settingsCheckingRoot = true;
            updateSettingsStatus(`Checking ${root || 'path'}...`);
            renderSettingsSidebar();

            try {
                const result = await requestJson<AppConfigValidateRootResponse>(
                    '/api/config/validate-root',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ root }),
                    }
                );
                updateSettingsStatus(
                    result.message,
                    result.readable ? 'success' : 'error'
                );
            } catch (error) {
                console.error(error);
                updateSettingsStatus('Failed to validate path.', 'error');
            } finally {
                settingsCheckingRoot = false;
                renderSettingsSidebar();
            }
        })();
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'settings-icon-button';
    removeButton.setAttribute('aria-label', 'Remove Wii U root');
    removeButton.innerHTML = '<i class="fa-solid fa-minus"></i>';
    removeButton.addEventListener('click', () => row.remove());

    row.append(input, checkButton, removeButton);
    return row;
}

function readSettingsForm(sidebar: HTMLElement): AppConfig {
    const hostInput = sidebar.querySelector<HTMLInputElement>(
        '.settings-input-host'
    );
    const portInput = sidebar.querySelector<HTMLInputElement>(
        '.settings-input-port'
    );
    const openBrowserInput = sidebar.querySelector<HTMLInputElement>(
        '.settings-input-open-browser'
    );
    const rootInputs = sidebar.querySelectorAll<HTMLInputElement>(
        '.settings-root-input'
    );

    return {
        host: hostInput?.value.trim() ?? '',
        port: Number(portInput?.value ?? 0),
        openBrowser: openBrowserInput?.checked ?? false,
        wiiuRoots: [...rootInputs]
            .map((input) => input.value.trim())
            .filter((value) => value.length > 0),
    };
}

async function loadSettingsConfig(): Promise<void> {
    settingsLoading = true;
    updateSettingsStatus('Loading settings...');

    try {
        const result = await requestJson<AppConfigResponse>('/api/config');
        settingsConfig = result.config;
        settingsStatusMessage = '';
        settingsStatusTone = 'info';
    } catch (error) {
        console.error(error);
        settingsStatusMessage = 'Failed to load settings.';
        settingsStatusTone = 'error';
    } finally {
        settingsLoading = false;
        renderSettingsSidebar(false);
    }
}

async function saveSettingsConfig(sidebar: HTMLElement): Promise<void> {
    if (settingsSaving) {
        return;
    }

    const nextConfig = readSettingsForm(sidebar);
    const previousRoots = JSON.stringify(settingsConfig?.wiiuRoots ?? []);
    const nextRoots = JSON.stringify(nextConfig.wiiuRoots);

    settingsSaving = true;
    updateSettingsStatus('Saving settings...');

    try {
        const result = await requestJson<AppConfigResponse>('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(nextConfig),
        });
        settingsConfig = result.config;
        settingsStatusMessage = result.restartRequired
            ? 'Settings saved. Restart required for host/port changes.'
            : 'Settings saved.';
        settingsStatusTone = 'success';

        if (previousRoots !== nextRoots) {
            void refreshLibrary();
        }
    } catch (error) {
        console.error(error);
        settingsStatusMessage = 'Failed to save settings.';
        settingsStatusTone = 'error';
    } finally {
        settingsSaving = false;
        renderSettingsSidebar(false);
    }
}

function closeSettingsSidebar(): void {
    document.body.removeAttribute('data-settings-open');
    renderSettingsSidebar();
}

function openSettingsSidebar(): void {
    document.body.setAttribute('data-settings-open', '');
    renderSettingsSidebar();

    if (!settingsLoading) {
        void loadSettingsConfig();
    }
}

function buildSettingsServerSection(config: AppConfig): HTMLElement {
    const serverSection = document.createElement('section');
    serverSection.className = 'settings-section';

    const serverTitle = document.createElement('h3');
    serverTitle.className = 'settings-section-title';
    serverTitle.textContent = 'Server';

    const hostField = document.createElement('label');
    hostField.className = 'settings-field';
    const hostLabel = document.createElement('span');
    hostLabel.className = 'settings-label';
    hostLabel.textContent = 'Host';
    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.className = 'settings-input settings-input-host';
    hostInput.value = config.host;
    hostField.append(hostLabel, hostInput);

    const portField = document.createElement('label');
    portField.className = 'settings-field';
    const portLabel = document.createElement('span');
    portLabel.className = 'settings-label';
    portLabel.textContent = 'Port';
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.className = 'settings-input settings-input-port';
    portInput.value = String(config.port);
    portInput.min = '1';
    portInput.step = '1';
    portField.append(portLabel, portInput);

    const openBrowserLabel = document.createElement('label');
    openBrowserLabel.className = 'settings-checkbox';
    const openBrowserInput = document.createElement('input');
    openBrowserInput.type = 'checkbox';
    openBrowserInput.className = 'settings-input-open-browser';
    openBrowserInput.checked = config.openBrowser;
    const openBrowserText = document.createElement('span');
    openBrowserText.textContent = 'Open browser on server start';
    openBrowserLabel.append(openBrowserInput, openBrowserText);

    const serverHelp = document.createElement('div');
    serverHelp.className = 'settings-help';
    serverHelp.textContent =
        'Host and port changes are saved immediately but require a restart.';

    serverSection.append(
        serverTitle,
        hostField,
        portField,
        openBrowserLabel,
        serverHelp
    );

    return serverSection;
}

function buildSettingsRootsSection(config: AppConfig): HTMLElement {
    const rootsSection = document.createElement('section');
    rootsSection.className = 'settings-section';

    const rootsTitle = document.createElement('h3');
    rootsTitle.className = 'settings-section-title';
    rootsTitle.textContent = 'Wii U Roots';

    const rootsHelp = document.createElement('div');
    rootsHelp.className = 'settings-help';
    rootsHelp.textContent =
        'Add one or more ROM roots. Check verifies that a path exists and is readable.';

    const rootsList = document.createElement('div');
    rootsList.className = 'settings-roots';

    for (const root of config.wiiuRoots) {
        rootsList.append(buildSettingsRootRow(root));
    }

    if (config.wiiuRoots.length === 0) {
        rootsList.append(buildSettingsRootRow(''));
    }

    const addRootButton = document.createElement('button');
    addRootButton.type = 'button';
    addRootButton.className = 'settings-button';
    addRootButton.textContent = 'Add root';
    addRootButton.disabled = settingsCheckingRoot;
    addRootButton.addEventListener('click', () => {
        rootsList.append(buildSettingsRootRow(''));
    });

    rootsSection.append(rootsTitle, rootsHelp, rootsList, addRootButton);
    return rootsSection;
}

function buildSettingsFooter(sidebar: HTMLElement): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'settings-footer';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'settings-button';
    cancelButton.textContent = 'Close';
    cancelButton.addEventListener('click', closeSettingsSidebar);

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'settings-button';
    saveButton.textContent = settingsSaving ? 'Saving...' : 'Save';
    saveButton.disabled = settingsSaving || settingsCheckingRoot;
    saveButton.addEventListener('click', () => {
        void saveSettingsConfig(sidebar);
    });

    footer.append(cancelButton, saveButton);
    return footer;
}

function renderSettingsSidebar(preserveDraft = true): void {
    if (!settingsRoot) {
        return;
    }

    const currentSidebar =
        settingsRoot.querySelector<HTMLElement>('.settings-sidebar');
    const hasSettingsInputs =
        currentSidebar?.querySelector('.settings-input-host') !== null;
    if (
        preserveDraft &&
        currentSidebar &&
        settingsConfig &&
        hasSettingsInputs
    ) {
        settingsConfig = readSettingsForm(currentSidebar);
    }

    settingsRoot.className = 'settings-root';
    settingsRoot.hidden = false;
    settingsRoot.dataset.open = String(isSettingsOpen());
    settingsRoot.replaceChildren();

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', closeSettingsSidebar);

    const sidebar = document.createElement('aside');
    sidebar.className = 'settings-sidebar';

    const header = document.createElement('div');
    header.className = 'settings-header';

    const title = document.createElement('h2');
    title.className = 'settings-title';
    title.textContent = 'Settings';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'settings-close';
    closeButton.setAttribute('aria-label', 'Close settings');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', closeSettingsSidebar);

    header.append(title, closeButton);

    const status = document.createElement('div');
    status.className = `settings-status settings-status-${settingsStatusTone}`;
    status.textContent = settingsStatusMessage;

    const form = document.createElement('div');
    form.className = 'settings-form';

    if (settingsConfig) {
        form.append(
            buildSettingsServerSection(settingsConfig),
            buildSettingsRootsSection(settingsConfig),
            buildSettingsFooter(sidebar)
        );
    }

    sidebar.append(header, status, form);
    settingsRoot.append(backdrop, sidebar);
}

function setupSidebars(): void {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
            return;
        }

        if (isSettingsOpen()) {
            closeSettingsSidebar();
            return;
        }

        if (selectedFamily !== null) {
            const detailSidebar = document.querySelector<HTMLElement>(
                '.title-detail-sidebar'
            );
            if (detailSidebar && !detailSidebar.hidden) {
                closeDetailSidebar(detailSidebar);
            }
        }
    });

    renderSettingsSidebar();
    resetDetailSidebars();
}

function setTheme(darkMode: boolean, save = false): void {
    const lightIcon = document.getElementById('theme-icon-light');
    const darkIcon = document.getElementById('theme-icon-dark');

    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';

    if (save) {
        localStorage.theme = document.documentElement.dataset.theme;
    }

    if (lightIcon) lightIcon.hidden = !darkMode;
    if (darkIcon) darkIcon.hidden = darkMode;
}

function setupTheme(): void {
    const prefers = window.matchMedia('(prefers-color-scheme: dark)');
    const savedTheme = localStorage.getItem('theme');

    setTheme(savedTheme ? savedTheme === 'dark' : prefers.matches);

    prefers.addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            setTheme(e.matches);
        }
    });

    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        setTheme(document.documentElement.dataset.theme !== 'dark', true);
    });
}

function setupVersion(): void {
    const version = document.querySelector<HTMLElement>('#app-version');
    if (version) {
        version.textContent = `v${__APP_VERSION__}`;
    }
}

function showServerGoneModal(): void {
    serverStatusModal?.removeAttribute('hidden');
}

function hideServerGoneModal(): void {
    serverStatusModal?.setAttribute('hidden', '');
}

async function loadInitialData(): Promise<void> {
    await Promise.all([getFat32Devices(), refreshLibrary()]);
}

window.addEventListener('pageshow', resetDetailSidebars);

mountActionBar();

connectAppSocket();

setupSidebars();

setupVersion();
void setupTheme();

void loadInitialData();
