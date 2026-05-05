import {
    type LibraryResponse,
    type TitleGroup,
    type TitleEntry,
    type TitleGroupStatus,
    type TitleDetails,
    type TitleInputControl,
    TitleKinds,
    type ChildKind,
    PARENT_KINDS,
    formatSize,
    getVirtualConsolePlatform,
    VirtualConsolePlatform,
} from '../shared/shared.js';

declare const __APP_VERSION__: string;
const HEARTBEAT_MS = 15000;

type SlotBadgeState = 'complete' | 'incomplete' | 'na' | 'unknown';
type LibraryViewMode = 'table' | 'list';

let refreshLibrary: (() => Promise<void>) | null = null;
let showAllTitles = false;
let selectedFamily: string | null = null;

let iconObserver: IntersectionObserver | null = null;
const serverStatusModal = document.querySelector<HTMLDivElement>(
    '#server-status-modal'
);

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
        root: document.querySelector('.library-grid'),
        rootMargin: '256px',
    }
);

function getViewMode(): LibraryViewMode {
    return localStorage.getItem('libraryViewMode') === 'list'
        ? 'list'
        : 'table';
}

function saveViewMode(viewMode: LibraryViewMode): void {
    localStorage.setItem('libraryViewMode', viewMode);
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

function renderAvailabilityRow(
    label: string,
    titleId: string,
    size: string | null = null
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'title-availability-row';

    const labelElement = document.createElement('div');
    labelElement.className = 'title-availability-label';
    labelElement.textContent = label;

    const titleIdElement = document.createElement('div');
    titleIdElement.className = 'title-availability-title-id';
    titleIdElement.textContent = size ? `${titleId} (${size})` : titleId;

    row.append(labelElement, titleIdElement);
    return row;
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

function formatVersions(versions: number[]): string {
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

function getGameBadgeState(group: TitleGroup): SlotBadgeState {
    if (!group.titleInDatabase) {
        return 'unknown';
    }

    if (getEntry(group, PARENT_KINDS)) {
        return 'complete';
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

    return entry ? 'complete' : 'incomplete';
}

function renderSlotBadge(label: string, state: SlotBadgeState): HTMLElement {
    const badge = document.createElement('div');
    badge.className = `title-slot-badge title-slot-badge-${state}`;
    badge.textContent = label;
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
        localList.className = 'title-availability-list';

        const localEntries = [...group.entries].sort(
            (a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind)
        );

        for (const entry of localEntries) {
            localList.append(
                renderAvailabilityRow(
                    `${entry.kind} v${entry.version}`,
                    entry.titleId,
                    formatSize(entry.sizeBytes)
                )
            );
        }

        availability.append(renderDetailSection('Downloaded'), localList);
    }

    const availableEntries = group.availableEntries
        .filter((entry) => !hasLocalEntry(group, entry.kind))
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));

    if (availableEntries.length > 0) {
        const availableList = document.createElement('div');
        availableList.className = 'title-availability-list';

        for (const entry of availableEntries) {
            const versions = formatVersions(entry.versions);
            const label = versions ? `${entry.kind} ${versions}` : entry.kind;

            availableList.append(renderAvailabilityRow(label, entry.titleId));
        }

        availability.append(renderDetailSection('Available'), availableList);
    }

    fragment.append(availability);

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
        renderSlotBadge(TitleKinds.Base, getGameBadgeState(group)),
        renderSlotBadge(
            TitleKinds.Update,
            getSlotBadgeState(group, TitleKinds.Update)
        ),
        renderSlotBadge(
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

function groupMatchesSearch(group: TitleGroup, search: string): boolean {
    if (!search) {
        return true;
    }

    const haystacks = [
        group.name,
        group.family,
        group.region,
        ...group.entries.flatMap((entry) => [
            entry.titleId,
            entry.titleName,
            entry.kind,
            entry.region,
        ]),
    ];

    return haystacks.some((value) =>
        normalizeSearchText(value).includes(search)
    );
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

function renderGroups(
    allGroups: TitleGroup[],
    grid: HTMLDivElement,
    sidebar: HTMLElement,
    statusValue: string,
    regionValue: string,
    vcValue: string,
    searchValue: string
): void {
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

    for (const group of filteredGroups) {
        const render = renderGroup(group, (selectedGroup) =>
            toggleDetailSidebar(sidebar, selectedGroup)
        );
        if (!render) {
            continue;
        }

        grid.append(render);
    }
}

function buildControls(
    groups: TitleGroup[],
    grid: HTMLDivElement,
    sidebar: HTMLElement,
    loading = false
): HTMLElement {
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

    const scopeText = document.createElement('div');
    scopeText.className = 'library-label library-label-scope';
    scopeText.textContent = 'Scope';

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
        value: 'all' | 'vc' | 'non-vc' | VirtualConsolePlatform;
        label: string;
    }> = [
        { value: 'all', label: 'All' },
        { value: 'vc', label: 'VC only' },
        { value: 'non-vc', label: 'Non-VC' },
        ...Object.values(VirtualConsolePlatform).map((platform) => ({
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

    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'library-checkbox library-field-scope';

    const scopeCheckbox = document.createElement('input');
    scopeCheckbox.type = 'checkbox';
    scopeCheckbox.checked = showAllTitles;
    scopeCheckbox.disabled = loading;

    const scopeLabelText = document.createElement('span');
    scopeLabelText.textContent = 'Show all titles';

    scopeLabel.append(scopeCheckbox, scopeLabelText);

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

    controls.append(
        regionText,
        statusText,
        vcText,
        searchText,
        scopeText,
        regionSelect,
        statusSelect,
        vcSelect,
        searchInput,
        scopeLabel,
        viewToggle,
        refreshButton
    );

    const update = (): void => {
        renderGroups(
            groups,
            grid,
            sidebar,
            statusSelect.value,
            regionSelect.value,
            vcSelect.value,
            searchInput.value
        );
    };

    searchInput.addEventListener('input', update);
    regionSelect.addEventListener('change', update);
    statusSelect.addEventListener('change', update);
    vcSelect.addEventListener('change', update);

    scopeCheckbox.addEventListener('change', () => {
        showAllTitles = scopeCheckbox.checked;
        if (refreshLibrary) {
            void refreshLibrary();
        }
    });

    refreshButton.addEventListener('click', () => {
        if (!refreshButton.disabled && refreshLibrary) {
            void refreshLibrary();
        }
    });

    if (groups.length > 0) {
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
    loading = false
): DocumentFragment {
    const fragment = document.createDocumentFragment();

    const grid = document.createElement('div');
    grid.className = 'library-grid';

    const sidebar = buildDetailSidebar();
    const controls = buildControls(groups, grid, sidebar, loading);
    fragment.append(controls, grid, sidebar);

    const loadingLine = document.createElement('div');
    loadingLine.className = 'library-loading';
    loadingLine.textContent = loading ? 'Loading...' : '';
    fragment.append(loadingLine);

    if (!loading && groups.length > 0) {
        renderGroups(groups, grid, sidebar, 'all', 'all', 'all', '');
    }

    return fragment;
}

async function loadLibrary(output: HTMLElement): Promise<void> {
    resetDetailSidebars();
    output.replaceChildren(buildLibraryContent([], true));

    try {
        const response = await fetch(
            showAllTitles ? '/api/library?includeAll=true' : '/api/library'
        );

        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const data = (await response.json()) as LibraryResponse;

        for (const group of data.groups) {
            group.entries.sort((a, b) => b.version - a.version);
        }

        const groups = [...data.groups].sort(compareGroups);

        output.replaceChildren(buildLibraryContent(groups, false));
    } catch (error) {
        console.error(error);

        output.replaceChildren();

        const message = document.createElement('div');
        message.textContent = 'Failed to load library.';
        output.append(message);
    }
}

refreshLibrary = async (): Promise<void> => {
    const output = document.querySelector<HTMLElement>('#output');

    if (!output) {
        throw new Error('Missing #output');
    }

    await loadLibrary(output);
};

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

function sessionHeartbeat(): void {
    fetch('/api/session/heartbeat', {
        method: 'POST',
    })
        .then(hideServerGoneModal)
        .catch(showServerGoneModal);
}

window.addEventListener('pageshow', resetDetailSidebars);

setInterval(sessionHeartbeat, HEARTBEAT_MS);
sessionHeartbeat();

resetDetailSidebars();

setupVersion();
void setupTheme();
void refreshLibrary();
