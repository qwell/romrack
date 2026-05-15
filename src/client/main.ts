import { renderDownloadMarkers } from './download.js';
import {
    getLibrary,
    listFat32Volumes,
    type Fat32ListResponse,
    validateLibrary,
} from './api.js';
import { createActionBarCommandHandler, mountActionBar } from './action-bar.js';
import {
    type TitleGroup,
    type TitleGroupStatus,
    getVirtualConsolePlatform,
    VirtualConsolePlatform,
} from '../shared/titles.js';
import {
    DownloadQueueItem,
    formatSize,
    StorageCopyItem,
    StorageDeleteItem,
} from '../shared/shared.js';
import { type Fat32Volume, type RuntimeOs } from '../shared/os.js';
import { isWindowsPath } from '../shared/os/path.js';
import { syncGroupStatusFromSlots } from './library-state.js';
import {
    closeSettingsSidebar,
    isSettingsOpen,
    openSettingsSidebar,
    setupSettingsSidebar,
} from './settings.js';
import {
    connectAppSocket,
    createAppEventHandler,
    type LibraryStatusTone,
} from './app-socket.js';
import {
    buildDetailSidebar,
    closeDetailSidebar,
    setupTitleDetails,
    hasOpenDetailFamily,
    renderGroup,
    resetDetailSidebars,
    toggleDetailSidebar,
    refreshOpenDetailSidebarForGroup,
    updateRenderedTitleGroup,
} from './title-detail.js';

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
const downloadQueue: DownloadQueueItem[] = [];
const storageCopies: StorageCopyItem[] = [];
const storageDeletes: StorageDeleteItem[] = [];

function handleTitleGroupChanged(group: TitleGroup): void {
    updateRenderedTitleGroup(group);
    refreshOpenDetailSidebarForGroup(group);
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

function getFat32Devices(): Promise<Fat32ListResponse> {
    fat32ListPromise ??= listFat32Volumes().catch((error) => {
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
    } catch {
        select.replaceChildren();
        const option = document.createElement('option');
        option.textContent = 'Failed to load FAT32 devices';
        select.append(option);
        select.disabled = true;
        button.disabled = true;
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
                const result = await validateLibrary();

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
        const data = await getLibrary(showAllTitles);

        if (requestId !== activeLibraryRequestId) {
            return;
        }

        for (const group of data.groups) {
            group.entries.sort((a, b) => b.version - a.version);
            syncGroupStatusFromSlots(group);
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
            const detailSidebar = document.querySelector<HTMLElement>(
                '.title-detail-sidebar'
            );
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
        populateFat32DeviceSelect,
        observeIcon(image, src) {
            if (iconObserver) {
                iconObserver.observe(image);
            } else {
                image.src = src;
            }
        },
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
    storageDeletes,
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
        storageDeletes,
        haystacks: groupSearchHaystacks,
        getGroups: () => currentGroups,
        onServerAvailable: hideServerGoneModal,
        onGroupChanged: handleTitleGroupChanged,
        onValidationStateChanged(validating) {
            validatingLibrary = validating;
            updateValidationButtonState();
        },
        onLibraryStatusChanged(message, tone) {
            libraryStatusMessage = message;
            libraryStatusTone = tone;
            updateLibraryStatusLine();
        },
    }),
});

setupSidebars();

setupVersion();
void setupTheme();

void loadInitialData();
