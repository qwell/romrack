import { renderDownloadMarkers } from './download.js';
import { getLibrary, listFat32Volumes, validateLibrary } from './api.js';
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
import {
    type TitleGroup,
    type TitleGroupStatus,
    TitleKinds,
    getVirtualConsolePlatform,
    VirtualConsolePlatform,
} from '../shared/titles.js';
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
    setupTitleDetails,
    renderGroup,
    updateRenderedTitleGroup,
    mergeFailedValidationsIntoAvailable,
    isValidationFailed,
    renderGroupDetailContent,
    requestTitleValidations,
} from './title-detail.js';
import {
    buildDetailSidebar,
    closeDetailSidebar,
    getSelectedDetailFamily,
    hasOpenDetailFamily,
    refreshOpenDetailSidebarForGroup,
    resetDetailSidebars,
    setupDetailSidebar,
    toggleDetailSidebar,
} from './sidebar.js';
import logger from '../shared/logger.js';

declare const __APP_VERSION__: string;
const SOCKET_RECONNECT_MS = 2000;

type LibraryViewMode = 'table' | 'list';
type LibraryVcFilter = 'all' | 'vc' | 'non-vc' | VirtualConsolePlatform;
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

let showAllTitles = false;
let currentGroups: TitleGroup[] = [];
let fat32ListPromise: Promise<StorageFat32ListResponse> | null = null;
let libraryControlState: LibraryControlState = {
    region: 'all',
    status: 'all',
    vc: 'all',
    search: '',
};
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

    const group = currentGroups.find(
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

        const group = currentGroups.find(
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
        groupSearchHaystacks.delete(group);
        syncGroupStatusFromSlots(group);
        handleTitleGroupChanged(group);
    }
}

let iconObserver: IntersectionObserver | null = null;

const serverStatusModal = document.querySelector<HTMLDivElement>(
    '#server-status-modal'
);

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

function maybeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getAvailableSizeText(entry: unknown): string {
    if (!entry || typeof entry !== 'object') {
        return '';
    }

    const sizeBytes = maybeNumber((entry as { sizeBytes?: unknown }).sizeBytes);
    return formatSize(sizeBytes);
}

export function getAvailableSizeBytes(entry: unknown): number | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    return maybeNumber((entry as { sizeBytes?: unknown }).sizeBytes);
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
            parts.push(entry.titleId, entry.name, entry.kind, entry.region);
        }
        for (const entry of group.wudEntries) {
            parts.push(
                ...entry.titles.map((title) => title.titleId),
                'WUD',
                entry.imageName
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
        if (
            !showAllTitles &&
            group.entries.length === 0 &&
            group.wudEntries.length === 0
        ) {
            return false;
        }

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

    let renderedCount = 0;
    const BATCH_SIZE = 50;

    const sentinel = document.createElement('div');
    sentinel.className = 'library-grid-sentinel';

    const firstBatch = filteredGroups.slice(0, BATCH_SIZE);
    const fragment = document.createDocumentFragment();
    for (const group of firstBatch) {
        const render = renderGroup(
            group,
            (selectedGroup) => toggleDetailSidebar(sidebar, selectedGroup),
            getSelectedDetailFamily()
        );
        if (render) fragment.append(render);
    }
    grid.append(fragment, sentinel);
    renderedCount = firstBatch.length;
    renderDownloadMarkers(downloadQueue);

    if (renderedCount >= filteredGroups.length) {
        sentinel.remove();
        return;
    }

    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;

                const fragment = document.createDocumentFragment();
                const next = filteredGroups.slice(
                    renderedCount,
                    renderedCount + BATCH_SIZE
                );

                for (const group of next) {
                    const render = renderGroup(
                        group,
                        (selectedGroup) =>
                            toggleDetailSidebar(sidebar, selectedGroup),
                        getSelectedDetailFamily()
                    );
                    if (render) fragment.append(render);
                }

                grid.insertBefore(fragment, sentinel);
                renderedCount += next.length;

                if (renderedCount >= filteredGroups.length) {
                    observer.disconnect();
                    sentinel.remove();
                }

                renderDownloadMarkers(downloadQueue);
            }
        },
        { rootMargin: '400px' }
    );

    observer.observe(sentinel);
}

function buildControls(
    allGroups: TitleGroup[],
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
            allGroups,
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
        update();
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
            const libraryValidate: LibraryValidateStatusEvent = {
                type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                state: 'in-progress',
                status: 'started',
            };
            setLibraryValidateAction(libraryValidate);
            updateValidationButtonState();

            try {
                const response = await validateLibrary();

                if (response.status === 'cancelled') {
                    return;
                }

                const changedGroups = mergeFailedValidationsIntoAvailable(
                    currentGroups,
                    response.titles
                );
                for (const group of changedGroups) {
                    syncGroupStatusFromSlots(group);
                    handleTitleGroupChanged(group);
                }
            } catch (error) {
                console.error(error);
                const libraryValidate: LibraryValidateStatusEvent = {
                    type: LIBRARY_VALIDATE_SOCKET_EVENT.status,
                    state: 'failed',
                    status: 'failed',
                    error:
                        error instanceof Error ? error.message : String(error),
                };
                setLibraryValidateAction(libraryValidate);
            } finally {
                validatingLibrary = false;
                updateValidationButtonState();
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
    allGroups: TitleGroup[],
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
        allGroups,
        groups,
        grid,
        sidebar,
        normalizedControlState,
        options
    );

    const loadingLine = document.createElement('div');
    loadingLine.className = 'library-loading library-loading-info';
    loadingLine.textContent = loading ? 'Loading...' : '';
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

async function loadLibrary(output: HTMLElement): Promise<void> {
    const requestId = ++activeLibraryRequestId;
    const nextControlState = { ...libraryControlState };

    libraryLoading = true;
    resetDetailSidebars();

    output.replaceChildren(
        buildLibraryContent(allLibraryGroups, [], nextControlState, {
            loading: true,
        })
    );

    updateValidationButtonState();

    try {
        const data = await getLibrary();

        if (requestId !== activeLibraryRequestId) {
            return;
        }

        for (const group of data.groups) {
            group.entries.sort((a, b) => b.version - a.version);
            syncGroupStatusFromSlots(group);
        }

        allLibraryGroups = [...data.groups].sort(compareGroups);
        const groups = allLibraryGroups.filter(
            (group) =>
                showAllTitles ||
                group.entries.length > 0 ||
                group.wudEntries.length > 0
        );

        libraryControlState = normalizeLibraryControlState(
            groups,
            nextControlState
        );

        output.replaceChildren(
            buildLibraryContent(allLibraryGroups, groups, libraryControlState, {
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
    setupTitleDetails({
        downloads: downloadQueue,
        deletes,
        storageCopies,
        libraryConversions,
        titleValidations,
        populateFat32DeviceSelect,
        observeIcon(image, src) {
            if (iconObserver) {
                iconObserver.observe(image);
            } else {
                image.src = src;
            }
        },
    });
    setupDetailSidebar({
        renderContent: renderGroupDetailContent,
        onShow: requestTitleValidations,
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
        haystacks: groupSearchHaystacks,
        getGroups: () => currentGroups,
        onServerAvailable: hideServerGoneModal,
        onGroupChanged: handleTitleGroupChanged,
        onValidationStateChanged(validating) {
            validatingLibrary = validating;
            updateValidationButtonState();
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

            const group = currentGroups.find(
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
                        groupSearchHaystacks.delete(group);
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
