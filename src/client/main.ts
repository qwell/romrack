import { getLibrary, listFat32Volumes, validateLibrary } from './api.js';
import { renderDownloadMarkers } from './download.js';
import { type StorageFat32ListResponse } from '../shared/api.js';
import {
    type LibraryConvertItem,
    type TitleValidationSocketEvent,
    type LibraryValidateStatusEvent,
    LIBRARY_VALIDATE_SOCKET_EVENT,
} from '../shared/socket.js';
import { type DeleteItem } from '../shared/delete.js';
import { type StorageCopyItem } from '../shared/storage.js';
import {
    createActionBarCommandHandler,
    mountActionBar,
    syncLibraryConvertActions,
    setLibraryValidateAction,
} from './actionbar.js';
import { type TitleGroup, TitleKinds } from '../shared/titles.js';
import { type DownloadQueueItem } from '../shared/download.js';
import { formatSize } from '../shared/shared.js';
import { type Fat32Volume, type RuntimeOs } from '../shared/os.js';
import { isWindowsPath } from '../shared/os/path.js';
import {
    addAvailableEntry,
    createAvailableEntry,
    syncGroupStatusFromSlots,
} from './library.js';
import {
    closeSettingsSidebar,
    isSettingsOpen,
    openSettingsSidebar,
    setupSettingsSidebar,
} from './settings.js';
import { connectAppSocket, createAppEventHandler } from './app-socket.js';
import {
    setupSidebar,
    mergeFailedValidationsIntoAvailable,
    isValidationFailed,
    closeDetailSidebar,
    getSelectedDetailFamily,
    hasOpenDetailFamily,
    refreshOpenDetailSidebarForGroup,
    resetDetailSidebars,
} from './sidebar.js';
import logger from '../shared/logger.js';
import {
    buildTitlesContent,
    compareTitleGroups,
    filterVisibleTitleGroups,
    getCurrentTitleGroups,
    invalidateTitleSearch,
    setTitlesStatus,
    setupTitles,
    titleSearchHaystacks,
    updateRenderedTitleGroup,
} from './titles.js';

declare const __APP_VERSION__: string;
const SOCKET_RECONNECT_MS = 2000;

let fat32ListPromise: Promise<StorageFat32ListResponse> | null = null;
const libraryValidations: LibraryValidateStatusEvent[] = [];
const libraryConversions: LibraryConvertItem[] = [];
let validatingLibrary = false;
let libraryLoading = false;
let activeLibraryRequestId = 0;
let allLibraryGroups: TitleGroup[] = [];
const downloadQueue: DownloadQueueItem[] = [];
const storageCopies: StorageCopyItem[] = [];
const deletes: DeleteItem[] = [];
const titleValidations = new Map<string, TitleValidationSocketEvent>();

function handleTitleGroupChanged(group: TitleGroup): void {
    updateRenderedTitleGroup(group);
    refreshOpenDetailSidebarForGroup(group);
}

function refreshSelectedDetailSidebar(): void {
    const selectedFamily = getSelectedDetailFamily();
    if (!selectedFamily) {
        return;
    }

    const group = getCurrentTitleGroups().find(
        (candidate) => candidate.family === selectedFamily
    );
    if (group) {
        refreshOpenDetailSidebarForGroup(group);
    }
}

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
        handleTitleGroupChanged(group);
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

async function loadLibrary(output: HTMLElement): Promise<void> {
    const requestId = ++activeLibraryRequestId;

    libraryLoading = true;
    setTitlesStatus({ loading: true });
    resetDetailSidebars();

    output.replaceChildren(
        buildTitlesContent(allLibraryGroups, [], { loading: true })
    );

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
        output.replaceChildren(
            buildTitlesContent(
                allLibraryGroups,
                filterVisibleTitleGroups(allLibraryGroups)
            )
        );
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
            setTitlesStatus({ loading: false });
        }
    }
}

async function validateLibraryContent(): Promise<void> {
    if (
        libraryLoading ||
        validatingLibrary ||
        getCurrentTitleGroups().length === 0
    ) {
        return;
    }

    validatingLibrary = true;
    setTitlesStatus({ validating: true });
    setLibraryValidateAction({
        type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
        state: 'in-progress',
        status: 'started',
    });

    try {
        const response = await validateLibrary();
        if (response.status === 'cancelled') return;
        const changedGroups = mergeFailedValidationsIntoAvailable(
            getCurrentTitleGroups(),
            response.titles
        );
        for (const group of changedGroups) {
            syncGroupStatusFromSlots(group);
            handleTitleGroupChanged(group);
        }
    } catch (error) {
        console.error(error);
        setLibraryValidateAction({
            type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
            state: 'failed',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        });
    } finally {
        validatingLibrary = false;
        setTitlesStatus({ validating: false });
    }
}

async function refreshLibrary(): Promise<void> {
    const output = document.querySelector<HTMLElement>('#output');

    if (!output) {
        throw new Error('Missing #output');
    }

    await loadLibrary(output);
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

        if (hasOpenDetailFamily()) {
            const detailSidebar =
                document.querySelector<HTMLElement>('.sidebar');
            if (detailSidebar && !detailSidebar.hidden) {
                closeDetailSidebar(detailSidebar);
            }
        }
    });

    setupSettingsSidebar(
        document.querySelector<HTMLElement>('#settings-root'),
        {
            onRootsChanged: () => {
                void refreshLibrary();
            },
        }
    );
    setupSidebar({
        downloads: downloadQueue,
        deletes,
        storageCopies,
        libraryConversions,
        titleValidations,
        populateFat32DeviceSelect,
    });
    setupTitles({
        downloads: downloadQueue,
        onRefresh: refreshLibrary,
        onValidate: validateLibraryContent,
        onOpenSettings: openSettingsSidebar,
        renderDownloadMarkers: () => renderDownloadMarkers(downloadQueue),
    });
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

mountActionBar({
    downloads: downloadQueue,
    storageCopies,
    deletes: deletes,
    libraryValidations,
    libraryConversions,
    onCommand: createActionBarCommandHandler({
        downloads: downloadQueue,
    }),
});

connectAppSocket({
    reconnectMs: SOCKET_RECONNECT_MS,
    onAvailable: hideServerGoneModal,
    onGone: showServerGoneModal,
    onEvent: createAppEventHandler({
        downloads: downloadQueue,
        storageCopies,
        deletes: deletes,
        haystacks: titleSearchHaystacks,
        getGroups: getCurrentTitleGroups,
        onServerAvailable: hideServerGoneModal,
        onGroupChanged: handleTitleGroupChanged,
        onValidationStateChanged(validating) {
            validatingLibrary = validating;
            setTitlesStatus({ validating });
        },
        onLibraryValidateChanged(event) {
            setLibraryValidateAction(event);
        },
        onLibraryConvertChanged(items) {
            const previousItems = new Map(
                libraryConversions.map((item) => [item.id, item])
            );
            syncLibraryConvertActions(items);
            reconcileCompletedLibraryConversions(previousItems, items);
        },
        onActionsChanged() {
            refreshSelectedDetailSidebar();
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

                refreshOpenDetailSidebarForGroup(group);
            }
        },
    }),
});

logger.log('client', 'Client initialized');

setupSidebars();

setupVersion();
void setupTheme();

void loadInitialData();
