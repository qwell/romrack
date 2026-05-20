import {
    LibraryValidateTitle,
    type StorageFat32ListResponse,
} from '../shared/api.js';
import { type DownloadQueueItem } from '../shared/download.js';
import { type Fat32Volume } from '../shared/os.js';
import {
    TITLE_VERIFY_SOCKET_COMMAND,
    type TitleVerifySocketEvent,
} from '../shared/socket.js';
import { formatSize } from '../shared/shared.js';
import {
    AvailableTitleEntry,
    PARENT_KINDS,
    type TitleDetails,
    type TitleEntry,
    type TitleGroup,
    type TitleInputControl,
    TitleKinds,
    getVirtualConsolePlatform,
} from '../shared/titles.js';
import { queueStorageCopy } from './api.js';
import { queueDelete } from './delete.js';
import {
    collectSelectedDownloads,
    formatDownloadIcon,
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
    titleVerifications: Map<string, TitleVerifySocketEvent>;
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

function isLocalEntryVerificationFailed(
    entry: TitleEntry,
    titleVerifications: Map<string, TitleVerifySocketEvent> | null
): boolean {
    const verification = titleVerifications?.get(entry.titleId) ?? null;

    return isVerificationFailed(verification);
}

export function isVerificationFailed(
    event: TitleVerifySocketEvent | null
): boolean {
    if (!event) {
        return false;
    }

    if (event.status === 'failed') {
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
    titleVerifications: Map<string, TitleVerifySocketEvent> | null
): boolean {
    const localEntries = group.entries.filter((entry) => entry.kind === kind);

    if (localEntries.length === 0) {
        return false;
    }

    return localEntries.some((entry) => {
        const verification = titleVerifications?.get(entry.titleId) ?? null;

        if (verification === null) {
            return false;
        }

        return !isVerificationFailed(verification);
    });
}

export function renderDownloadAvailabilityRow(
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
        row.className = `title-download-row title-download-row-${existingQueueItem.state}`;

        const state = document.createElement('span');
        state.className = 'title-download-state';
        state.textContent = formatDownloadIcon(existingQueueItem.state);

        const slot = document.createElement('span');
        slot.className = 'title-download-slot';
        slot.textContent = label;

        const titleId = document.createElement('span');
        titleId.className = 'title-download-id';
        titleId.textContent = formatDownloadProgress(existingQueueItem);

        const size = document.createElement('span');
        size.className = 'title-download-size';
        size.textContent = sizeText ?? '';

        row.append(slot, titleId, size, state);
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

export function formatTitleKind(kind: TitleKinds | string): string {
    return kind === String(TitleKinds.Base) ? 'Game' : kind;
}

function formatTitleVerificationStatus(
    event: TitleVerifySocketEvent | null
): string {
    if (!event) {
        return '';
    }

    switch (event.status) {
        case 'verifying':
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
                ? `${failedFiles}/${totalFiles} failed`
                : `${totalFiles}/${totalFiles} verified`;
        }
    }
}

function getTitleVerificationFailedCount(
    verification: TitleVerifySocketEvent | null
): number {
    return (
        verification?.copies.reduce((sum, copy) => sum + copy.failedCount, 0) ??
        0
    );
}

function renderTitleVerificationStatus(
    verification: TitleVerifySocketEvent | null
): HTMLElement {
    const verificationStatus = document.createElement('span');
    verificationStatus.className = 'title-storage-verification-state';
    verificationStatus.textContent =
        formatTitleVerificationStatus(verification);

    if (verification?.status === 'complete') {
        const failedCount = getTitleVerificationFailedCount(verification);

        verificationStatus.classList.toggle(
            'title-storage-verification-state-failed',
            failedCount > 0
        );
        verificationStatus.classList.toggle(
            'title-storage-verification-state-ok',
            failedCount === 0
        );
    } else if (verification?.status === 'failed') {
        verificationStatus.classList.add(
            'title-storage-verification-state-failed'
        );
    }

    return verificationStatus;
}

function renderLocalCopyRow(
    entry: TitleEntry,
    downloadData?: {
        group: TitleGroup;
        label: string;
    }
): HTMLElement {
    const row = document.createElement('label');
    row.className = 'title-download-row title-storage-copy-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = downloadData
        ? 'title-download-checkbox title-storage-copy-checkbox'
        : 'title-storage-copy-checkbox';
    checkbox.value = entry.titleId;
    checkbox.dataset.titleId = entry.titleId;
    checkbox.dataset.copySizeBytes = String(entry.sizeBytes);
    if (downloadData) {
        checkbox.dataset.family = downloadData.group.family;
        checkbox.dataset.groupName = downloadData.group.name;
        checkbox.dataset.kind = entry.kind;
        checkbox.dataset.label = downloadData.label;
        checkbox.dataset.sizeText = formatSize(entry.sizeBytes);
        checkbox.dataset.totalBytes = String(entry.sizeBytes);
    }

    const slot = document.createElement('span');
    slot.className = 'title-download-slot';
    slot.textContent =
        downloadData?.label ??
        `${formatTitleKind(entry.kind)} v${entry.version}`;

    const titleId = document.createElement('span');
    titleId.className = 'title-download-id';
    titleId.textContent = entry.titleId;

    const copyCount = document.createElement('span');
    copyCount.className = 'title-download-copy-count';
    copyCount.textContent =
        entry.copyCount > 1 ? `(${entry.copyCount} copies)` : '';

    const verification = options?.titleVerifications.get(entry.titleId) ?? null;
    const verificationStatus = renderTitleVerificationStatus(verification);

    const size = document.createElement('span');
    size.className = 'title-download-size';
    size.textContent = formatSize(entry.sizeBytes);

    row.append(checkbox, slot, titleId, copyCount, verificationStatus, size);
    return row;
}

function renderDownloadedCopyRow(entry: TitleEntry): HTMLElement {
    return renderLocalCopyRow(entry);
}

function renderInvalidCopyRow(
    group: TitleGroup,
    entry: TitleEntry
): HTMLElement {
    return renderLocalCopyRow(entry, {
        group,
        label: `${formatTitleKind(entry.kind)} v${entry.version}`,
    });
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
        ? '.title-storage-copy-checkbox:checked'
        : '.title-storage-copy-checkbox';
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
        '.title-storage-copy-checkbox'
    )) {
        const titleId = checkbox.dataset.titleId ?? '';
        const entry = entriesByTitleId.get(titleId);
        const cannotFit =
            entry !== undefined &&
            volume?.freeBytes !== null &&
            volume?.freeBytes !== undefined &&
            entry.sizeBytes > volume.freeBytes;

        const row = checkbox.closest('.title-download-row');
        row?.classList.toggle(
            'title-storage-copy-row-insufficient-space',
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
    const copyText = entry.copyCount > 1 ? ` (${entry.copyCount} copies)` : '';
    return `${entry.name} v${entry.version} [${formatTitleKind(entry.kind)}] ${entry.titleId}${copyText}`;
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

function renderDetailSection(title: string): HTMLElement {
    const heading = document.createElement('div');
    heading.className = 'title-detail-section';
    heading.textContent = title;
    return heading;
}

function queueSelectedDownloads(
    group: TitleGroup,
    list: HTMLElement,
    downloads: DownloadQueueItem[]
): void {
    const hasSelection =
        list.querySelectorAll('.title-download-checkbox:checked').length > 0;

    queueDownloads(downloads, collectSelectedDownloads(list, hasSelection));

    const body = document.querySelector('.title-detail-body');
    body?.replaceChildren(renderGroupDetailContent(group));
}

function renderAvailableActions(
    group: TitleGroup,
    list: HTMLElement,
    downloads: DownloadQueueItem[]
): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'title-download-actions title-available-actions';

    const spacer = document.createElement('div');
    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    const updateDownloadButton = (): void => {
        const checkedCount = list.querySelectorAll(
            '.title-download-checkbox:checked'
        ).length;

        downloadButton.textContent =
            checkedCount === 0 ? 'Download all' : 'Download selected';
    };

    downloadButton.disabled = false;
    updateDownloadButton();

    list.addEventListener('change', updateDownloadButton);
    downloadButton.addEventListener('click', () => {
        queueSelectedDownloads(group, list, downloads);
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
    actions.className = 'title-download-actions title-invalid-actions';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';

    const updateButtons = (): void => {
        const checkedCount = list.querySelectorAll(
            '.title-storage-copy-checkbox:checked'
        ).length;

        downloadButton.textContent =
            checkedCount === 0 ? 'Download all' : 'Download selected';
        deleteButton.textContent =
            checkedCount === 0 ? 'Delete all' : 'Delete selected';
        downloadButton.disabled = entries.length === 0;
        deleteButton.disabled = entries.length === 0;
    };

    updateButtons();
    list.addEventListener('change', updateButtons);

    downloadButton.addEventListener('click', () => {
        queueSelectedDownloads(group, list, downloads);
    });

    deleteButton.addEventListener('click', () => {
        void (async () => {
            const hasSelection =
                list.querySelectorAll('.title-storage-copy-checkbox:checked')
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

export function renderGroupDetailContent(group: TitleGroup): DocumentFragment {
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

    const localEntries = group.entries
        .filter((entry) => {
            const verification =
                detailOptions?.titleVerifications?.get(entry.titleId) ?? null;
            return !isVerificationFailed(verification);
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));
    const invalidEntries = group.entries
        .filter((entry) => {
            const verification =
                detailOptions?.titleVerifications?.get(entry.titleId) ?? null;
            return isVerificationFailed(verification);
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));

    const actionableLocalEntries = localEntries.filter(
        (entry) =>
            !isLocalEntryVerificationFailed(
                entry,
                detailOptions?.titleVerifications ?? null
            )
    );

    if (localEntries.length > 0) {
        const localList = document.createElement('div');
        localList.className = 'title-download-list';

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

        let fat32Response: StorageFat32ListResponse | null = null;

        const updateDownloadedButtons = (): void => {
            const selectedVolume = getSelectedFat32Volume(
                fat32Response,
                destinationSelect
            );
            updateStorageCopyAvailability(
                localList,
                actionableLocalEntries,
                selectedVolume
            );
            const checkedCount = localList.querySelectorAll(
                '.title-storage-copy-checkbox:checked'
            ).length;
            const hasCopyDestination =
                !destinationSelect.disabled && destinationSelect.value !== '';
            const selectedSizeBytes = getStorageCopySelectionSizeBytes(
                localList,
                actionableLocalEntries,
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
                actionableLocalEntries.length === 0 ||
                !hasCopyDestination ||
                !hasEnoughFreeSpace;
            deleteButton.disabled = actionableLocalEntries.length === 0;
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
                    copyButton.disabled =
                        actionableLocalEntries.length === 0 ||
                        destinationSelect.disabled;
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

                await confirmAndQueueDeletes(
                    titleIds,
                    actionableLocalEntries,
                    deleteButton
                );
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

    if (invalidEntries.length > 0) {
        const invalidList = document.createElement('div');
        invalidList.className = 'title-download-list';

        for (const entry of invalidEntries) {
            invalidList.append(renderInvalidCopyRow(group, entry));
        }

        const invalidContent = document.createElement('div');
        invalidContent.className =
            'title-download-content title-invalid-content';
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
                detailOptions?.titleVerifications ?? null
            );

            return !usable;
        })
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

        const availableContent = document.createElement('div');
        availableContent.className =
            'title-download-content title-available-content';
        availableContent.append(
            availableList,
            renderAvailableActions(
                group,
                availableList,
                detailOptions?.downloads ?? []
            )
        );

        availability.append(renderDetailSection('Available'), availableContent);
    }

    bottom.append(availability);
    fragment.append(bottom);

    return fragment;
}

export function requestTitleVerification(titleId: string, name: string): void {
    sendAppSocketCommand({
        type: TITLE_VERIFY_SOCKET_COMMAND.queue,
        titleId,
        name,
    });
}

export function requestTitleVerifications(group: TitleGroup): void {
    for (const entry of group.entries) {
        requestTitleVerification(entry.titleId, entry.name);
    }
}

function isDownloadableValidationKind(
    kind: TitleKinds
): kind is TitleKinds.Base | TitleKinds.Update | TitleKinds.DLC {
    return isAvailableEntryKind(kind);
}

function validationToAvailableEntry(
    title: LibraryValidateTitle
): AvailableTitleEntry | null {
    if (
        title.status !== 'failed' ||
        title.titleId === null ||
        !isDownloadableValidationKind(title.kind)
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

function getTitleFamily(titleId: string): string {
    const normalized = titleId.toLowerCase();

    return normalized.slice(8);
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

        const family = getTitleFamily(entry.titleId);
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
