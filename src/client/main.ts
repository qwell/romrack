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
import {
    AppSocketCommand,
    AppSocketEvent,
    DownloadQueueItem,
    DownloadQueueState,
} from '../shared/socket.js';

declare const __APP_VERSION__: string;
const SOCKET_RECONNECT_MS = 2000;

type SlotBadgeState =
    | 'complete'
    | 'incomplete'
    | 'na'
    | 'unavailable'
    | 'unknown';
type LibraryViewMode = 'table' | 'list';

let refreshLibrary: (() => Promise<void>) | null = null;
let showAllTitles = false;
let selectedFamily: string | null = null;
let currentGroups: TitleGroup[] = [];

let iconObserver: IntersectionObserver | null = null;

const serverStatusModal = document.querySelector<HTMLDivElement>(
    '#server-status-modal'
);

let downloadQueue: DownloadQueueItem[] = [];
let downloadQueueRoot: HTMLElement | null = null;
let appSocket: WebSocket | null = null;
let reconnectSocketTimer: number | null = null;

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

function getDownloadItem(
    family: string,
    kind: TitleKinds,
    titleId?: string
): DownloadQueueItem | null {
    return (
        downloadQueue.find(
            (item) =>
                item.family === family &&
                item.kind === kind &&
                (!titleId || item.titleId === titleId) &&
                item.state !== 'complete'
        ) ?? null
    );
}

function getDownloadState(
    family: string,
    kind: TitleKinds
): DownloadQueueState | null {
    return getDownloadItem(family, kind)?.state ?? null;
}

function getDownloadMarker(state: DownloadQueueState | null): string {
    switch (state) {
        case 'downloading':
            return '⬇';
        case 'queued':
            return '⋯';
        case 'failed':
            return '!';
        default:
            return '';
    }
}

function formatDownloadProgress(item: DownloadQueueItem): string {
    if (item.state === 'queued') {
        return 'Queued';
    }

    if (item.state === 'failed') {
        return 'Failed';
    }

    if (item.state === 'complete') {
        return 'Done';
    }

    if (item.progress !== null) {
        return `${Math.round(item.progress)}%`;
    }

    return 'Downloading';
}

function getSocketUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/api/socket`;
}

function sendAppSocketCommand(command: AppSocketCommand): void {
    if (!appSocket || appSocket.readyState !== WebSocket.OPEN) {
        showServerGoneModal();
        return;
    }

    appSocket.send(JSON.stringify(command));
}

function syncDownloadQueue(nextQueue: DownloadQueueItem[]): void {
    const previousById = new Map(downloadQueue.map((item) => [item.id, item]));
    const shouldReconcileCompleted = previousById.size === 0;

    downloadQueue = nextQueue;

    for (const item of downloadQueue) {
        const previous = previousById.get(item.id);

        if (
            ((previous && previous.state !== 'complete') ||
                shouldReconcileCompleted) &&
            item.state === 'complete'
        ) {
            markSlotBadgeComplete(item.family, item.kind);
            markDownloadComplete(item);
        }
    }

    updateQueueStrip();
    renderDownloadMarkers();

    const selectedGroup = currentGroups.find(
        (group) => group.family === selectedFamily
    );

    if (selectedGroup) {
        refreshOpenDetailSidebarForGroup(selectedGroup);
    }
}

function handleAppSocketEvent(event: AppSocketEvent): void {
    switch (event.type) {
        case 'app.connected':
            hideServerGoneModal();
            syncDownloadQueue(event.downloads);
            return;

        case 'download.queueChanged':
            hideServerGoneModal();
            syncDownloadQueue(event.items);
            return;
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

function getAvailableSizeText(entry: unknown): string | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const sizeBytes = maybeNumber((entry as { sizeBytes?: unknown }).sizeBytes);
    return sizeBytes === null ? null : formatSize(sizeBytes);
}

function getAvailableSizeBytes(entry: unknown): number | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    return maybeNumber((entry as { sizeBytes?: unknown }).sizeBytes);
}

function updateQueueStrip(): void {
    if (!downloadQueueRoot) {
        return;
    }

    const visibleItems = downloadQueue.filter(
        (item) => item.state !== 'complete'
    );
    const activeCount = visibleItems.filter(
        (item) => item.state === 'downloading'
    ).length;
    const queuedCount = visibleItems.filter(
        (item) => item.state === 'queued'
    ).length;
    const failedCount = visibleItems.filter(
        (item) => item.state === 'failed'
    ).length;
    const currentItem =
        visibleItems.find((item) => item.state === 'downloading') ??
        visibleItems.find((item) => item.state === 'failed') ??
        visibleItems.find((item) => item.state === 'queued') ??
        null;

    downloadQueueRoot.hidden = visibleItems.length === 0;
    downloadQueueRoot.replaceChildren();

    if (visibleItems.length === 0) {
        return;
    }

    const summary = document.createElement('div');
    summary.className = 'download-queue-summary';

    const counts = document.createElement('div');
    counts.textContent = `Queue: ${activeCount} active, ${queuedCount} queued, ${failedCount} failed`;

    const current = document.createElement('div');
    current.className = 'download-queue-current';
    current.textContent = currentItem
        ? `${currentItem.groupName} ${currentItem.label} ${formatDownloadProgress(currentItem)}`
        : 'Idle';

    const size = document.createElement('div');
    size.textContent = currentItem?.sizeText ?? '';

    summary.append(counts, current, size);
    downloadQueueRoot.append(summary);

    const details = document.createElement('div');
    details.className = 'download-queue-details';

    for (const item of visibleItems) {
        const row = document.createElement('div');
        row.className = `download-queue-row download-queue-row-${item.state}`;

        const state = document.createElement('div');
        state.className = 'download-queue-state';
        state.textContent = getDownloadMarker(item.state) || 'OK';

        const title = document.createElement('div');
        title.className = 'download-queue-title';
        title.title = item.groupName;
        title.textContent = item.groupName;

        const label = document.createElement('div');
        label.textContent = item.label;

        const progress = document.createElement('div');
        progress.textContent = formatDownloadProgress(item);

        const action = document.createElement('div');
        action.className = 'download-queue-action';

        if (item.state === 'failed') {
            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'download-queue-button';
            retryButton.textContent = 'Retry';
            retryButton.addEventListener('click', () => retryDownload(item.id));

            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'download-queue-button';
            removeButton.textContent = 'Remove';
            removeButton.addEventListener('click', () =>
                removeDownload(item.id)
            );

            action.append(retryButton, removeButton);
        } else if (item.state === 'queued') {
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'download-queue-button';
            removeButton.textContent = 'Remove';
            removeButton.addEventListener('click', () =>
                removeDownload(item.id)
            );
            action.append(removeButton);
        }

        row.append(state, title, label, progress, action);
        details.append(row);
    }

    downloadQueueRoot.append(details);
}

function buildDownloadQueueStrip(): HTMLElement {
    const strip = document.createElement('section');
    strip.className = 'download-queue';
    strip.hidden = true;
    strip.setAttribute('aria-label', 'Download queue');
    return strip;
}

function mountDownloadQueueStrip(): void {
    if (downloadQueueRoot) {
        return;
    }

    downloadQueueRoot = buildDownloadQueueStrip();
    document.body.append(downloadQueueRoot);
    updateQueueStrip();
}

function queueDownloads(items: DownloadQueueItem[]): void {
    const addedItems = items.filter(
        (item) => !getDownloadItem(item.family, item.kind, item.titleId)
    );

    if (addedItems.length === 0) {
        return;
    }

    sendAppSocketCommand({
        type: 'download.enqueue',
        items: addedItems,
    });
}

function retryDownload(itemId: string): void {
    sendAppSocketCommand({
        type: 'download.retry',
        id: itemId,
    });
}

function removeDownload(itemId: string): void {
    sendAppSocketCommand({
        type: 'download.remove',
        id: itemId,
    });
}

function renderDownloadMarkers(): void {
    for (const badge of document.querySelectorAll<HTMLElement>(
        '.title-slot-badge'
    )) {
        const family = badge.dataset.family;
        const kind = badge.dataset.kind as TitleKinds | undefined;
        const marker = badge.querySelector<HTMLElement>(
            '.title-slot-badge-download'
        );

        if (!family || !kind || !marker) {
            continue;
        }

        const state = getDownloadState(family, kind);
        marker.textContent = getDownloadMarker(state);
        marker.hidden = state === null;
        badge.dataset.downloadState = state ?? '';
    }
}

function updateGroupStatusFromSlots(group: TitleGroup): void {
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

function markDownloadComplete(item: DownloadQueueItem): void {
    const group = currentGroups.find(
        (candidate) => candidate.family === item.family
    );

    if (!group) {
        return;
    }

    const alreadyDownloaded = group.entries.some(
        (entry) => entry.kind === item.kind && entry.titleId === item.titleId
    );

    const installedSizeBytes = item.installedSizeBytes ?? item.totalBytes ?? 0;
    const installedVersion = item.installedVersion ?? 0;
    const installedTitleName = item.installedTitleName ?? group.name;

    if (!alreadyDownloaded) {
        group.entries.push({
            titleId: item.titleId,
            version: installedVersion,
            titleName: installedTitleName,
            region: group.region,
            iconUrl: group.iconUrl,
            kind: item.kind,
            sizeBytes: installedSizeBytes,
        });
    } else {
        const existingEntry = group.entries.find(
            (entry) =>
                entry.kind === item.kind && entry.titleId === item.titleId
        );

        if (existingEntry) {
            existingEntry.version = installedVersion;
            existingEntry.titleName = installedTitleName;
            existingEntry.sizeBytes = installedSizeBytes;
        }
    }

    group.availableEntries = group.availableEntries.filter(
        (entry) => !(entry.kind === item.kind && entry.titleId === item.titleId)
    );

    updateGroupStatusFromSlots(group);
    updateRenderedTitleGroup(group);
    refreshOpenDetailSidebarForGroup(group);
}

function markSlotBadgeComplete(family: string, kind: TitleKinds): void {
    for (const badge of document.querySelectorAll<HTMLElement>(
        '.title-slot-badge'
    )) {
        if (badge.dataset.family !== family || badge.dataset.kind !== kind) {
            continue;
        }

        badge.classList.remove(
            'title-slot-badge-incomplete',
            'title-slot-badge-na',
            'title-slot-badge-unknown'
        );
        badge.classList.add('title-slot-badge-complete');

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

function updateRenderedTitleGroup(group: TitleGroup): void {
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
}

function refreshOpenDetailSidebarForGroup(group: TitleGroup): void {
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

    const downloadState = getDownloadState(group.family, label);
    downloadMarker.textContent = getDownloadMarker(downloadState);
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

function renderDownloadAvailabilityRow(
    group: TitleGroup,
    entry: TitleGroup['availableEntries'][number]
): HTMLLabelElement | HTMLDivElement {
    const versions = formatVersions(entry.versions);
    const label = versions ? `${entry.kind} ${versions}` : entry.kind;
    const sizeText = getAvailableSizeText(entry);
    const existingQueueItem = getDownloadItem(
        group.family,
        entry.kind,
        entry.titleId
    );

    if (existingQueueItem) {
        const row = document.createElement('div');
        row.className = `title-download-row title-download-row-${existingQueueItem.state}`;

        const state = document.createElement('span');
        state.className = 'title-download-state';
        state.textContent = getDownloadMarker(existingQueueItem.state);

        const slot = document.createElement('span');
        slot.className = 'title-download-slot';
        slot.textContent = label;

        const titleId = document.createElement('span');
        titleId.className = 'title-download-id';
        titleId.textContent = formatDownloadProgress(existingQueueItem);

        const size = document.createElement('span');
        size.className = 'title-download-size';
        size.textContent = sizeText ?? '';

        row.append(state, slot, titleId, size);
        return row;
    }

    const row = document.createElement('label');
    row.className = 'title-download-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'title-download-checkbox';
    checkbox.value = entry.titleId;
    checkbox.dataset.family = group.family;
    checkbox.dataset.groupName = group.name;
    checkbox.dataset.kind = entry.kind;
    checkbox.dataset.label = label;
    checkbox.dataset.titleId = entry.titleId;
    checkbox.dataset.sizeText = sizeText ?? '';

    const sizeBytes = getAvailableSizeBytes(entry);
    if (sizeBytes !== null) {
        checkbox.dataset.totalBytes = String(sizeBytes);
    }

    checkbox.disabled = !entry.availableOnCdn;
    if (!entry.availableOnCdn) {
        row.classList.add('title-download-row-unavailable');
    }

    const slot = document.createElement('span');
    slot.className = 'title-download-slot';
    slot.textContent = label;

    const titleId = document.createElement('span');
    titleId.className = 'title-download-id';
    titleId.textContent = entry.titleId;

    const size = document.createElement('span');
    size.className = 'title-download-size';
    size.textContent = entry.availableOnCdn ? (sizeText ?? '') : 'Not on CDN';

    row.append(checkbox, slot, titleId, size);
    return row;
}

function collectSelectedDownloads(
    root: HTMLElement,
    selectedOnly = true
): DownloadQueueItem[] {
    const selector = selectedOnly
        ? '.title-download-checkbox:checked:not(:disabled)'
        : '.title-download-checkbox:not(:disabled)';

    return Array.from(root.querySelectorAll<HTMLInputElement>(selector)).map(
        (checkbox) => ({
            id: crypto.randomUUID(),
            family: checkbox.dataset.family ?? '',
            groupName: checkbox.dataset.groupName ?? '',
            kind: checkbox.dataset.kind as TitleKinds,
            label: checkbox.dataset.label ?? '',
            titleId: checkbox.dataset.titleId ?? '',
            sizeText: checkbox.dataset.sizeText ?? null,
            totalBytes: checkbox.dataset.totalBytes
                ? Number(checkbox.dataset.totalBytes)
                : null,
            state: 'queued',
            error: null,
            progress: 0,
            downloadedBytes: null,
            speedText: null,
            installedSizeBytes: null,
            installedVersion: null,
            installedTitleName: null,
        })
    );
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
        availableList.className = 'title-download-list';

        for (const entry of availableEntries) {
            availableList.append(renderDownloadAvailabilityRow(group, entry));
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

    for (const group of filteredGroups) {
        const render = renderGroup(group, (selectedGroup) =>
            toggleDetailSidebar(sidebar, selectedGroup)
        );
        if (!render) {
            continue;
        }

        grid.append(render);
    }

    renderDownloadMarkers();
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

    titleCheckbox.addEventListener('change', () => {
        showAllTitles = titleCheckbox.checked;
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
            updateGroupStatusFromSlots(group);
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

window.addEventListener('pageshow', resetDetailSidebars);

mountDownloadQueueStrip();

connectAppSocket();

resetDetailSidebars();

setupVersion();
void setupTheme();

void refreshLibrary();
