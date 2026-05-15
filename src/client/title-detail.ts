import { DownloadQueueItem } from '../shared/download.js';
import { formatSize } from '../shared/shared.js';
import {
    PARENT_KINDS,
    type TitleDetails,
    type TitleEntry,
    type TitleGroup,
    type TitleInputControl,
    TitleKinds,
    getVirtualConsolePlatform,
} from '../shared/titles.js';
import { queueStorageCopy, queueStorageDelete } from './api.js';
import {
    collectSelectedDownloads,
    formatDownloadIcon,
    getDownloadState,
    queueDownloads,
    renderDownloadAvailabilityRow,
} from './download.js';
import {
    getEntry,
    getBaseBadgeState,
    getChildBadgeState,
    type SlotBadgeState,
} from './library-state.js';

type TitleDetailOptions = {
    downloads: DownloadQueueItem[];
    observeIcon: (image: HTMLImageElement, src: string) => void;
    populateFat32DeviceSelect: (
        select: HTMLSelectElement,
        copyButton: HTMLButtonElement
    ) => Promise<void>;
};

let selectedFamily: string | null = null;
let options: TitleDetailOptions | null = null;

export function setupTitleDetails(nextOptions: TitleDetailOptions): void {
    options = nextOptions;
}

export function hasOpenDetailFamily(): boolean {
    return selectedFamily !== null;
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

function formatDeleteConfirmationEntry(entry: TitleEntry): string {
    const copyText = entry.copyCount > 1 ? ` (${entry.copyCount} copies)` : '';
    return `${entry.titleName} v${entry.version} [${formatTitleKindLabel(entry.kind)}] ${entry.titleId}${copyText}`;
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

    const downloadState = getDownloadState(
        options?.downloads ?? [],
        group.family,
        label
    );
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
    const detailOptions = options;
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
        if (detailOptions) {
            void detailOptions.populateFat32DeviceSelect(
                destinationSelect,
                copyButton
            );
        }

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
                            return queueStorageCopy(titleId, destination);
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

                const selectedTitleIds = new Set(titleIds);
                const selectedEntries = localEntries.filter((entry) =>
                    selectedTitleIds.has(entry.titleId)
                );
                const selectedText = selectedEntries
                    .map(formatDeleteConfirmationEntry)
                    .join('\n');
                const confirmed = window.confirm(
                    selectedEntries.length === 1
                        ? `Delete this local title?\n\n${selectedText}`
                        : `Delete these ${selectedEntries.length} local titles?\n\n${selectedText}`
                );
                if (!confirmed) {
                    return;
                }

                deleteButton.disabled = true;
                try {
                    await Promise.all(
                        titleIds.map((titleId) => {
                            return queueStorageDelete(titleId);
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
                renderDownloadAvailabilityRow(
                    detailOptions?.downloads ?? [],
                    group,
                    entry
                )
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
            const downloads = detailOptions?.downloads ?? [];
            const hasSelection =
                availableList.querySelectorAll(
                    '.title-download-checkbox:checked'
                ).length > 0;

            queueDownloads(
                downloads,
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

export function closeDetailSidebar(sidebar: HTMLElement): void {
    selectedFamily = null;
    sidebar.hidden = true;
    document.body.removeAttribute('data-detail-open');
    sidebar.querySelector('.title-detail-body')?.replaceChildren();

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

export function resetDetailSidebars(): void {
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

export function toggleDetailSidebar(
    sidebar: HTMLElement,
    group: TitleGroup
): void {
    if (selectedFamily === group.family) {
        closeDetailSidebar(sidebar);
        return;
    }

    showDetailSidebar(sidebar, group);
}

export function buildDetailSidebar(): HTMLElement {
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

export function renderGroup(
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
        options?.observeIcon(image, group.iconUrl);
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

    updateRenderedSlotBadge(element, TitleKinds.Base, getBaseBadgeState(group));
    updateRenderedSlotBadge(
        element,
        TitleKinds.Update,
        getChildBadgeState(group, TitleKinds.Update)
    );
    updateRenderedSlotBadge(
        element,
        TitleKinds.DLC,
        getChildBadgeState(group, TitleKinds.DLC)
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
