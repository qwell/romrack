import { type DownloadQueueItem } from '../shared/download.js';
import { formatActionStateIcon } from '../shared/action.js';
import { formatSize } from '../shared/utils.js';
import {
    getTitleId,
    getVirtualConsolePlatform,
    TitlePlatform,
    type TitleGroup,
    type TitleGroupStatus,
    TitleKinds,
    VirtualConsolePlatform,
} from '../shared/titles.js';
import {
    getBaseBadgeState,
    getChildBadgeState,
    getEntry,
    type SlotBadgeState,
} from './library.js';

type TitlesViewMode = 'table' | 'list';
type TitlesVcFilter = 'all' | 'vc' | 'non-vc' | VirtualConsolePlatform;
type TitlesControlState = {
    region: string;
    status: TitleGroupStatus | 'all';
    vc: TitlesVcFilter;
    search: string;
};
type TitlesOptions = {
    downloads: DownloadQueueItem[];
    onRefresh: (options?: { clearScanCache?: boolean }) => void | Promise<void>;
    onVerify: () => void | Promise<void>;
    onOpenSettings: () => void;
    renderDownloadMarkers: () => void;
    buildDetailSidebar: () => HTMLElement;
    getSelectedDetailFamily: () => string | null;
    toggleDetailSidebar: (sidebar: HTMLElement, group: TitleGroup) => void;
};
const TITLE_GRID_MIN_COLUMN_WIDTH = 220;
const TITLE_GRID_ROW_HEIGHT = 124;
const TITLE_GRID_GAP = 8;
const TITLE_LIST_ROW_HEIGHT = 30;
const TITLE_LIST_GAP = 4;
const TITLE_VIRTUAL_OVERSCAN_ROWS = 3;

type VirtualTitleWindowState = {
    startIndex: number;
    endIndex: number;
    startRow: number;
    columns: number;
    totalHeight: number;
};

let options: TitlesOptions | null = null;
let showAllTitles = false;
let currentGroups: TitleGroup[] = [];
let virtualGroups: TitleGroup[] = [];
let controlState: TitlesControlState = {
    region: 'all',
    status: 'all',
    vc: 'all',
    search: '',
};
let loading = false;
let verifying = false;
let titlesGrid: HTMLDivElement | null = null;
let titlesSidebar: HTMLElement | null = null;
let loadingLine: HTMLDivElement | null = null;
let regionSelect: HTMLSelectElement | null = null;
let statusSelect: HTMLSelectElement | null = null;
let vcSelect: HTMLSelectElement | null = null;
let searchInput: HTMLInputElement | null = null;
let showAllInput: HTMLInputElement | null = null;
let refreshButton: HTMLButtonElement | null = null;
let verifyButton: HTMLButtonElement | null = null;
let virtualRenderFrame: number | null = null;
let virtualWindowState: VirtualTitleWindowState | null = null;
let titlesResizeObserver: ResizeObserver | null = null;

export const titleSearchHaystacks = new WeakMap<TitleGroup, string>();

export function setupTitles(nextOptions: TitlesOptions): void {
    options = nextOptions;
}

export function mountTitles(root: HTMLElement): void {
    titlesGrid = document.createElement('div');
    titlesGrid.className = 'library-grid';
    titlesGrid.addEventListener('scroll', scheduleVirtualTitleRender);
    titlesResizeObserver?.disconnect();
    titlesResizeObserver = new ResizeObserver(scheduleVirtualTitleRender);
    titlesResizeObserver.observe(titlesGrid);
    titlesSidebar =
        options?.buildDetailSidebar() ?? document.createElement('aside');
    const controls = buildControls(titlesGrid, titlesSidebar);
    loadingLine = document.createElement('div');
    loadingLine.className = 'library-loading';
    loadingLine.setAttribute('role', 'status');
    loadingLine.setAttribute('aria-live', 'polite');

    root.replaceChildren(controls, loadingLine, titlesGrid, titlesSidebar);
    updateTitlesControls();
    updateTitleActionButtons();
}

export function renderTitles(groups: TitleGroup[]): void {
    currentGroups = groups;
    updateTitlesControls();
    updateTitleActionButtons();

    if (titlesGrid && titlesSidebar) {
        renderGroups(currentGroups, titlesGrid, titlesSidebar);
    }
}

export function renderTitlesError(message: string): void {
    currentGroups = [];
    updateTitlesControls();
    updateTitleActionButtons();

    if (!titlesGrid) {
        return;
    }

    const error = document.createElement('div');
    error.textContent = message;
    titlesGrid.replaceChildren(error);
}

export function getCurrentTitleGroups(): TitleGroup[] {
    return currentGroups;
}

export function invalidateTitleSearch(group: TitleGroup): void {
    titleSearchHaystacks.delete(group);
}

export function compareTitleGroups(a: TitleGroup, b: TitleGroup): number {
    const collatorOptions: Intl.CollatorOptions = { sensitivity: 'base' };
    return (
        a.name.localeCompare(b.name, undefined, collatorOptions) ||
        (a.region ?? '').localeCompare(
            b.region ?? '',
            undefined,
            collatorOptions
        )
    );
}

function filterVisibleTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    return groups.filter(
        (group) =>
            showAllTitles ||
            group.entries.length > 0 ||
            group.wudEntries.length > 0
    );
}

export function setTitlesStatus(next: {
    loading?: boolean;
    verifying?: boolean;
}): void {
    loading = next.loading ?? loading;
    verifying = next.verifying ?? verifying;
    if (loadingLine) {
        loadingLine.textContent = loading ? 'Loading...' : '';
    }
    if (next.loading === true) {
        titlesGrid?.replaceChildren();
    }
    updateTitlesControls();
    updateTitleActionButtons();
}

function buildTitleIconPlaceholder(): HTMLDivElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'title-icon-placeholder';
    return placeholder;
}

function buildTitleIcon(src: string, alt: string): HTMLDivElement {
    const placeholder = buildTitleIconPlaceholder();
    const image = document.createElement('img');
    image.className = 'title-icon title-icon-loading';
    image.alt = alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('load', () => {
        image.classList.remove('title-icon-loading');
        placeholder.replaceWith(image);
    });
    image.addEventListener('error', () => {
        image.remove();
    });
    image.src = src;

    placeholder.append(image);
    return placeholder;
}

function formatRegion(region: string | null): {
    text: string;
    flag: string;
    class?: string;
} {
    const regions: Record<string, { flag: string; class?: string }> = {
        AUS: { flag: '🇦🇺' },
        CAN: { flag: '🇨🇦' },
        CHN: { flag: '🇨🇳' },
        CHT: { flag: '🇹🇼' },
        EUR: { flag: '🇪🇺' },
        FRA: { flag: '🇫🇷' },
        GER: { flag: '🇩🇪' },
        ITA: { flag: '🇮🇹' },
        JPN: { flag: '🇯🇵' },
        KOR: { flag: '🇰🇷' },
        MDE: { flag: '🌍' },
        RUS: { flag: '🇷🇺' },
        SPA: { flag: '🇪🇸' },
        TWN: { flag: '🇹🇼' },
        UKV: { flag: '🇬🇧' },
        UNK: { flag: '🏴‍☠️', class: 'arrr' },
        USA: { flag: '🇺🇸', class: 'distress' },
        ALL: { flag: '🌐' },
    };
    return {
        text: region ?? '',
        flag: regions[region ?? '']?.flag ?? '',
        class: regions[region ?? '']?.class,
    };
}

function formatTooltip(group: TitleGroup): string {
    const entry = getEntry(group, TitleKinds.Base);
    const lines = [
        `Title: ${getTitleId(group.platform, group.family, TitleKinds.Base)}`,
        `Product Code: ${group.productCode ?? '-'}`,
    ];

    switch (group.platform) {
        case 'wii': {
            lines.push(
                `Disc image: ${entry ? formatSize(entry.sizeBytes) : '-'}`
            );
            break;
        }

        case '3ds':
        case 'wiiu': {
            lines.push(...formatTitleContentTooltip(group));
            break;
        }
    }

    return lines.join('\n');
}

function formatTitleContentTooltip(group: TitleGroup): string[] {
    const parent = getEntry(group, TitleKinds.Base);
    const slots: Array<{
        label: string;
        kind: TitleKinds;
        entry: typeof parent;
    }> = [
        {
            label: 'Base',
            kind: TitleKinds.Base,
            entry: parent,
        },
        {
            label: 'Update',
            kind: TitleKinds.Update,
            entry: getEntry(group, TitleKinds.Update),
        },
        {
            label: 'DLC',
            kind: TitleKinds.DLC,
            entry: getEntry(group, TitleKinds.DLC),
        },
    ];
    const slotLines = slots
        .filter(
            ({ kind, entry }) =>
                entry ||
                group.availableEntries.some(
                    (available) =>
                        available.kind === kind && available.availableOnCdn
                )
        )
        .map(
            ({ label, entry }) =>
                `${label}: ${entry ? formatSize(entry.sizeBytes) : '-'}`
        );

    return slotLines;
}

function getDownloadState(group: TitleGroup, kind: TitleKinds) {
    return (
        options?.downloads.find(
            (item) =>
                item.family === group.family &&
                item.kind === kind &&
                item.state !== 'complete' &&
                item.state !== 'cancelled'
        )?.state ?? null
    );
}

function renderSlotBadge(
    group: TitleGroup,
    kind: TitleKinds,
    state: SlotBadgeState
): HTMLElement {
    const badge = document.createElement('div');
    badge.className = `title-slot-badge title-slot-badge-${state}`;
    badge.dataset.family = group.family;
    badge.dataset.kind = kind;

    const text = document.createElement('span');
    text.textContent = kind;
    const marker = document.createElement('span');
    marker.className = 'title-slot-badge-download';
    const downloadState = getDownloadState(group, kind);
    marker.textContent = formatActionStateIcon(downloadState, '↓');
    marker.hidden = downloadState === null;
    badge.dataset.downloadState = downloadState ?? '';
    badge.append(text, marker);
    return badge;
}

function renderPlatformBadge(group: TitleGroup): HTMLElement {
    const badge = document.createElement('div');
    badge.className = 'title-metadata-badge title-platform';
    badge.dataset.family = group.family;
    badge.dataset.platform = group.platform;

    badge.textContent = TitlePlatform[group.platform];

    return badge;
}

function renderVirtualConsoleBadge(group: TitleGroup): HTMLElement {
    const platform = getVirtualConsolePlatform(
        group.platform,
        group.productCode
    );
    const badge = document.createElement('div');
    badge.className = 'title-metadata-badge title-vc';

    if (platform) {
        badge.textContent = platform;
        badge.title = 'Virtual Console';
    } else {
        badge.classList.add('title-metadata-badge-placeholder');
        badge.setAttribute('aria-hidden', 'true');
    }

    return badge;
}

function renderWudBadge(group: TitleGroup): HTMLElement | null {
    if (group.wudEntries.length === 0) {
        return null;
    }
    const badge = document.createElement('div');
    badge.className = 'title-slot-badge title-slot-badge-wud';
    badge.textContent = 'WUD';
    const count = group.wudEntries.reduce(
        (total, entry) => total + entry.copyCount,
        0
    );
    badge.title = `${count} disc image source(s)`;
    return badge;
}

function renderGroup(
    group: TitleGroup,
    onSelect: (group: TitleGroup) => void,
    selectedFamily: string | null
): HTMLElement | null {
    if (!group.name) {
        return null;
    }
    const root = document.createElement('div');
    root.className = `title-group title-group-${group.status}`;
    root.dataset.family = group.family;
    root.title = formatTooltip(group);
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', `Show details for ${group.name}`);
    root.toggleAttribute('data-selected', group.family === selectedFamily);

    if (group.iconUrl) {
        root.append(buildTitleIcon(group.iconUrl, group.name));
    } else {
        root.append(buildTitleIconPlaceholder());
    }

    const header = document.createElement('div');
    header.className = 'title-group-name';
    header.textContent = group.name;
    const badges = document.createElement('div');
    badges.className = 'title-group-metadata';
    const badgeList = document.createElement('div');
    badgeList.className = 'title-slot-badges';
    const wudBadge = renderWudBadge(group);
    if (wudBadge) {
        badgeList.append(wudBadge);
    }
    switch (group.platform) {
        case '3ds':
        case 'wiiu':
            badgeList.append(
                renderSlotBadge(
                    group,
                    TitleKinds.Base,
                    getBaseBadgeState(group)
                ),
                renderSlotBadge(
                    group,
                    TitleKinds.Update,
                    getChildBadgeState(group, TitleKinds.Update)
                ),
                renderSlotBadge(
                    group,
                    TitleKinds.DLC,
                    getChildBadgeState(group, TitleKinds.DLC)
                )
            );
            break;
    }

    badges.append(badgeList);

    const rightBadges = document.createElement('div');
    rightBadges.className = 'title-group-right-metadata';
    rightBadges.append(
        renderVirtualConsoleBadge(group),
        renderPlatformBadge(group)
    );

    const formatted = formatRegion(group.region ?? 'UNK');
    const region = document.createElement('div');
    region.className = 'title-metadata-badge title-region';
    const flag = document.createElement('span');
    flag.className = formatted.class ?? '';
    flag.textContent = formatted.flag;
    const text = document.createElement('span');
    text.className = 'region';
    text.textContent = formatted.text;
    region.append(flag, text);
    rightBadges.append(region);
    badges.append(rightBadges);

    root.append(header, badges);
    root.addEventListener('click', () => onSelect(group));
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(group);
        }
    });
    return root;
}

export function refreshRenderedTitleGroup(group: TitleGroup): void {
    updateTitlesControls();
    updateTitleActionButtons();

    if (!titlesGrid || !titlesSidebar) {
        return;
    }

    const element = titlesGrid.querySelector<HTMLElement>(
        `.title-group[data-family="${CSS.escape(group.family)}"]`
    );
    if (!isGroupVisible(group)) {
        element?.remove();
        return;
    }

    const replacement = renderGroup(
        group,
        (selected) => options?.toggleDetailSidebar(titlesSidebar!, selected),
        options?.getSelectedDetailFamily() ?? null
    );
    if (!replacement) {
        element?.remove();
        return;
    }

    if (element) {
        element.replaceWith(replacement);
        options?.renderDownloadMarkers();
        return;
    }

    renderGroups(currentGroups, titlesGrid, titlesSidebar);
}

function normalizeSearch(value: string | null | undefined): string {
    return (value ?? '').toLocaleLowerCase();
}

function getSearchHaystack(group: TitleGroup): string {
    let haystack = titleSearchHaystacks.get(group);
    if (haystack !== undefined) {
        return haystack;
    }

    const parts: (string | null)[] = [group.name, group.family, group.region];
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
    haystack = parts.map(normalizeSearch).join('\n');
    titleSearchHaystacks.set(group, haystack);
    return haystack;
}

function collectRegions(groups: TitleGroup[]): string[] {
    return [...new Set(groups.flatMap((group) => group.region ?? []))].sort(
        (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
}

function collectVcPlatforms(groups: TitleGroup[]): VirtualConsolePlatform[] {
    const platforms = groups.flatMap((group) => {
        const platform = getVirtualConsolePlatform(
            group.platform,
            group.productCode
        );
        return platform ? [platform] : [];
    });
    return [...new Set(platforms)].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
}

function updateVirtualConsoleBadgeWidth(
    groups: TitleGroup[],
    grid: HTMLDivElement
): void {
    const platforms = collectVcPlatforms(groups);

    if (platforms.length === 0) {
        grid.style.removeProperty('--title-vc-badge-width');
        return;
    }

    const label = platforms.reduce((longest, platform) => {
        const label = platform;
        return label.length > longest.length ? label : longest;
    }, '');
    grid.style.setProperty('--title-vc-badge-width', `${label.length + 2}ch`);
}

function normalizeControlState(groups: TitleGroup[]): void {
    const regions = collectRegions(groups);
    const vcFilters: TitlesVcFilter[] = [
        'all',
        'vc',
        'non-vc',
        ...collectVcPlatforms(groups),
    ];
    controlState.region =
        controlState.region === 'all' || regions.includes(controlState.region)
            ? controlState.region
            : 'all';
    controlState.vc = vcFilters.includes(controlState.vc)
        ? controlState.vc
        : 'all';
}

function isGroupVisible(group: TitleGroup): boolean {
    if (
        !showAllTitles &&
        group.entries.length === 0 &&
        group.wudEntries.length === 0
    ) {
        return false;
    }
    if (controlState.status !== 'all' && group.status !== controlState.status) {
        return false;
    }
    if (controlState.region !== 'all' && group.region !== controlState.region) {
        return false;
    }

    const platform = getVirtualConsolePlatform(
        group.platform,
        group.productCode
    );
    if (controlState.vc === 'vc' && !platform) {
        return false;
    }
    if (controlState.vc === 'non-vc' && platform) {
        return false;
    }
    if (
        controlState.vc !== 'all' &&
        controlState.vc !== 'vc' &&
        controlState.vc !== 'non-vc' &&
        controlState.vc !== platform
    ) {
        return false;
    }

    const search = normalizeSearch(controlState.search.trim());
    return !search || getSearchHaystack(group).includes(search);
}

function renderGroups(
    groups: TitleGroup[],
    grid: HTMLDivElement,
    sidebar: HTMLElement
): void {
    currentGroups = groups;
    const filtered = groups.filter(
        (group) => group.name.length > 0 && isGroupVisible(group)
    );
    updateVirtualConsoleBadgeWidth(groups, grid);
    virtualGroups = filtered;
    virtualWindowState = null;

    grid.replaceChildren();
    const spacer = document.createElement('div');
    spacer.className = 'title-virtual-spacer';
    const viewport = document.createElement('div');
    viewport.className = 'title-virtual-window';
    spacer.append(viewport);
    grid.append(spacer);

    renderVirtualTitleWindow(grid, sidebar);
}

function scheduleVirtualTitleRender(): void {
    if (virtualRenderFrame !== null) {
        cancelAnimationFrame(virtualRenderFrame);
    }
    virtualRenderFrame = requestAnimationFrame(() => {
        virtualRenderFrame = null;
        if (titlesGrid && titlesSidebar) {
            renderVirtualTitleWindow(titlesGrid, titlesSidebar);
        }
    });
}

function getVirtualTitleLayout(grid: HTMLDivElement): {
    columns: number;
    gap: number;
    rowHeight: number;
    rowStride: number;
} {
    const listView = grid.dataset.view === 'list';
    const gap = listView ? TITLE_LIST_GAP : TITLE_GRID_GAP;
    const rowHeight = listView ? TITLE_LIST_ROW_HEIGHT : TITLE_GRID_ROW_HEIGHT;
    const columns = listView
        ? 1
        : Math.max(
              1,
              Math.floor(
                  (grid.clientWidth + gap) / (TITLE_GRID_MIN_COLUMN_WIDTH + gap)
              )
          );

    return {
        columns,
        gap,
        rowHeight,
        rowStride: rowHeight + gap,
    };
}

function renderVirtualTitleWindow(
    grid: HTMLDivElement,
    sidebar: HTMLElement
): void {
    const spacer = grid.querySelector<HTMLDivElement>(
        ':scope > .title-virtual-spacer'
    );
    const viewport = spacer?.querySelector<HTMLDivElement>(
        ':scope > .title-virtual-window'
    );

    if (!spacer || !viewport) {
        return;
    }

    const layout = getVirtualTitleLayout(grid);
    const totalRows = Math.ceil(virtualGroups.length / layout.columns);
    const totalHeight =
        totalRows === 0
            ? 0
            : totalRows * layout.rowHeight + (totalRows - 1) * layout.gap;
    const startRow = Math.max(
        0,
        Math.floor(grid.scrollTop / layout.rowStride) -
            TITLE_VIRTUAL_OVERSCAN_ROWS
    );
    const endRow = Math.min(
        totalRows,
        Math.ceil((grid.scrollTop + grid.clientHeight) / layout.rowStride) +
            TITLE_VIRTUAL_OVERSCAN_ROWS
    );
    const startIndex = startRow * layout.columns;
    const endIndex = Math.min(virtualGroups.length, endRow * layout.columns);
    const selectedFamily = options?.getSelectedDetailFamily() ?? null;
    const nextState = {
        startIndex,
        endIndex,
        startRow,
        columns: layout.columns,
        totalHeight,
    };

    spacer.style.height = `${totalHeight}px`;
    viewport.style.transform = `translateY(${startRow * layout.rowStride}px)`;
    viewport.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
    syncVirtualTitleSelection(viewport, selectedFamily);

    if (isSameVirtualTitleWindow(virtualWindowState, nextState)) {
        return;
    }

    virtualWindowState = nextState;
    const existingElements = getVirtualTitleElements(viewport);
    const fragment = document.createDocumentFragment();

    for (const group of virtualGroups.slice(startIndex, endIndex)) {
        const element =
            existingElements.get(group.family) ??
            renderGroup(
                group,
                (selected) => options?.toggleDetailSidebar(sidebar, selected),
                selectedFamily
            );
        if (element) {
            element.toggleAttribute(
                'data-selected',
                group.family === selectedFamily
            );
            fragment.append(element);
        }
    }

    viewport.replaceChildren(fragment);
    options?.renderDownloadMarkers();
}

function getVirtualTitleElements(
    viewport: HTMLDivElement
): Map<string, HTMLElement> {
    const elements = new Map<string, HTMLElement>();

    for (const child of viewport.children) {
        if (!(child instanceof HTMLElement) || !child.dataset.family) {
            continue;
        }
        elements.set(child.dataset.family, child);
    }

    return elements;
}

function syncVirtualTitleSelection(
    viewport: HTMLDivElement,
    selectedFamily: string | null
): void {
    for (const child of viewport.children) {
        if (child instanceof HTMLElement) {
            child.toggleAttribute(
                'data-selected',
                child.dataset.family === selectedFamily
            );
        }
    }
}

function isSameVirtualTitleWindow(
    a: VirtualTitleWindowState | null,
    b: VirtualTitleWindowState
): boolean {
    return (
        a !== null &&
        a.startIndex === b.startIndex &&
        a.endIndex === b.endIndex &&
        a.startRow === b.startRow &&
        a.columns === b.columns &&
        a.totalHeight === b.totalHeight
    );
}

function appendOptions(
    select: HTMLSelectElement,
    entries: Array<{ value: string; label: string }>
): void {
    for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        select.append(option);
    }
}

function buildViewControl(grid: HTMLDivElement): HTMLElement {
    const root = document.createElement('div');
    root.className = 'library-view-toggle library-field-view';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Library view');

    const buildButton = (
        mode: TitlesViewMode,
        icon: string
    ): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'library-view-button';
        button.title = `${mode === 'table' ? 'Table' : 'List'} view`;
        button.setAttribute('aria-label', button.title);
        button.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
        button.addEventListener('click', () => apply(mode, true));
        return button;
    };
    const table = buildButton('table', 'table');
    const list = buildButton('list', 'list');
    root.append(table, list);

    const apply = (mode: TitlesViewMode, save = false): void => {
        grid.dataset.view = mode;
        for (const [button, active] of [
            [table, mode === 'table'],
            [list, mode === 'list'],
        ] as const) {
            button.dataset.active = String(active);
            button.setAttribute('aria-pressed', String(active));
        }
        if (save) {
            localStorage.setItem('libraryViewMode', mode);
            if (titlesSidebar) {
                renderGroups(currentGroups, grid, titlesSidebar);
            }
        }
    };
    apply(
        localStorage.getItem('libraryViewMode') === 'list' ? 'list' : 'table'
    );
    return root;
}

function buildControls(
    grid: HTMLDivElement,
    sidebar: HTMLElement
): HTMLElement {
    const root = document.createElement('div');
    root.className = 'library-controls';

    for (const [text, className] of [
        ['Region', 'region'],
        ['Status', 'status'],
        ['VC', 'vc'],
        ['Search', 'search'],
        ['Titles', 'show-all'],
    ]) {
        const label = document.createElement('div');
        label.className = `library-label library-label-${className}`;
        label.textContent = text;
        root.append(label);
    }

    regionSelect = document.createElement('select');
    regionSelect.className = 'library-field-region';
    statusSelect = document.createElement('select');
    statusSelect.className = 'library-field-status';
    appendOptions(
        statusSelect,
        [
            'all',
            'complete',
            'incomplete',
            'missing',
            'unavailable',
            'unknown',
        ].map((value) => ({
            value,
            label: value[0].toUpperCase() + value.slice(1),
        }))
    );
    vcSelect = document.createElement('select');
    vcSelect.className = 'library-field-vc';

    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Name, title ID, or region';
    searchInput.className = 'library-field-search';
    searchInput.value = controlState.search;

    const showAllLabel = document.createElement('label');
    showAllLabel.className = 'library-checkbox library-field-show-all';
    showAllInput = document.createElement('input');
    showAllInput.type = 'checkbox';
    showAllInput.checked = showAllTitles;
    const showAllText = document.createElement('span');
    showAllText.textContent = 'Show all';
    showAllLabel.append(showAllInput, showAllText);

    const iconButton = (
        className: string,
        title: string,
        icon: string
    ): HTMLButtonElement => {
        const button = document.createElement('button');
        button.className = className;
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
        return button;
    };
    refreshButton = iconButton(
        'library-field-refresh',
        'Refresh library',
        'refresh'
    );
    verifyButton = iconButton(
        'library-field-verify',
        'Verify library',
        'check-double'
    );
    const settings = iconButton(
        'library-field-settings',
        'Open settings',
        'gear'
    );

    root.append(
        regionSelect,
        statusSelect,
        vcSelect,
        searchInput,
        showAllLabel,
        buildViewControl(grid),
        refreshButton,
        verifyButton,
        settings
    );

    const update = (): void => {
        controlState = {
            region: regionSelect?.value ?? 'all',
            status:
                (statusSelect?.value as TitlesControlState['status']) ?? 'all',
            vc: (vcSelect?.value as TitlesVcFilter) ?? 'all',
            search: searchInput?.value ?? '',
        };
        renderGroups(currentGroups, grid, sidebar);
    };
    regionSelect.addEventListener('change', update);
    statusSelect.addEventListener('change', update);
    vcSelect.addEventListener('change', update);
    searchInput.addEventListener('input', update);
    showAllInput.addEventListener('change', () => {
        showAllTitles = showAllInput?.checked ?? false;
        update();
    });
    refreshButton.addEventListener(
        'click',
        (event) => void options?.onRefresh({ clearScanCache: event.shiftKey })
    );
    verifyButton.addEventListener('click', () => void options?.onVerify());
    settings.addEventListener('click', () => options?.onOpenSettings());

    return root;
}

function updateTitlesControls(): void {
    const visibleGroups = filterVisibleTitleGroups(currentGroups);
    normalizeControlState(visibleGroups);

    if (regionSelect) {
        regionSelect.replaceChildren();
        appendOptions(regionSelect, [
            { value: 'all', label: 'All' },
            ...collectRegions(visibleGroups).map((value) => ({
                value,
                label: value,
            })),
        ]);
        regionSelect.value = controlState.region;
    }
    if (statusSelect) {
        statusSelect.value = controlState.status;
    }
    if (vcSelect) {
        vcSelect.replaceChildren();
        appendOptions(vcSelect, [
            { value: 'all', label: 'All' },
            { value: 'vc', label: 'VC only' },
            { value: 'non-vc', label: 'Non-VC' },
            ...collectVcPlatforms(visibleGroups).map((value) => ({
                value,
                label: value,
            })),
        ]);
        vcSelect.value = controlState.vc;
    }
    if (searchInput && searchInput.value !== controlState.search) {
        searchInput.value = controlState.search;
    }
    if (showAllInput) {
        showAllInput.checked = showAllTitles;
    }

    const disabled = currentGroups.length === 0;
    for (const control of [
        regionSelect,
        statusSelect,
        vcSelect,
        searchInput,
        showAllInput,
    ]) {
        if (control) {
            control.disabled = disabled;
        }
    }
}

function updateTitleActionButtons(): void {
    updateRefreshButtonState();
    updateVerificationButtonState();
}

function updateRefreshButtonState(): void {
    const icon = refreshButton?.querySelector<HTMLElement>('i');
    if (!refreshButton || !icon) {
        return;
    }
    refreshButton.title = loading
        ? 'Refreshing library'
        : 'Refresh library (shift-click clears scan cache)';
    refreshButton.setAttribute('aria-label', refreshButton.title);
    refreshButton.setAttribute('aria-busy', String(loading));
    refreshButton.disabled = loading;
    icon.className = loading
        ? 'fa-solid fa-spinner fa-spin'
        : 'fa-solid fa-refresh';
}

function updateVerificationButtonState(): void {
    const icon = verifyButton?.querySelector<HTMLElement>('i');
    if (!verifyButton || !icon) {
        return;
    }
    verifyButton.title = verifying ? 'Verifying library' : 'Verify library';
    verifyButton.setAttribute('aria-label', verifyButton.title);
    verifyButton.setAttribute('aria-busy', String(verifying));
    verifyButton.disabled = loading || verifying || currentGroups.length === 0;
    icon.className = verifying
        ? 'fa-solid fa-spinner fa-spin'
        : 'fa-solid fa-check-double';
}
