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
    type TitleValidationSocketEvent,
    type LibraryVerifyStatusEvent,
    LIBRARY_VERIFY_SOCKET_EVENT,
    TITLE_VALIDATE_SOCKET_COMMAND,
} from '../shared/socket.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
} from '../shared/storage.js';
import { type TitleGroup, TitleKinds } from '../shared/titles.js';
import { type DownloadQueueItem } from '../shared/download.js';
import { formatSize } from '../shared/shared.js';
import { type Fat32Volume, type RuntimeOs } from '../shared/os.js';
import { isWindowsPath } from '../shared/os/path.js';
import {
    addAvailableEntry,
    createAvailableEntry,
    isValidationFailed,
    mergeFailedVerificationsIntoAvailable,
    syncLibraryVerifyActions,
    syncGroupStatusFromSlots,
} from './library.js';
import {
    connectAppSocket,
    createAppEventHandler,
    sendAppSocketCommand,
} from './app-socket.js';
import logger from '../shared/logger.js';
import {
    compareTitleGroups,
    getCurrentTitleGroups,
    invalidateTitleSearch,
    renderTitles,
    renderTitlesError,
    setTitlesStatus,
    titleSearchHaystacks,
    updateRenderedTitleGroup,
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
const libraryVerifications: LibraryVerifyStatusEvent[] = [];
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

        const group = getCurrentTitleGroups().find(
            (candidate) => candidate.family === item.titleId.slice(8)
        );
        if (!group) {
            continue;
        }

        for (const converted of item.convertedTitles) {
            const existing = group.entries.find(
                (entry) =>
                    entry.titleId.toLowerCase() ===
                    converted.titleId.toLowerCase()
            );
            if (existing) {
                existing.name = converted.name;
                existing.kind = converted.kind;
                existing.version = converted.version;
                existing.sizeBytes = converted.sizeBytes;
            } else {
                group.entries.push({
                    ...converted,
                    region: group.region,
                    iconUrl: group.iconUrl,
                    copyCount: 1,
                });
            }

            group.availableEntries = group.availableEntries.filter(
                (entry) =>
                    entry.titleId.toLowerCase() !==
                    converted.titleId.toLowerCase()
            );
            titleValidations.delete(converted.titleId);
        }

        group.entries.sort((a, b) => b.version - a.version);
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

function getFat32Devices(): Promise<StorageFat32ListResponse> {
    fat32ListPromise ??= listFat32Volumes().catch((error) => {
        fat32ListPromise = null;
        throw error;
    });

    return fat32ListPromise;
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

export function getPathDisplayName(value: string): string {
    const trimmed = value.replace(/[\\/]+$/, '');
    const name = trimmed.split(/[\\/]/).pop() || trimmed;
    return name.replace(/(?:\s+\[[^\]]+\])+$/g, '').trim() || name;
}

async function loadLibrary(): Promise<void> {
    const requestId = ++activeLibraryRequestId;

    libraryLoading = true;
    setTitlesStatus({ loading: true });
    resetUiDetailSidebars();

    try {
        const data = await getLibrary();

        if (requestId !== activeLibraryRequestId) {
            return;
        }

        for (const group of data.groups) {
            group.entries.sort((a, b) => b.version - a.version);
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
        type: LIBRARY_VERIFY_SOCKET_EVENT.status,
        state: 'in-progress',
        status: 'started',
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
            type: LIBRARY_VERIFY_SOCKET_EVENT.status,
            state: 'failed',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        });
        refreshActionBar();
    } finally {
        verifyingLibrary = false;
        setTitlesStatus({ verifying: false });
    }
}

async function refreshLibrary(): Promise<void> {
    await loadLibrary();
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

connectAppSocket({
    reconnectMs: SOCKET_RECONNECT_MS,
    onAvailable: hideServerGoneModal,
    onGone: showServerGoneModal,
    onEvent: createAppEventHandler({
        downloads: downloadQueue,
        storageCopies,
        storageDeletes: storageDeletes,
        haystacks: titleSearchHaystacks,
        getGroups: getCurrentTitleGroups,
        onServerAvailable: hideServerGoneModal,
        onGroupChanged: refreshTitleGroupUi,
        onVerificationStateChanged(verifying) {
            verifyingLibrary = verifying;
            setTitlesStatus({ verifying });
        },
        onLibraryVerifyChanged(event) {
            syncLibraryVerifyActions(libraryVerifications, event);
            refreshActionBar();
        },
        onLibraryConvertChanged(items) {
            const previousItems = new Map(
                libraryConversions.map((item) => [item.id, item])
            );
            libraryConversions.splice(0, libraryConversions.length, ...items);
            refreshActionBar();
            reconcileCompletedLibraryConversions(previousItems, items);
        },
        onActionsChanged() {
            refreshActionsAndSelectedSidebar();
        },
        onTitleValidationChanged(event) {
            titleValidations.set(event.titleId, event);

            const group = getCurrentTitleGroups().find(
                (candidate) => candidate.family === event.titleId.slice(8)
            );

            if (group) {
                if (
                    event.status === 'complete' &&
                    event.copies.length > 0 &&
                    !group.entries.some(
                        (entry) =>
                            entry.titleId.toLowerCase() ===
                            event.titleId.toLowerCase()
                    )
                ) {
                    const copy = event.copies[0];
                    const wudTitle = group.wudEntries
                        .flatMap((entry) => entry.titles)
                        .find(
                            (title) =>
                                title.titleId.toLowerCase() ===
                                event.titleId.toLowerCase()
                        );
                    const kind = copy?.titleKind as TitleKinds | undefined;
                    if (kind) {
                        group.entries.push({
                            titleId: event.titleId,
                            name: group.name,
                            region: group.region,
                            iconUrl: group.iconUrl,
                            version:
                                copy?.titleVersion ?? wudTitle?.version ?? 0,
                            kind,
                            sizeBytes: 0,
                            copyCount: event.copies.length,
                        });
                        invalidateTitleSearch(group);
                        syncGroupStatusFromSlots(group);
                        updateRenderedTitleGroup(group);
                    }
                }

                if (isValidationFailed(event)) {
                    const entry = group.entries.find(
                        (candidate) =>
                            candidate.titleId.toLowerCase() ===
                            event.titleId.toLowerCase()
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
        },
    }),
});

logger.log('client', 'Client initialized');

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
            titleId,
            name,
        });
    },
    populateFat32DeviceSelect,
});

setupVersion();

void loadInitialData();
