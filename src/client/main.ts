import {
    getLibrary,
    listFat32Volumes,
    queueLibraryConvert,
    queueStorageCopy,
    verifyLibrary,
} from './api.js';
import { type StorageFat32ListResponse } from '../shared/api.js';
import {
    type LibraryConvertItem,
    type SocketEvent,
    type TitleValidationSocketEvent,
    type LibraryVerifyEvent,
    APP_SOCKET_EVENT,
    DOWNLOAD_SOCKET_EVENT,
    LIBRARY_CONVERT_SOCKET_EVENT,
    LIBRARY_VERIFY_SOCKET_EVENT,
    STORAGE_COPY_SOCKET_EVENT,
    STORAGE_DELETE_SOCKET_EVENT,
    TITLE_VALIDATE_SOCKET_EVENT,
    TITLE_VALIDATE_SOCKET_COMMAND,
} from '../shared/socket.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
} from '../shared/storage.js';
import { identifyTitle, type TitleGroup } from '../shared/titles.js';
import { type DownloadQueueItem } from '../shared/download.js';
import { formatSize } from '../shared/utils.js';
import { type Fat32Volume, type RuntimeOs } from '../shared/os/types.js';
import { isWindowsPath } from '../shared/os/path.js';
import {
    addAvailableEntry,
    createAvailableEntry,
    isTitleValidationUnavailable,
    mergeFailedVerificationsIntoAvailable,
    removeTitlesFromLibrary,
    syncLibraryVerifyActions,
    syncGroupStatusFromSlots,
} from './library.js';
import { connectAppSocket, sendAppSocketCommand } from './app-socket.js';
import { syncDownloadQueue } from './download.js';
import { syncStorageCopies, syncStorageDeletes } from './storage.js';
import {
    compareTitleGroups,
    getCurrentTitleGroups,
    invalidateTitleSearch,
    renderTitles,
    renderTitlesError,
    setTitlesStatus,
    titleSearchHaystacks,
} from './titles.js';
import {
    refreshActionBar,
    refreshActionsAndSelectedSidebar,
    refreshDetailSidebarForGroup,
    refreshTitleGroupUi,
    resetUiDetailSidebars,
    setupUi,
} from './ui.js';

declare const __APP_VERSION__: string;
const SOCKET_RECONNECT_MS = 2000;

let fat32ListPromise: Promise<StorageFat32ListResponse> | null = null;
const libraryVerifications: LibraryVerifyEvent[] = [];
const libraryConversions: LibraryConvertItem[] = [];
let verifyingLibrary = false;
let libraryLoading = false;
let activeLibraryRequestId = 0;
let allLibraryGroups: TitleGroup[] = [];
const downloadQueue: DownloadQueueItem[] = [];
const storageCopies: StorageCopyItem[] = [];
const storageDeletes: StorageDeleteItem[] = [];
const titleValidations = new Map<string, TitleValidationSocketEvent>();

function reconcileCompletedLibraryConversions(
    previousItems: Map<string, LibraryConvertItem>,
    items: LibraryConvertItem[]
): void {
    for (const item of items) {
        if (
            item.state !== 'complete' ||
            previousItems.get(item.id)?.state === 'complete' ||
            !item.convertedTitles
        ) {
            continue;
        }

        const family = identifyTitle(item.titleId)?.family;
        const group = getCurrentTitleGroups().find(
            (candidate) => candidate.family === family
        );
        if (!group) {
            continue;
        }

        for (const converted of item.convertedTitles) {
            const existing = group.entries.find(
                (entry) => entry.titleId === converted.titleId
            );
            if (existing) {
                existing.name = converted.name;
                existing.kind = converted.kind;
                existing.version = converted.version;
                existing.sizeBytes = converted.sizeBytes;
            } else {
                group.entries.push({
                    platform: group.platform,
                    ...converted,
                    region: group.region,
                    iconUrl: group.iconUrl,
                    bannerUrl: group.bannerUrl,
                    copyCount: 1,
                });
            }

            group.availableEntries = group.availableEntries.filter(
                (entry) => entry.titleId !== converted.titleId
            );
            titleValidations.delete(converted.titleId);
        }

        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
        invalidateTitleSearch(group);
        syncGroupStatusFromSlots(group);
        refreshTitleGroupUi(group);
    }
}

const serverStatusModal = document.querySelector<HTMLDivElement>(
    '#server-status-modal'
);

function isWindowsOnlyFat32Volume(
    volume: Fat32Volume,
    runtimeOs: RuntimeOs
): boolean {
    return runtimeOs === 'wsl2' && isWindowsPath(volume.source);
}

function formatFat32VolumeOption(
    volume: Fat32Volume,
    runtimeOs: RuntimeOs
): string {
    if (isWindowsOnlyFat32Volume(volume, runtimeOs)) {
        return `${volume.source} (Windows only)`;
    }

    const label = volume.label ? `${volume.label} - ` : '';
    const size =
        volume.freeBytes === null
            ? ''
            : ` (${formatSize(volume.freeBytes)} free)`;
    return `${label}${volume.source}${size}`;
}

async function getFat32Devices(): Promise<StorageFat32ListResponse> {
    if (fat32ListPromise) {
        return fat32ListPromise;
    }

    const request = listFat32Volumes();
    fat32ListPromise = request;
    try {
        return await request;
    } finally {
        if (fat32ListPromise === request) {
            fat32ListPromise = null;
        }
    }
}

async function populateFat32DeviceSelect(
    select: HTMLSelectElement,
    button: HTMLButtonElement
): Promise<StorageFat32ListResponse | null> {
    try {
        const response = await getFat32Devices();

        select.replaceChildren();
        for (const volume of response.volumes) {
            const isWindowsOnly = isWindowsOnlyFat32Volume(
                volume,
                response.runtimeOs
            );
            const option = document.createElement('option');
            option.value = isWindowsOnly ? '' : volume.source;
            option.textContent = formatFat32VolumeOption(
                volume,
                response.runtimeOs
            );
            option.disabled = isWindowsOnly;
            select.append(option);
        }

        const hasVolumes = response.volumes.length > 0;
        const hasUsableVolumes = response.volumes.some(
            (volume) => !isWindowsOnlyFat32Volume(volume, response.runtimeOs)
        );
        select.disabled = !hasVolumes;
        button.disabled = !hasUsableVolumes;

        if (hasUsableVolumes && !select.value) {
            select.value =
                response.volumes.find(
                    (volume) =>
                        !isWindowsOnlyFat32Volume(volume, response.runtimeOs)
                )?.source ?? '';
        }

        if (!hasVolumes) {
            const option = document.createElement('option');
            option.textContent = 'No FAT32 devices found';
            select.append(option);
        }

        return response;
    } catch {
        select.replaceChildren();
        const option = document.createElement('option');
        option.textContent = 'Failed to load FAT32 devices';
        select.append(option);
        select.disabled = true;
        button.disabled = true;
        return null;
    }
}

async function loadLibrary(
    options: { clearScanCache?: boolean } = {}
): Promise<void> {
    const requestId = ++activeLibraryRequestId;

    libraryLoading = true;
    setTitlesStatus({ loading: true });
    resetUiDetailSidebars();

    try {
        const data = await getLibrary(options);

        if (requestId !== activeLibraryRequestId) {
            return;
        }

        for (const group of data.groups) {
            group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
            syncGroupStatusFromSlots(group);
        }

        allLibraryGroups = [...data.groups].sort(compareTitleGroups);
        renderTitles(allLibraryGroups);
    } catch (error) {
        if (requestId !== activeLibraryRequestId) {
            return;
        }

        console.error(error);

        renderTitlesError('Failed to load library.');
    } finally {
        if (requestId === activeLibraryRequestId) {
            libraryLoading = false;
            setTitlesStatus({ loading: false });
        }
    }
}

async function verifyLibraryContent(): Promise<void> {
    if (
        libraryLoading ||
        verifyingLibrary ||
        getCurrentTitleGroups().length === 0
    ) {
        return;
    }

    verifyingLibrary = true;
    setTitlesStatus({ verifying: true });
    syncLibraryVerifyActions(libraryVerifications, {
        type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
        state: 'in-progress',
        reset: true,
    });
    refreshActionBar();

    try {
        const response = await verifyLibrary();
        if (response.status === 'cancelled') {
            return;
        }
        const changedGroups = mergeFailedVerificationsIntoAvailable(
            getCurrentTitleGroups(),
            response.titles
        );
        for (const group of changedGroups) {
            syncGroupStatusFromSlots(group);
            refreshTitleGroupUi(group);
        }
    } catch (error) {
        console.error(error);
        syncLibraryVerifyActions(libraryVerifications, {
            type: LIBRARY_VERIFY_SOCKET_EVENT.changed,
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
        });
        refreshActionBar();
    } finally {
        verifyingLibrary = false;
        setTitlesStatus({ verifying: false });
    }
}

async function refreshLibrary(
    options: { clearScanCache?: boolean } = {}
): Promise<void> {
    await loadLibrary(options);
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

function reconcileRemovedTitles(titleIds: string[]): void {
    removeTitlesFromLibrary(titleIds, {
        groups: getCurrentTitleGroups(),
        haystacks: titleSearchHaystacks,
        onGroupChanged: refreshTitleGroupUi,
    });
}

function syncLibraryConversions(items: LibraryConvertItem[]): void {
    const previousItems = new Map(
        libraryConversions.map((item) => [item.id, item])
    );
    libraryConversions.splice(0, libraryConversions.length, ...items);
    refreshActionBar();
    reconcileCompletedLibraryConversions(previousItems, items);
}

function handleTitleValidation(event: TitleValidationSocketEvent): void {
    titleValidations.set(event.titleId, event);

    const family = identifyTitle(event.titleId)?.family;
    const group = getCurrentTitleGroups().find(
        (candidate) => candidate.family === family
    );
    if (!group) {
        return;
    }

    if (
        event.status === 'complete' &&
        event.copies.length > 0 &&
        !group.entries.some((entry) => entry.titleId === event.titleId)
    ) {
        const copy = event.copies[0];
        const wudTitle = group.wudEntries
            .flatMap((entry) => entry.titles)
            .find((title) => title.titleId === event.titleId);
        const kind = copy?.titleKind;
        if (kind) {
            group.entries.push({
                platform: group.platform,
                titleId: event.titleId,
                name: group.name,
                region: group.region,
                iconUrl: group.iconUrl,
                bannerUrl: group.bannerUrl,
                version: copy?.titleVersion ?? wudTitle?.version ?? 0,
                kind,
                sizeBytes: 0,
                copyCount: event.copies.length,
            });
            invalidateTitleSearch(group);
            syncGroupStatusFromSlots(group);
            refreshTitleGroupUi(group);
        }
    }

    if (isTitleValidationUnavailable(event)) {
        const entry = group.entries.find(
            (candidate) => candidate.titleId === event.titleId
        );

        if (entry) {
            const availableEntry = createAvailableEntry(entry);
            if (availableEntry) {
                addAvailableEntry(group, availableEntry);
            }
        }
    }

    refreshDetailSidebarForGroup(group);
}

function handleAppEvent(event: SocketEvent): void {
    hideServerGoneModal();

    switch (event.type) {
        case APP_SOCKET_EVENT.connected:
            syncDownloadQueue(
                downloadQueue,
                event.downloads,
                titleSearchHaystacks,
                getCurrentTitleGroups(),
                refreshTitleGroupUi
            );
            reconcileRemovedTitles(
                syncStorageCopies(storageCopies, event.storageCopies)
            );
            reconcileRemovedTitles(
                syncStorageDeletes(storageDeletes, event.storageDeletes)
            );
            libraryVerifications.splice(0);
            for (const verification of event.libraryVerifyEvents) {
                syncLibraryVerifyActions(libraryVerifications, verification);
            }
            titleValidations.clear();
            for (const validation of event.titleValidations) {
                handleTitleValidation(validation);
            }
            syncLibraryConversions(event.libraryConversions);
            refreshActionsAndSelectedSidebar();
            return;

        case DOWNLOAD_SOCKET_EVENT.changed:
            syncDownloadQueue(
                downloadQueue,
                event.items,
                titleSearchHaystacks,
                getCurrentTitleGroups(),
                refreshTitleGroupUi
            );
            refreshActionsAndSelectedSidebar();
            return;

        case STORAGE_COPY_SOCKET_EVENT.changed:
            reconcileRemovedTitles(
                syncStorageCopies(storageCopies, event.items)
            );
            refreshActionsAndSelectedSidebar();
            return;

        case STORAGE_DELETE_SOCKET_EVENT.changed:
            reconcileRemovedTitles(
                syncStorageDeletes(storageDeletes, event.items)
            );
            refreshActionsAndSelectedSidebar();
            return;

        case LIBRARY_VERIFY_SOCKET_EVENT.changed:
            verifyingLibrary = event.state === 'in-progress';
            setTitlesStatus({ verifying: verifyingLibrary });
            syncLibraryVerifyActions(libraryVerifications, event);
            refreshActionBar();
            return;

        case LIBRARY_CONVERT_SOCKET_EVENT.changed:
            syncLibraryConversions(event.items);
            refreshActionsAndSelectedSidebar();
            return;

        case TITLE_VALIDATE_SOCKET_EVENT.changed:
            handleTitleValidation(event);
            return;
    }
}

connectAppSocket({
    reconnectMs: SOCKET_RECONNECT_MS,
    onAvailable: hideServerGoneModal,
    onGone: showServerGoneModal,
    onEvent: handleAppEvent,
});

setupUi({
    downloads: downloadQueue,
    storageCopies,
    storageDeletes,
    libraryVerifications,
    libraryConversions,
    titleValidations,
    onRefreshLibrary: refreshLibrary,
    onVerifyLibrary: verifyLibraryContent,
    queueStorageCopy,
    queueLibraryConvert,
    requestTitleValidation(titleId, name) {
        sendAppSocketCommand({
            type: TITLE_VALIDATE_SOCKET_COMMAND.queue,
            id: titleId,
            name,
        });
    },
    populateFat32DeviceSelect,
});

setupVersion();

void loadInitialData();
