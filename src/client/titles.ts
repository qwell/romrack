import { type DownloadQueueItem } from '../shared/download.js';
import { formatActionStateIcon } from '../shared/action.js';
import { formatSize } from '../shared/shared.js';
import {
    getVirtualConsolePlatform,
    PARENT_KINDS,
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
    onRefresh: () => void | Promise<void>;
    onVerify: () => void | Promise<void>;
    onOpenSettings: () => void;
    renderDownloadMarkers: () => void;
    buildDetailSidebar: () => HTMLElement;
    getSelectedDetailFamily: () => string | null;
    toggleDetailSidebar: (sidebar: HTMLElement, group: TitleGroup) => void;
};
let options: TitlesOptions | null = null;
let showAllTitles = false;
let currentGroups: TitleGroup[] = [];
let controlState: TitlesControlState = {
    region: 'all',
    status: 'all',
    vc: 'all',
    search: '',
};
let iconObserver: IntersectionObserver | null = null;
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

export const titleSearchHaystacks = new WeakMap<TitleGroup, string>();

export function setupTitles(nextOptions: TitlesOptions): void {
    options = nextOptions;
}

export function mountTitles(root: HTMLElement): void {
    titlesGrid = document.createElement('div');
    titlesGrid.className = 'library-grid';
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
    resetIconObserver();
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

function observeTitleIcon(image: HTMLImageElement, src: string): void {
    if (iconObserver) {
        iconObserver.observe(image);
    } else {
        image.src = src;
    }
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
        resetIconObserver();
        titlesGrid?.replaceChildren();
    }
    updateTitlesControls();
    updateTitleActionButtons();
}

function formatRegion(region: string | null): {
    text: string;
    flag: string;
    class?: string;
} {
    const regions: Record<string, { flag: string; class?: string }> = {
        USA: { flag: '🇺🇸', class: 'distress' },
        EUR: { flag: '🇪🇺' },
        JPN: { flag: '🇯🇵' },
        FRA: { flag: '🇫🇷' },
        GER: { flag: '🇩🇪' },
        ITA: { flag: '🇮🇹' },
        SPA: { flag: '🇪🇸' },
        UNK: { flag: '🏴‍☠️', class: 'arrr' },
        ALL: { flag: '🌐' },
    };
    return {
        text: region ?? '',
        flag: regions[region ?? '']?.flag ?? '',
        class: regions[region ?? '']?.class,
    };
}

function formatTooltip(group: TitleGroup): string {
    const parent = getEntry(group, PARENT_KINDS);
    const update = getEntry(group, TitleKinds.Update);
    const dlc = getEntry(group, TitleKinds.DLC);
    const line = (label: string, entry: typeof parent): string =>
        `${label}: ${entry ? `${formatSize(entry.sizeBytes)} (${entry.titleId})` : '-'}`;
    return [
        line('Game', parent),
        line('Update', update),
        line('DLC', dlc),
    ].join('\n');
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
        const image = document.createElement('img');
        image.className = 'title-icon';
        image.dataset.src = group.iconUrl;
        image.alt = group.name;
        image.loading = 'lazy';
        image.decoding = 'async';
        root.append(image);
        observeTitleIcon(image, group.iconUrl);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'title-icon-placeholder';
        root.append(placeholder);
    }

    const header = document.createElement('div');
    header.className = 'title-group-name';
    header.textContent = group.name;
    const badges = document.createElement('div');
    badges.className = 'title-group-metadata';
    const badgeList = document.createElement('div');
    badgeList.className = 'title-slot-badges';
    const vcBadge = renderVirtualConsoleBadge(group);
    const wudBadge = renderWudBadge(group);
    if (vcBadge) {
        badgeList.append(vcBadge);
    }
    if (wudBadge) {
        badgeList.append(wudBadge);
    }
    badgeList.append(
        renderSlotBadge(group, TitleKinds.Base, getBaseBadgeState(group)),
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
    badges.append(badgeList);

    if (group.region) {
        const formatted = formatRegion(group.region);
        const region = document.createElement('div');
        region.className = 'title-region';
        const flag = document.createElement('span');
        flag.className = formatted.class ?? '';
        flag.textContent = formatted.flag;
        const text = document.createElement('span');
        text.className = 'region';
        text.textContent = formatted.text;
        region.append(flag, text);
        badges.append(region);
    }

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
        return;
    }

    renderGroups(currentGroups, titlesGrid, titlesSidebar);
}

function resetIconObserver(): void {
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
                const src = image.dataset.src;
                if (src) {
                    image.src = src;
                    delete image.dataset.src;
                }
                iconObserver?.unobserve(image);
            }
        },
        { rootMargin: '256px' }
    );
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
        const platform = group.productCode
            ? getVirtualConsolePlatform(group.productCode)
            : null;
        return platform ? [platform] : [];
    });
    return [...new Set(platforms)].sort((a, b) =>
        a.toString().localeCompare(b.toString(), undefined, {
            sensitivity: 'base',
        })
    );
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

    const platform = group.productCode
        ? getVirtualConsolePlatform(group.productCode)
        : null;
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
        controlState.vc !== platform?.toString()
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
    const filtered = groups.filter(isGroupVisible);

    grid.replaceChildren();
    resetIconObserver();

    let renderedCount = 0;
    const batchSize = 50;
    const sentinel = document.createElement('div');

    const appendBatch = (): void => {
        const fragment = document.createDocumentFragment();
        for (const group of filtered.slice(
            renderedCount,
            renderedCount + batchSize
        )) {
            const element = renderGroup(
                group,
                (selected) => options?.toggleDetailSidebar(sidebar, selected),
                options?.getSelectedDetailFamily() ?? null
            );
            if (element) {
                fragment.append(element);
            }
        }
        grid.insertBefore(fragment, sentinel);
        renderedCount += batchSize;
        options?.renderDownloadMarkers();
    };

    grid.append(sentinel);
    appendBatch();
    if (renderedCount >= filtered.length) {
        sentinel.remove();
        return;
    }

    const observer = new IntersectionObserver(
        (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) {
                return;
            }
            appendBatch();
            if (renderedCount >= filtered.length) {
                observer.disconnect();
                sentinel.remove();
            }
        },
        { rootMargin: '400px' }
    );
    observer.observe(sentinel);
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
    refreshButton.addEventListener('click', () => void options?.onRefresh());
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
                value: value.toString(),
                label: value.toString(),
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
    refreshButton.title = loading ? 'Refreshing library' : 'Refresh library';
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
