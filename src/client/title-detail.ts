import {
    LibraryValidateTitle,
    type StorageFat32ListResponse,
} from '../shared/api.js';
import { type DownloadQueueItem } from '../shared/download.js';
import { type DeleteItem } from '../shared/delete.js';
import { type Fat32Volume } from '../shared/os.js';
import { type StorageCopyItem } from '../shared/storage.js';
import {
    TITLE_VALIDATE_SOCKET_COMMAND,
    type LibraryConvertItem,
    type TitleValidationSocketEvent,
} from '../shared/socket.js';
import { formatSize, formatTitleDisplay } from '../shared/shared.js';
import { formatActionStateIcon } from '../shared/action.js';
import {
    AvailableTitleEntry,
    PARENT_KINDS,
    type TitleDetails,
    type TitleEntry,
    type TitleGroup,
    type TitleInputControl,
    type WudTitleEntry,
    TitleKinds,
    classifyTitleId,
    getVirtualConsolePlatform,
} from '../shared/titles.js';
import { queueLibraryConvert, queueStorageCopy } from './api.js';
import { queueDelete } from './delete.js';
import {
    collectSelectedDownloads,
    formatDownloadProgress,
    getDownloadItem,
    getDownloadState,
    queueDownloads,
} from './download.js';
import {
    getEntry,
    getBaseBadgeState,
    getChildBadgeState,
    type SlotBadgeState,
    addAvailableEntry,
    createAvailableEntry,
    isAvailableEntryKind,
} from './library.js';
import { sendAppSocketCommand } from './app-socket.js';
import { getAvailableSizeBytes, getAvailableSizeText } from './main.js';

type TitleDetailOptions = {
    downloads: DownloadQueueItem[];
    deletes: DeleteItem[];
    storageCopies: StorageCopyItem[];
    libraryConversions: LibraryConvertItem[];
    titleValidations: Map<string, TitleValidationSocketEvent>;
    observeIcon: (image: HTMLImageElement, src: string) => void;
    populateFat32DeviceSelect: (
        select: HTMLSelectElement,
        copyButton: HTMLButtonElement
    ) => Promise<StorageFat32ListResponse | null>;
};

let options: TitleDetailOptions | null = null;

export function setupTitleDetails(nextOptions: TitleDetailOptions): void {
    options = nextOptions;
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

export function isValidationFailed(
    event: TitleValidationSocketEvent | null
): boolean {
    if (!event) {
        return false;
    }

    if (event.status === 'failed') {
        return true;
    }

    if (event.status === 'validating') {
        return true;
    }

    if (event.status !== 'complete') {
        return false;
    }

    return event.copies.some((copy) => copy.status === 'failed');
}

function hasUsableLocalEntry(
    group: TitleGroup,
    kind: TitleKinds,
    titleValidations: Map<string, TitleValidationSocketEvent> | null
): boolean {
    const localEntries = group.entries.filter((entry) => entry.kind === kind);

    if (localEntries.length === 0) {
        return false;
    }

    return localEntries.some((entry) => {
        const validation = titleValidations?.get(entry.titleId) ?? null;

        if (validation === null) {
            return false;
        }

        return !isValidationFailed(validation);
    });
}

function isRunningActionState(state: string): boolean {
    return state === 'queued' || state === 'in-progress';
}

function getActionItemKind(
    group: TitleGroup,
    titleId: string | null,
    kind: TitleKinds | null
): TitleKinds | null {
    if (kind) {
        return kind;
    }

    return (
        group.entries.find(
            (entry) => entry.titleId.toLowerCase() === titleId?.toLowerCase()
        )?.kind ?? null
    );
}

function getBusyKinds(group: TitleGroup): Set<TitleKinds> {
    const busyKinds = new Set<TitleKinds>();
    const detailOptions = options;
    if (!detailOptions) {
        return busyKinds;
    }

    for (const item of detailOptions.downloads) {
        if (item.family === group.family && isRunningActionState(item.state)) {
            busyKinds.add(item.kind);
        }
    }

    for (const item of detailOptions.libraryConversions) {
        if (
            item.titleId.slice(8) === group.family &&
            isRunningActionState(item.state)
        ) {
            busyKinds.add(item.kind);
        }
    }

    for (const item of [
        ...detailOptions.deletes,
        ...detailOptions.storageCopies,
    ]) {
        if (
            item.titleId?.slice(8) !== group.family ||
            !isRunningActionState(item.state)
        ) {
            continue;
        }

        const kind = getActionItemKind(group, item.titleId, item.titleKind);
        if (kind) {
            busyKinds.add(kind);
        }
    }

    return busyKinds;
}

function hasBusyEntryKind(
    busyKinds: Set<TitleKinds>,
    entries: Array<{ kind: TitleKinds }>
): boolean {
    return entries.some((entry) => busyKinds.has(entry.kind));
}

function renderDownloadAvailabilityRow(
    queue: DownloadQueueItem[],
    group: TitleGroup,
    entry: TitleGroup['availableEntries'][number]
): HTMLLabelElement | HTMLDivElement {
    const versions = formatVersions(entry.versions);
    const label = versions ? `${entry.kind} ${versions}` : entry.kind;
    const sizeText = getAvailableSizeText(entry);
    const existingQueueItem = getDownloadItem(
        queue,
        group.family,
        entry.kind,
        entry.titleId
    );

    if (existingQueueItem) {
        const row = document.createElement('div');
        row.className = `sidebar-download-row sidebar-storage-copy-row sidebar-download-row-${existingQueueItem.state}`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'sidebar-download-checkbox';
        checkbox.disabled = true;

        const slot = document.createElement('span');
        slot.className = 'sidebar-download-slot';
        slot.textContent = label;

        const titleId = document.createElement('span');
        titleId.className = 'sidebar-download-id';
        titleId.textContent = entry.titleId;

        const progress = document.createElement('span');
        progress.className =
            'sidebar-storage-validation-state sidebar-download-progress';
        progress.textContent = formatDownloadProgress(existingQueueItem);

        row.append(checkbox, slot, titleId, progress);
        return row;
    }

    const row = document.createElement('label');
    row.className = 'sidebar-download-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'sidebar-download-checkbox';
    checkbox.value = entry.titleId;
    checkbox.dataset.family = group.family;
    checkbox.dataset.groupName = group.name;
    checkbox.dataset.kind = entry.kind;
    checkbox.dataset.label = label;
    checkbox.dataset.titleId = entry.titleId;
    checkbox.dataset.sizeText = sizeText;

    const sizeBytes = getAvailableSizeBytes(entry);
    if (sizeBytes !== null) {
        checkbox.dataset.totalBytes = String(sizeBytes);
    }

    checkbox.disabled =
        !entry.availableOnCdn || getBusyKinds(group).has(entry.kind);
    if (!entry.availableOnCdn) {
        row.classList.add('sidebar-download-row-unavailable');
    }

    const slot = document.createElement('span');
    slot.className = 'sidebar-download-slot';
    slot.textContent = label;

    const titleId = document.createElement('span');
    titleId.className = 'sidebar-download-id';
    titleId.textContent = entry.titleId;

    const size = document.createElement('span');
    size.className = 'sidebar-download-size';
    size.textContent = entry.availableOnCdn ? sizeText : 'Not on CDN';

    row.append(checkbox, slot, titleId, size);
    return row;
}

function renderDetailRow(label: string, value: string | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sidebar-row';

    const labelElement = document.createElement('dt');
    labelElement.textContent = label;

    const valueElement = document.createElement('dd');
    valueElement.textContent = value && value.length > 0 ? value : '-';

    row.append(labelElement, valueElement);
    return row;
}

function formatTitleValidationStatus(
    event: TitleValidationSocketEvent | null
): string {
    if (!event) {
        return '';
    }

    switch (event.status) {
        case 'validating':
            return 'Checking';
        case 'failed':
            return 'Check failed';
        case 'complete': {
            const failedFiles = event.copies.reduce(
                (sum, copy) => sum + copy.failedCount,
                0
            );
            const totalFiles = event.copies.reduce(
                (sum, copy) => sum + copy.totalCount,
                0
            );

            return failedFiles > 0
                ? `${failedFiles} / ${totalFiles} failed`
                : `${totalFiles} / ${totalFiles} validated`;
        }
    }
}

function getTitleValidationFailedCount(
    validation: TitleValidationSocketEvent | null
): number {
    return (
        validation?.copies.reduce((sum, copy) => sum + copy.failedCount, 0) ?? 0
    );
}

function renderTitleValidationStatus(
    validation: TitleValidationSocketEvent | null
): HTMLElement {
    const validationStatus = document.createElement('span');
    validationStatus.className = 'sidebar-storage-validation-state';
    validationStatus.textContent = formatTitleValidationStatus(validation);

    if (validation?.status === 'complete') {
        const failedCount = getTitleValidationFailedCount(validation);

        validationStatus.classList.toggle(
            'sidebar-storage-validation-state-failed',
            failedCount > 0
        );
        validationStatus.classList.toggle(
            'sidebar-storage-validation-state-ok',
            failedCount === 0
        );
    } else if (validation?.status === 'failed') {
        validationStatus.classList.add(
            'sidebar-storage-validation-state-failed'
        );
    }

    return validationStatus;
}

function renderLocalCopyRow(
    group: TitleGroup,
    entry: TitleEntry,
    downloadData?: {
        group: TitleGroup;
        label: string;
    }
): HTMLElement {
    const row = document.createElement('label');
    row.className = 'sidebar-download-row sidebar-storage-copy-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = downloadData
        ? 'sidebar-download-checkbox sidebar-storage-copy-checkbox'
        : 'sidebar-storage-copy-checkbox';
    checkbox.value = entry.titleId;
    checkbox.dataset.titleId = entry.titleId;
    checkbox.dataset.copySizeBytes = String(entry.sizeBytes);
    checkbox.disabled = getBusyKinds(group).has(entry.kind);
    if (downloadData) {
        checkbox.dataset.family = downloadData.group.family;
        checkbox.dataset.groupName = downloadData.group.name;
        checkbox.dataset.kind = entry.kind;
        checkbox.dataset.label = downloadData.label;
        checkbox.dataset.sizeText = formatSize(entry.sizeBytes);
        checkbox.dataset.totalBytes = String(entry.sizeBytes);

        const existingDownload = getDownloadItem(
            options?.downloads ?? [],
            downloadData.group.family,
            entry.kind,
            entry.titleId
        );
        if (existingDownload) {
            checkbox.disabled = true;
            row.title = formatDownloadProgress(existingDownload);
        }
    }

    const slot = document.createElement('span');
    slot.className = 'sidebar-download-slot';
    slot.textContent = downloadData?.label ?? `${entry.kind} v${entry.version}`;

    const titleId = document.createElement('span');
    titleId.className = 'sidebar-download-id';
    titleId.textContent = entry.titleId;

    const validation = options?.titleValidations.get(entry.titleId) ?? null;
    const validationStatus = renderTitleValidationStatus(validation);

    const size = document.createElement('span');
    size.className = 'sidebar-download-size';
    size.textContent = formatSize(entry.sizeBytes);

    row.append(checkbox, slot, titleId, validationStatus, size);
    return row;
}

function renderDownloadedCopyRow(
    group: TitleGroup,
    entry: TitleEntry
): HTMLElement {
    return renderLocalCopyRow(group, entry);
}

function renderInvalidCopyRow(
    group: TitleGroup,
    entry: TitleEntry
): HTMLElement {
    return renderLocalCopyRow(group, entry, {
        group,
        label: `${entry.kind} v${entry.version}`,
    });
}

function getSelectedDownloadedTitleIds(
    root: HTMLElement,
    selectedOnly: boolean
): string[] {
    const selector = selectedOnly
        ? '.sidebar-storage-copy-checkbox:checked'
        : '.sidebar-storage-copy-checkbox';

    return Array.from(root.querySelectorAll<HTMLInputElement>(selector))
        .map((checkbox) => checkbox.dataset.titleId ?? '')
        .filter((titleId) => titleId.length > 0);
}

function getSelectedFat32Volume(
    response: StorageFat32ListResponse | null,
    select: HTMLSelectElement
): Fat32Volume | null {
    return (
        response?.volumes.find((volume) => volume.source === select.value) ??
        null
    );
}

function getStorageCopySelectionSizeBytes(
    root: HTMLElement,
    entries: TitleEntry[],
    selectedOnly: boolean
): number {
    const entriesByTitleId = new Map(
        entries.map((entry) => [entry.titleId, entry])
    );
    const selector = selectedOnly
        ? '.sidebar-storage-copy-checkbox:checked'
        : '.sidebar-storage-copy-checkbox';
    let sizeBytes = 0;

    for (const checkbox of root.querySelectorAll<HTMLInputElement>(selector)) {
        const titleId = checkbox.dataset.titleId ?? '';
        sizeBytes += entriesByTitleId.get(titleId)?.sizeBytes ?? 0;
    }

    return sizeBytes;
}

function updateStorageCopyAvailability(
    root: HTMLElement,
    entries: TitleEntry[],
    volume: Fat32Volume | null
): void {
    const entriesByTitleId = new Map(
        entries.map((entry) => [entry.titleId, entry])
    );

    for (const checkbox of root.querySelectorAll<HTMLInputElement>(
        '.sidebar-storage-copy-checkbox'
    )) {
        const titleId = checkbox.dataset.titleId ?? '';
        const entry = entriesByTitleId.get(titleId);
        const cannotFit =
            entry !== undefined &&
            volume?.freeBytes !== null &&
            volume?.freeBytes !== undefined &&
            entry.sizeBytes > volume.freeBytes;

        const row = checkbox.closest('.sidebar-download-row');
        row?.classList.toggle(
            'sidebar-storage-copy-row-insufficient-space',
            cannotFit
        );
        row?.toggleAttribute('data-copy-disabled', cannotFit);
        if (cannotFit && entry) {
            row?.setAttribute(
                'title',
                `Not enough free space on selected SD: ${formatSize(entry.sizeBytes)} needed, ${formatSize(volume.freeBytes)} available`
            );
        } else {
            row?.removeAttribute('title');
        }
    }
}

function formatDeleteConfirmationEntry(entry: TitleEntry): string {
    return formatTitleDisplay(
        entry.name,
        entry.titleId,
        entry.kind,
        entry.version
    );
}

async function confirmAndQueueDeletes(
    titleIds: string[],
    entries: TitleEntry[],
    deleteButton: HTMLButtonElement,
    label = 'local'
): Promise<void> {
    if (titleIds.length === 0) {
        return;
    }

    const selectedTitleIds = new Set(titleIds);
    const selectedEntries = entries.filter((entry) =>
        selectedTitleIds.has(entry.titleId)
    );
    const selectedText = selectedEntries
        .map(formatDeleteConfirmationEntry)
        .join('\n');
    const confirmed = window.confirm(
        selectedEntries.length === 1
            ? `Delete this ${label} title?\n\n${selectedText}`
            : `Delete these ${selectedEntries.length} ${label} titles?\n\n${selectedText}`
    );
    if (!confirmed) {
        return;
    }

    deleteButton.disabled = true;
    try {
        await Promise.all(titleIds.map((titleId) => queueDelete(titleId)));
    } finally {
        deleteButton.disabled = false;
    }
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

function renderDetailSection(title: string, action?: HTMLElement): HTMLElement {
    const heading = document.createElement('div');
    heading.className = 'sidebar-section';
    const label = document.createElement('span');
    label.textContent = title;
    heading.append(label);
    if (action) {
        heading.append(action);
    }
    return heading;
}

function queueSelectedDownloads(
    group: TitleGroup,
    list: HTMLElement,
    downloads: DownloadQueueItem[]
): DownloadQueueItem[] {
    const hasSelection =
        list.querySelectorAll('.sidebar-download-checkbox:checked').length > 0;

    const addedItems = queueDownloads(
        downloads,
        collectSelectedDownloads(list, hasSelection)
    );

    const body = document.querySelector('.sidebar-body');
    body?.replaceChildren(renderGroupDetailContent(group));
    return addedItems;
}

function hasDownloadableCheckboxes(list: HTMLElement): boolean {
    return getActiveDownloadCheckboxes(list, false).length > 0;
}

function getActiveDownloadCheckboxes(
    list: HTMLElement,
    selectedOnly: boolean
): HTMLInputElement[] {
    const selector = selectedOnly
        ? '.sidebar-download-checkbox:checked:not(:disabled)'
        : '.sidebar-download-checkbox:not(:disabled)';
    return Array.from(list.querySelectorAll<HTMLInputElement>(selector));
}

function renderAvailableActions(
    group: TitleGroup,
    list: HTMLElement,
    entries: TitleGroup['availableEntries'],
    downloads: DownloadQueueItem[]
): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'sidebar-download-actions sidebar-available-actions';

    const spacer = document.createElement('div');
    const downloadButton = document.createElement('button');
    downloadButton.className = 'sidebar-button';
    const busyKinds = getBusyKinds(group);
    downloadButton.type = 'button';
    const updateDownloadButton = (): void => {
        const checkedCount = list.querySelectorAll(
            '.sidebar-download-checkbox:checked'
        ).length;
        const targetCount = getActiveDownloadCheckboxes(
            list,
            checkedCount > 0
        ).length;

        downloadButton.textContent =
            checkedCount === 0 ? 'Download all' : 'Download selected';
        downloadButton.disabled =
            targetCount === 0 ||
            (checkedCount === 0 && hasBusyEntryKind(busyKinds, entries));
    };

    updateDownloadButton();

    list.addEventListener('change', updateDownloadButton);
    downloadButton.addEventListener('click', () => {
        queueSelectedDownloads(group, list, downloads);
        updateDownloadButton();
    });

    actions.append(spacer, downloadButton);
    return actions;
}

function renderInvalidActions(
    group: TitleGroup,
    list: HTMLElement,
    entries: TitleEntry[],
    downloads: DownloadQueueItem[]
): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'sidebar-download-actions sidebar-invalid-actions';

    const downloadButton = document.createElement('button');
    downloadButton.className = 'sidebar-button';
    downloadButton.type = 'button';

    const deleteButton = document.createElement('button');
    deleteButton.className = 'sidebar-button';
    const busyKinds = getBusyKinds(group);
    deleteButton.type = 'button';

    const updateButtons = (): void => {
        const checkedCount = list.querySelectorAll(
            '.sidebar-storage-copy-checkbox:checked'
        ).length;

        downloadButton.textContent =
            checkedCount === 0 ? 'Download all' : 'Download selected';
        deleteButton.textContent =
            checkedCount === 0 ? 'Delete all' : 'Delete selected';
        downloadButton.disabled =
            entries.length === 0 ||
            !hasDownloadableCheckboxes(list) ||
            (checkedCount === 0 && hasBusyEntryKind(busyKinds, entries));
        deleteButton.disabled =
            entries.length === 0 ||
            (checkedCount === 0 && hasBusyEntryKind(busyKinds, entries));
    };

    updateButtons();
    list.addEventListener('change', updateButtons);

    downloadButton.addEventListener('click', () => {
        queueSelectedDownloads(group, list, downloads);
        updateButtons();
    });

    deleteButton.addEventListener('click', () => {
        void (async () => {
            const hasSelection =
                list.querySelectorAll('.sidebar-storage-copy-checkbox:checked')
                    .length > 0;
            const titleIds = getSelectedDownloadedTitleIds(list, hasSelection);

            await confirmAndQueueDeletes(
                titleIds,
                entries,
                deleteButton,
                'invalid local'
            );
        })();
    });

    actions.append(deleteButton, downloadButton);
    return actions;
}

function formatVersions(versions: number[]): string {
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
    downloadMarker.textContent = formatActionStateIcon(downloadState, '↓');
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

function renderWudBadge(group: TitleGroup): HTMLElement | null {
    if (group.wudEntries.length === 0) {
        return null;
    }

    const badge = document.createElement('div');
    badge.className = 'title-slot-badge title-slot-badge-wud';
    badge.textContent = 'WUD';
    const sourceCount = group.wudEntries.reduce(
        (total, entry) => total + entry.copyCount,
        0
    );
    badge.title = `${sourceCount} disc image source(s)`;
    return badge;
}

function renderWudContent(group: TitleGroup): {
    content: HTMLElement;
    convertButton: HTMLButtonElement;
} {
    const content = document.createElement('div');
    content.className = 'sidebar-download-content sidebar-wud-content';
    const titles = group.wudEntries.flatMap((entry) => entry.titles);
    const baseTitle = titles.find(
        (title) => classifyTitleId(title.titleId).kind === TitleKinds.Base
    );
    const conversionTitle = baseTitle ?? titles[0];

    const convertButton = document.createElement('button');
    convertButton.className = 'sidebar-button';
    convertButton.type = 'button';
    convertButton.textContent = 'Convert';
    convertButton.disabled = getBusyKinds(group).has(TitleKinds.Base);
    convertButton.title = 'Convert the disc image to installable title content';
    convertButton.addEventListener('click', () => {
        if (!conversionTitle || convertButton.disabled) {
            return;
        }

        convertButton.disabled = true;
        void queueLibraryConvert(conversionTitle.titleId).catch((error) => {
            console.error(error);
            convertButton.disabled = false;
        });
    });

    const list = document.createElement('div');
    list.className = 'sidebar-download-list';
    const renderWudRow = (
        label: string,
        title: WudTitleEntry['titles'][number] | undefined
    ): HTMLElement => {
        const row = document.createElement('div');
        row.className = 'sidebar-download-row sidebar-wud-row';
        row.classList.add('sidebar-wud-row-muted');

        const checkboxSpace = document.createElement('span');
        checkboxSpace.className = 'sidebar-wud-checkbox-space';

        const slot = document.createElement('span');
        slot.className = 'sidebar-download-slot';
        slot.textContent = title ? `${label} v${title.version}` : label;

        const id = document.createElement('span');
        id.className = 'sidebar-download-id';
        id.textContent = title?.titleId ?? '-';
        id.title = title?.titleId ?? '';

        row.append(checkboxSpace, slot, id);
        return row;
    };

    const updateTitle = titles.find(
        (title) => classifyTitleId(title.titleId).kind === TitleKinds.Update
    );
    const dlcTitle = titles.find(
        (title) => classifyTitleId(title.titleId).kind === TitleKinds.DLC
    );

    const rows = [
        ['Base', baseTitle],
        ['Update', updateTitle],
        ['DLC', dlcTitle],
    ] as const;
    for (const [label, title] of rows) {
        if (title) {
            list.append(renderWudRow(label, title));
        }
    }

    content.append(list);
    return { content, convertButton };
}

export function renderGroupDetailContent(group: TitleGroup): DocumentFragment {
    const detailOptions = options;
    const fragment = document.createDocumentFragment();
    const summary = document.createElement('div');
    summary.className = 'sidebar-summary';

    const list = document.createElement('dl');
    list.className = 'sidebar-list';

    const metadata = group.details;
    list.append(
        renderDetailRow('TV Format', metadata?.tvFormat ?? null),
        renderDetailRow('Languages', metadata?.languages.join(', ') ?? null),
        renderDetailRow('Developer', metadata?.developer ?? null),
        renderDetailRow('Genre', metadata?.genre.join(', ') ?? null),
        renderDetailRow('Input', metadata ? formatInput(metadata) : null)
    );

    const bottom = document.createElement('div');
    bottom.className = 'sidebar-bottom';

    summary.append(list);
    fragment.append(summary);

    const synopsis = document.createElement('p');
    synopsis.className = 'sidebar-synopsis';
    synopsis.textContent = metadata?.synopsis?.replace(/\n+/g, '\n\n') ?? '';
    fragment.append(synopsis);

    const availability = document.createElement('div');
    availability.className = 'sidebar-availability';

    const localEntries = group.entries
        .filter((entry) => {
            const validation =
                detailOptions?.titleValidations?.get(entry.titleId) ?? null;
            return !isValidationFailed(validation);
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));
    const invalidEntries = group.entries
        .filter((entry) => {
            const validation =
                detailOptions?.titleValidations?.get(entry.titleId) ?? null;
            return isValidationFailed(validation);
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));

    if (group.wudEntries.length > 0) {
        const wud = renderWudContent(group);
        availability.append(
            renderDetailSection('WUD', wud.convertButton),
            wud.content
        );
    }

    if (localEntries.length > 0) {
        const localList = document.createElement('div');
        localList.className = 'sidebar-download-list';

        for (const entry of localEntries) {
            localList.append(renderDownloadedCopyRow(group, entry));
        }

        const actions = document.createElement('div');
        actions.className =
            'sidebar-download-actions sidebar-storage-copy-actions';

        const destinationSelect = document.createElement('select');
        destinationSelect.className = 'sidebar-storage-copy-destination';
        destinationSelect.disabled = true;
        const loadingOption = document.createElement('option');
        loadingOption.textContent = 'Loading FAT32 devices...';
        destinationSelect.append(loadingOption);

        const copyButton = document.createElement('button');
        copyButton.className = 'sidebar-button';
        copyButton.type = 'button';
        copyButton.disabled = true;

        const deleteButton = document.createElement('button');
        deleteButton.className = 'sidebar-button';
        deleteButton.type = 'button';
        const busyKinds = getBusyKinds(group);

        let fat32Response: StorageFat32ListResponse | null = null;

        const updateDownloadedButtons = (): void => {
            const selectedVolume = getSelectedFat32Volume(
                fat32Response,
                destinationSelect
            );
            updateStorageCopyAvailability(
                localList,
                localEntries,
                selectedVolume
            );
            const checkedCount = localList.querySelectorAll(
                '.sidebar-storage-copy-checkbox:checked'
            ).length;
            const hasCopyDestination =
                !destinationSelect.disabled && destinationSelect.value !== '';
            const selectedSizeBytes = getStorageCopySelectionSizeBytes(
                localList,
                localEntries,
                checkedCount > 0
            );
            const freeBytes = selectedVolume?.freeBytes;
            const hasEnoughFreeSpace =
                freeBytes === null ||
                freeBytes === undefined ||
                selectedSizeBytes <= freeBytes;

            copyButton.textContent = !hasEnoughFreeSpace
                ? 'Free space exceeded'
                : checkedCount === 0
                  ? 'Copy all to SD'
                  : 'Copy selected to SD';
            deleteButton.textContent =
                checkedCount === 0 ? 'Delete all' : 'Delete selected';
            copyButton.disabled =
                localEntries.length === 0 ||
                !hasCopyDestination ||
                !hasEnoughFreeSpace ||
                (checkedCount === 0 &&
                    hasBusyEntryKind(busyKinds, localEntries));
            deleteButton.disabled =
                localEntries.length === 0 ||
                (checkedCount === 0 &&
                    hasBusyEntryKind(busyKinds, localEntries));
            copyButton.title =
                hasCopyDestination && !hasEnoughFreeSpace && selectedVolume
                    ? `Not enough free space: ${formatSize(selectedSizeBytes)} selected, ${formatSize(freeBytes ?? null)} available`
                    : '';
        };

        updateDownloadedButtons();
        localList.addEventListener('change', updateDownloadedButtons);
        destinationSelect.addEventListener('change', updateDownloadedButtons);
        if (detailOptions) {
            void detailOptions
                .populateFat32DeviceSelect(destinationSelect, copyButton)
                .then((response) => {
                    fat32Response = response;
                    updateDownloadedButtons();
                });
        }

        copyButton.addEventListener('click', () => {
            void (async () => {
                const hasSelection =
                    localList.querySelectorAll(
                        '.sidebar-storage-copy-checkbox:checked'
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
                    copyButton.disabled =
                        localEntries.length === 0 || destinationSelect.disabled;
                }
            })();
        });

        deleteButton.addEventListener('click', () => {
            void (async () => {
                const hasSelection =
                    localList.querySelectorAll(
                        '.sidebar-storage-copy-checkbox:checked'
                    ).length > 0;
                const titleIds = getSelectedDownloadedTitleIds(
                    localList,
                    hasSelection
                );

                await confirmAndQueueDeletes(
                    titleIds,
                    localEntries,
                    deleteButton
                );
            })();
        });

        actions.append(destinationSelect, copyButton, deleteButton);

        const downloadedContent = document.createElement('div');
        downloadedContent.className =
            'sidebar-download-content sidebar-storage-copy-content';
        downloadedContent.append(localList, actions);

        availability.append(
            renderDetailSection('Downloaded'),
            downloadedContent
        );
    }

    if (invalidEntries.length > 0) {
        const invalidList = document.createElement('div');
        invalidList.className = 'sidebar-download-list';

        for (const entry of invalidEntries) {
            invalidList.append(renderInvalidCopyRow(group, entry));
        }

        const invalidContent = document.createElement('div');
        invalidContent.className =
            'sidebar-download-content sidebar-invalid-content';
        invalidContent.append(
            invalidList,
            renderInvalidActions(
                group,
                invalidList,
                invalidEntries,
                detailOptions?.downloads ?? []
            )
        );

        availability.append(renderDetailSection('Invalid'), invalidContent);
    }

    const availableEntries = group.availableEntries
        .filter((entry) => {
            const invalid = invalidEntries.some(
                (candidate) =>
                    candidate.kind === entry.kind &&
                    candidate.titleId.toLowerCase() ===
                        entry.titleId.toLowerCase()
            );
            if (invalid) {
                return false;
            }

            const usable = hasUsableLocalEntry(
                group,
                entry.kind,
                detailOptions?.titleValidations ?? null
            );

            return !usable;
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));

    if (availableEntries.length > 0) {
        const availableList = document.createElement('div');
        availableList.className = 'sidebar-download-list';

        for (const entry of availableEntries) {
            availableList.append(
                renderDownloadAvailabilityRow(
                    detailOptions?.downloads ?? [],
                    group,
                    entry
                )
            );
        }

        const availableContent = document.createElement('div');
        availableContent.className =
            'sidebar-download-content sidebar-available-content';
        availableContent.append(
            availableList,
            renderAvailableActions(
                group,
                availableList,
                availableEntries,
                detailOptions?.downloads ?? []
            )
        );

        availability.append(renderDetailSection('Available'), availableContent);
    }

    bottom.append(availability);
    fragment.append(bottom);

    return fragment;
}

function requestTitleValidation(titleId: string, name: string): void {
    sendAppSocketCommand({
        type: TITLE_VALIDATE_SOCKET_COMMAND.queue,
        titleId,
        name,
    });
}

export function requestTitleValidations(group: TitleGroup): void {
    for (const entry of group.entries) {
        requestTitleValidation(entry.titleId, entry.name);
    }
}

function validationToAvailableEntry(
    title: LibraryValidateTitle
): AvailableTitleEntry | null {
    if (
        title.status !== 'failed' ||
        title.titleId === null ||
        !isAvailableEntryKind(title.kind)
    ) {
        return null;
    }

    return createAvailableEntry({
        titleId: title.titleId,
        name: title.name,
        region: null,
        iconUrl: null,
        version: title.version ?? 0,
        kind: title.kind,
        sizeBytes: 0,
        copyCount: 1,
    });
}

export function mergeFailedValidationsIntoAvailable(
    groups: TitleGroup[],
    titles: LibraryValidateTitle[]
): TitleGroup[] {
    const changedGroups: TitleGroup[] = [];

    for (const title of titles) {
        const entry = validationToAvailableEntry(title);

        if (!entry) {
            continue;
        }

        const family = classifyTitleId(entry.titleId).family;
        const group = groups.find(
            (candidate) => candidate.family.toLowerCase() === family
        );

        if (!group) {
            console.warn('No group found for failed validation', {
                titleId: entry.titleId,
                family,
                title,
            });
            continue;
        }

        // Remove the failed entry from group.entries so it no longer
        // appears in the Downloaded section or influences status computation.
        const entryIndex = group.entries.findIndex(
            (candidate) =>
                candidate.kind === entry.kind &&
                candidate.titleId.toLowerCase() === entry.titleId
        );
        if (entryIndex !== -1) {
            group.entries.splice(entryIndex, 1);
        }

        addAvailableEntry(group, entry);

        if (!changedGroups.includes(group)) {
            changedGroups.push(group);
        }
    }

    return changedGroups;
}

export function renderGroup(
    group: TitleGroup,
    onSelect: (group: TitleGroup) => void,
    selectedFamily: string | null = null
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
    const wudBadge = renderWudBadge(group);
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
