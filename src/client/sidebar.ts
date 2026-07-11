import { type StorageFat32ListResponse } from '../shared/api.js';
import { type Fat32Volume } from '../shared/os/types.js';
import { type TitleValidationSocketEvent } from '../shared/socket.js';
import { formatSize } from '../shared/utils.js';
import {
    type TitleDetails,
    type TitleEntry,
    type TitleGroup,
    type TitleInputControl,
    type TitlePlatform,
    TitleKinds,
} from '../shared/titles.js';
type SidebarOptions = {
    titleValidations: Map<string, TitleValidationSocketEvent>;
    onActionsChanged: () => void;
    getDownloadProgress: (
        family: string,
        kind: TitleKinds,
        titleId?: string
    ) => string | null;
    queueSelectedDownloads: (root: HTMLElement, selectedOnly: boolean) => void;
    getBusyKinds: (group: TitleGroup) => Set<TitleKinds>;
    confirmAndQueueStorageDeletes: (
        titleIds: string[],
        entries: TitleEntry[],
        button: HTMLButtonElement,
        label?: string
    ) => Promise<void>;
    queueStorageCopy: (
        titleId: string,
        destination: string
    ) => Promise<unknown>;
    requestTitleValidation: (titleId: string, name: string) => void;
    isTitleValidationUnavailable: (
        event: TitleValidationSocketEvent | null
    ) => boolean;
    renderWud: (
        group: TitleGroup,
        conversionBusy: boolean
    ) => { content: HTMLElement; action: HTMLElement };
    populateFat32DeviceSelect: (
        select: HTMLSelectElement,
        copyButton: HTMLButtonElement
    ) => Promise<StorageFat32ListResponse | null>;
};

let options: SidebarOptions | null = null;
let selectedFamily: string | null = null;

function getAvailableSizeBytes(entry: unknown): number | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const sizeBytes = (entry as { sizeBytes?: unknown }).sizeBytes;
    return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes)
        ? sizeBytes
        : null;
}

function getAvailableSizeText(entry: unknown): string {
    return formatSize(getAvailableSizeBytes(entry));
}

function getSidebarBannerUrl(group: TitleGroup): string | null {
    return group.bannerUrl ?? group.iconUrl;
}

function buildSidebarImage(group: TitleGroup, src: string): HTMLElement {
    const placeholder = document.createElement('div');
    const platformClass = `platform-${group.platform}`;
    placeholder.className = `sidebar-thumbnail-placeholder ${platformClass}`;

    const image = document.createElement('img');
    image.className = `sidebar-thumbnail-image-loading ${platformClass}`;
    image.alt = group.name;
    image.decoding = 'async';
    image.addEventListener('load', () => {
        image.classList.remove('sidebar-thumbnail-image-loading');
        placeholder.replaceWith(image);
    });
    image.addEventListener('error', () => {
        image.remove();
        placeholder.classList.add('sidebar-thumbnail-placeholder-error');
        placeholder.textContent = '⊗';
        placeholder.setAttribute('role', 'img');
        placeholder.setAttribute(
            'aria-label',
            `${group.name} image unavailable`
        );
    });
    image.src = src;

    placeholder.append(image);
    return placeholder;
}

export function setupSidebar(nextOptions: SidebarOptions): void {
    options = nextOptions;
}

export function getSelectedDetailFamily(): string | null {
    return selectedFamily;
}

export function hasOpenDetailFamily(): boolean {
    return selectedFamily !== null;
}

export function closeDetailSidebar(sidebar: HTMLElement): void {
    selectedFamily = null;
    sidebar.hidden = true;
    document.body.removeAttribute('data-detail-open');
    sidebar.querySelector('.sidebar-body')?.replaceChildren();

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

export function resetDetailSidebars(): void {
    selectedFamily = null;
    document.body.removeAttribute('data-detail-open');

    for (const sidebar of document.querySelectorAll<HTMLElement>('.sidebar')) {
        sidebar.hidden = true;
        sidebar.querySelector('.sidebar-body')?.replaceChildren();
    }

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

function showDetailSidebar(sidebar: HTMLElement, group: TitleGroup): void {
    selectedFamily = group.family;
    sidebar.hidden = false;
    document.body.setAttribute('data-detail-open', '');

    const title = sidebar.querySelector('.sidebar-title');
    if (title) {
        title.textContent = group.name;
    }

    const thumbnail = sidebar.querySelector<HTMLElement>('.sidebar-thumbnail');
    if (thumbnail) {
        thumbnail.replaceChildren();

        const bannerUrl = getSidebarBannerUrl(group);
        if (bannerUrl) {
            thumbnail.append(buildSidebarImage(group, bannerUrl));
        }
    }

    const body = sidebar.querySelector('.sidebar-body');
    body?.replaceChildren(renderGroupDetailContent(group));
    requestTitleValidations(group);

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
    sidebar.className = 'sidebar';
    sidebar.hidden = true;
    sidebar.setAttribute('aria-label', 'Title details');

    const header = document.createElement('div');
    header.className = 'sidebar-header';

    const thumbnail = document.createElement('div');
    thumbnail.className = 'sidebar-thumbnail';

    const title = document.createElement('h2');
    title.className = 'sidebar-title';
    title.textContent = 'Title details';

    const closeButton = document.createElement('button');
    closeButton.className = 'sidebar-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close title details');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => closeDetailSidebar(sidebar));

    const body = document.createElement('div');
    body.className = 'sidebar-body';

    header.append(thumbnail, title, closeButton);
    sidebar.append(header, body);

    return sidebar;
}

export function refreshOpenDetailSidebarForGroup(group: TitleGroup): void {
    if (selectedFamily !== group.family) {
        return;
    }

    const body = document.querySelector<HTMLElement>('.sidebar-body');

    if (!body) {
        return;
    }

    const convertButton = body.querySelector<HTMLButtonElement>(
        '.sidebar-wud-convert'
    );
    if (convertButton) {
        convertButton.disabled = getBusyKinds(group).has(TitleKinds.Base);
    }

    const currentRows = new Map(
        Array.from(
            body.querySelectorAll<HTMLElement>('[data-sidebar-item]')
        ).map((row) => [row.dataset.sidebarItem ?? '', row])
    );
    const nextRows = new Map(
        renderDetailItemRows(group).map((row) => [
            row.dataset.sidebarItem ?? '',
            row,
        ])
    );

    if (
        currentRows.size !== nextRows.size ||
        [...currentRows.keys()].some((key) => !nextRows.has(key))
    ) {
        replaceDetailContent(body, group);
        return;
    }

    const changedLists = new Set<HTMLElement>();
    for (const [key, nextRow] of nextRows) {
        const currentRow = currentRows.get(key);
        if (!currentRow) {
            continue;
        }

        const list = currentRow.parentElement;
        if (!syncSidebarItemRow(currentRow, nextRow)) {
            continue;
        }

        if (list) {
            changedLists.add(list);
        }
    }

    for (const list of changedLists) {
        list.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function syncSidebarItemRow(
    currentRow: HTMLElement,
    nextRow: HTMLElement
): boolean {
    const currentChildren = [...currentRow.children];
    const nextChildren = [...nextRow.children];
    if (
        currentRow.tagName !== nextRow.tagName ||
        currentChildren.length !== nextChildren.length ||
        currentChildren.some(
            (child, index) => child.tagName !== nextChildren[index]?.tagName
        )
    ) {
        const currentCheckbox = currentRow.querySelector<HTMLInputElement>(
            'input[type="checkbox"]'
        );
        const nextCheckbox = nextRow.querySelector<HTMLInputElement>(
            'input[type="checkbox"]'
        );
        if (
            currentCheckbox?.checked &&
            nextCheckbox &&
            !nextCheckbox.disabled
        ) {
            nextCheckbox.checked = true;
        }
        currentRow.replaceWith(nextRow);
        return true;
    }

    let changed = false;
    const insufficientSpace = currentRow.classList.contains(
        'sidebar-storage-copy-row-insufficient-space'
    );
    const nextClassName = insufficientSpace
        ? `${nextRow.className} sidebar-storage-copy-row-insufficient-space`
        : nextRow.className;
    if (currentRow.className !== nextClassName) {
        currentRow.className = nextClassName;
        changed = true;
    }
    if (!insufficientSpace && currentRow.title !== nextRow.title) {
        currentRow.title = nextRow.title;
        changed = true;
    }

    for (let index = 0; index < currentChildren.length; index += 1) {
        const current = currentChildren[index];
        const next = nextChildren[index];
        if (
            current instanceof HTMLInputElement &&
            next instanceof HTMLInputElement
        ) {
            changed = syncSidebarCheckbox(current, next) || changed;
        } else {
            if (current.className !== next.className) {
                current.className = next.className;
                changed = true;
            }
            if (current.textContent !== next.textContent) {
                current.textContent = next.textContent;
                changed = true;
            }
            if (
                current instanceof HTMLElement &&
                next instanceof HTMLElement &&
                current.title !== next.title
            ) {
                current.title = next.title;
                changed = true;
            }
        }
    }

    return changed;
}

function syncSidebarCheckbox(
    current: HTMLInputElement,
    next: HTMLInputElement
): boolean {
    let changed = false;
    if (current.disabled !== next.disabled) {
        current.disabled = next.disabled;
        changed = true;
    }
    if (current.disabled && current.checked) {
        current.checked = false;
        changed = true;
    }
    return changed;
}

function replaceDetailContent(body: HTMLElement, group: TitleGroup): void {
    const checkedKeys = new Set(
        Array.from(
            body.querySelectorAll<HTMLInputElement>(
                'input[type="checkbox"]:checked'
            )
        )
            .map(getSidebarCheckboxKey)
            .filter((key): key is string => key !== null)
    );

    body.replaceChildren(renderGroupDetailContent(group));

    for (const checkbox of body.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]'
    )) {
        const key = getSidebarCheckboxKey(checkbox);
        if (!checkbox.disabled && key !== null && checkedKeys.has(key)) {
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}

function getSidebarCheckboxKey(checkbox: HTMLInputElement): string | null {
    const titleId = checkbox.dataset.titleId;
    const content = checkbox.closest<HTMLElement>('.sidebar-download-content');

    if (!titleId || !content) {
        return null;
    }

    return `${content.className}:${titleId}`;
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

function isTitleValidationUnavailable(
    event: TitleValidationSocketEvent | null
): boolean {
    return options?.isTitleValidationUnavailable(event) ?? false;
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

    if (group.platform === '3ds') {
        return true;
    }

    return localEntries.some((entry) => {
        const validation = titleValidations?.get(entry.titleId) ?? null;

        if (validation === null) {
            return false;
        }

        return !isTitleValidationUnavailable(validation);
    });
}

function getBusyKinds(group: TitleGroup): Set<TitleKinds> {
    return options?.getBusyKinds(group) ?? new Set<TitleKinds>();
}

function hasBusyEntryKind(
    busyKinds: Set<TitleKinds>,
    entries: Array<{ kind: TitleKinds }>
): boolean {
    return entries.some((entry) => busyKinds.has(entry.kind));
}

function renderDownloadAvailabilityRow(
    group: TitleGroup,
    entry: TitleGroup['availableEntries'][number]
): HTMLLabelElement | HTMLDivElement {
    const versions = formatVersions(entry.versions);
    const label = versions ? `${entry.kind} ${versions}` : entry.kind;
    const sizeText = getAvailableSizeText(entry);
    const downloadProgress =
        options?.getDownloadProgress(group.family, entry.kind, entry.titleId) ??
        null;

    if (downloadProgress !== null) {
        const row = document.createElement('div');
        row.className = 'sidebar-download-row sidebar-storage-copy-row';
        row.dataset.sidebarItem = `available:${entry.titleId}`;

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
        progress.textContent = downloadProgress;

        row.append(checkbox, slot, titleId, progress);
        return row;
    }

    const row = document.createElement('label');
    row.className = 'sidebar-download-row';
    row.dataset.sidebarItem = `available:${entry.titleId}`;

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
        group.platform === '3ds' ||
        !entry.availableOnCdn ||
        getBusyKinds(group).has(entry.kind);
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
    row.dataset.sidebarItem = `${downloadData ? 'invalid' : 'downloaded'}:${entry.titleId}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = downloadData
        ? 'sidebar-download-checkbox sidebar-storage-copy-checkbox'
        : 'sidebar-storage-copy-checkbox';
    checkbox.value = entry.titleId;
    checkbox.dataset.titleId = entry.titleId;
    checkbox.dataset.copySizeBytes = String(entry.sizeBytes);
    checkbox.disabled =
        group.platform === '3ds' || getBusyKinds(group).has(entry.kind);
    if (downloadData) {
        checkbox.dataset.family = downloadData.group.family;
        checkbox.dataset.groupName = downloadData.group.name;
        checkbox.dataset.kind = entry.kind;
        checkbox.dataset.label = downloadData.label;
        checkbox.dataset.sizeText = formatSize(entry.sizeBytes);
        checkbox.dataset.totalBytes = String(entry.sizeBytes);

        const downloadProgress =
            options?.getDownloadProgress(
                downloadData.group.family,
                entry.kind,
                entry.titleId
            ) ?? null;
        if (downloadProgress !== null) {
            checkbox.disabled = true;
            row.title = downloadProgress;
        }
    }

    const slot = document.createElement('span');
    slot.className = 'sidebar-download-slot';
    slot.textContent =
        downloadData?.label ?? formatTitleEntrySlot(group, entry);

    const titleId = document.createElement('span');
    titleId.className = 'sidebar-download-id';
    titleId.textContent = entry.titleId;

    const validation =
        group.platform === 'wii'
            ? null
            : (options?.titleValidations.get(entry.titleId) ?? null);
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
        label: formatTitleEntrySlot(group, entry),
    });
}

function getDetailEntries(group: TitleGroup): {
    localEntries: TitleEntry[];
    invalidEntries: TitleEntry[];
    availableEntries: TitleGroup['availableEntries'];
} {
    const detailOptions = options;
    const localEntries = group.entries
        .filter((entry) => {
            const validation =
                detailOptions?.titleValidations?.get(entry.titleId) ?? null;
            return !isTitleValidationUnavailable(validation);
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));
    const invalidEntries = group.entries
        .filter((entry) => {
            const validation =
                detailOptions?.titleValidations?.get(entry.titleId) ?? null;
            return isTitleValidationUnavailable(validation);
        })
        .sort((a, b) => getKindSortValue(a.kind) - getKindSortValue(b.kind));
    const availableEntries = group.availableEntries
        .filter((entry) => {
            const invalid = invalidEntries.some(
                (candidate) =>
                    candidate.kind === entry.kind &&
                    candidate.titleId === entry.titleId
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

    return { localEntries, invalidEntries, availableEntries };
}

function renderDetailItemRows(group: TitleGroup): HTMLElement[] {
    const { localEntries, invalidEntries, availableEntries } =
        getDetailEntries(group);

    return [
        ...localEntries.map((entry) => renderDownloadedCopyRow(group, entry)),
        ...invalidEntries.map((entry) => renderInvalidCopyRow(group, entry)),
        ...availableEntries.map((entry) =>
            renderDownloadAvailabilityRow(group, entry)
        ),
    ];
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

function queueSelectedDownloads(group: TitleGroup, list: HTMLElement): void {
    const hasSelection =
        list.querySelectorAll('.sidebar-download-checkbox:checked').length > 0;

    options?.queueSelectedDownloads(list, hasSelection);
    options?.onActionsChanged();

    const body = document.querySelector('.sidebar-body');
    body?.replaceChildren(renderGroupDetailContent(group));
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
    entries: TitleGroup['availableEntries']
): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'sidebar-download-actions sidebar-available-actions';

    const spacer = document.createElement('div');
    if (group.platform === '3ds') {
        actions.append(spacer);
        return actions;
    }

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
        queueSelectedDownloads(group, list);
        updateDownloadButton();
    });

    actions.append(spacer, downloadButton);
    return actions;
}

function renderInvalidActions(
    group: TitleGroup,
    list: HTMLElement,
    entries: TitleEntry[]
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
        queueSelectedDownloads(group, list);
        updateButtons();
    });

    deleteButton.addEventListener('click', () => {
        void (async () => {
            const hasSelection =
                list.querySelectorAll('.sidebar-storage-copy-checkbox:checked')
                    .length > 0;
            const titleIds = getSelectedDownloadedTitleIds(list, hasSelection);

            await options?.confirmAndQueueStorageDeletes(
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

function renderDeleteOnlyActions(
    list: HTMLElement,
    entries: TitleEntry[],
    label: string
): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'sidebar-download-actions sidebar-storage-copy-actions';

    const spacer = document.createElement('div');
    const deleteButton = document.createElement('button');
    deleteButton.className = 'sidebar-button';
    deleteButton.type = 'button';

    const updateButton = (): void => {
        const checkedCount = list.querySelectorAll(
            '.sidebar-storage-copy-checkbox:checked'
        ).length;
        deleteButton.textContent =
            checkedCount === 0 ? 'Delete all' : 'Delete selected';
        deleteButton.disabled = entries.length === 0;
    };

    updateButton();
    list.addEventListener('change', updateButton);

    deleteButton.addEventListener('click', () => {
        void (async () => {
            const hasSelection =
                list.querySelectorAll('.sidebar-storage-copy-checkbox:checked')
                    .length > 0;
            const titleIds = getSelectedDownloadedTitleIds(list, hasSelection);

            await options?.confirmAndQueueStorageDeletes(
                titleIds,
                entries,
                deleteButton,
                label
            );
            updateButton();
        })();
    });

    actions.append(spacer, deleteButton);
    return actions;
}

function formatTitleEntrySlot(group: TitleGroup, entry: TitleEntry): string {
    switch (group.platform) {
        case '3ds':
            return entry.kind;
        case 'wii':
        case 'wiiu':
            return entry.version === null
                ? entry.kind
                : `${entry.kind} v${entry.version}`;
    }
}

function formatVersions(versions: number[]): string {
    return versions.length > 0
        ? versions.map((version) => `v${version}`).join(', ')
        : '';
}

export function renderGroupDetailContent(group: TitleGroup): DocumentFragment {
    const detailOptions = options;
    const fragment = document.createDocumentFragment();
    const summary = document.createElement('div');

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

    const { localEntries, invalidEntries, availableEntries } =
        getDetailEntries(group);

    if (group.wudEntries.length > 0) {
        const wud = detailOptions?.renderWud(
            group,
            getBusyKinds(group).has(TitleKinds.Base)
        );
        if (wud) {
            availability.append(
                renderDetailSection('WUD', wud.action),
                wud.content
            );
        }
    }

    if (localEntries.length > 0) {
        const localList = document.createElement('div');
        localList.className = 'sidebar-download-list';

        for (const entry of localEntries) {
            localList.append(renderDownloadedCopyRow(group, entry));
        }

        if (group.platform === 'wii') {
            const downloadedContent = document.createElement('div');
            downloadedContent.className =
                'sidebar-download-content sidebar-storage-copy-content';
            downloadedContent.append(
                localList,
                renderDeleteOnlyActions(localList, localEntries, 'disc image')
            );

            availability.append(
                renderDetailSection('Disc Images'),
                downloadedContent
            );
        } else {
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
                    !destinationSelect.disabled &&
                    destinationSelect.value !== '';
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
            destinationSelect.addEventListener(
                'change',
                updateDownloadedButtons
            );
            if (detailOptions) {
                void detailOptions
                    .populateFat32DeviceSelect(destinationSelect, copyButton)
                    .then((response) => {
                        fat32Response = response;
                        updateDownloadedButtons();
                    });
            }

            const queueStorageCopy = detailOptions?.queueStorageCopy;
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

                    if (
                        titleIds.length === 0 ||
                        !destination ||
                        !queueStorageCopy
                    ) {
                        return;
                    }

                    copyButton.disabled = true;
                    try {
                        await Promise.all(
                            titleIds.map((titleId) =>
                                queueStorageCopy(titleId, destination)
                            )
                        );
                    } finally {
                        copyButton.disabled =
                            localEntries.length === 0 ||
                            destinationSelect.disabled;
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

                    await detailOptions?.confirmAndQueueStorageDeletes(
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
            renderInvalidActions(group, invalidList, invalidEntries)
        );

        availability.append(renderDetailSection('Invalid'), invalidContent);
    }

    if (availableEntries.length > 0) {
        const availableList = document.createElement('div');
        availableList.className = 'sidebar-download-list';

        for (const entry of availableEntries) {
            availableList.append(renderDownloadAvailabilityRow(group, entry));
        }

        const availableContent = document.createElement('div');
        availableContent.className =
            'sidebar-download-content sidebar-available-content';
        availableContent.append(
            availableList,
            renderAvailableActions(group, availableList, availableEntries)
        );

        availability.append(renderDetailSection('Available'), availableContent);
    }

    bottom.append(availability);
    fragment.append(bottom);

    return fragment;
}

function requestTitleValidation(titleId: string, name: string): void {
    options?.requestTitleValidation(titleId, name);
}

export function requestTitleValidations(group: TitleGroup): void {
    if (group.platform === 'wii') {
        return;
    }

    for (const entry of group.entries) {
        requestTitleValidation(entry.titleId, entry.name);
    }
}
