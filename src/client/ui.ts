import { type StorageFat32ListResponse } from '../shared/api.js';
import { type DownloadQueueItem } from '../shared/download.js';
import {
    type LibraryConvertItem,
    type LibraryVerifyEvent,
    type TitleValidationSocketEvent,
} from '../shared/socket.js';
import {
    type StorageCopyItem,
    type StorageDeleteItem,
} from '../shared/storage.js';
import {
    identifyTitle,
    type TitleGroup,
    TitleKinds,
} from '../shared/titles.js';
import { mountActionBar, updateActionBar } from './actionbar.js';
import {
    collectSelectedDownloads,
    formatDownloadProgress,
    getDownloadActionBarEntries,
    getDownloadItem,
    handleDownloadActionBarCommand,
    queueDownloads,
    renderDownloadMarkers,
} from './download.js';
import {
    getLibraryConvertActionBarEntries,
    getLibraryRenameActionBarEntries,
    getLibraryVerifyActionBarEntries,
    handleLibraryActionBarCommand,
    renderLibrarySidebarWud,
    isTitleValidationUnavailable,
    type LibraryRenameAction,
} from './library.js';
import {
    closeSettingsSidebar,
    isSettingsOpen,
    openSettingsSidebar,
    setupSettingsSidebar,
} from './settings.js';
import {
    buildDetailSidebar,
    closeDetailSidebar,
    getSelectedDetailFamily,
    hasOpenDetailFamily,
    refreshOpenDetailSidebarForGroup,
    resetDetailSidebars,
    setupSidebar,
    toggleDetailSidebar,
} from './sidebar.js';
import {
    confirmAndQueueStorageDeletes,
    getStorageCopyActionBarEntries,
    getStorageDeleteActionBarEntries,
    handleStorageCopyActionBarCommand,
    handleStorageDeleteActionBarCommand,
} from './storage.js';
import {
    getCurrentTitleGroups,
    mountTitles,
    setupTitles,
    refreshRenderedTitleGroup,
} from './titles.js';

type UiOptions = {
    downloads: DownloadQueueItem[];
    storageCopies: StorageCopyItem[];
    storageDeletes: StorageDeleteItem[];
    libraryVerifications: LibraryVerifyEvent[];
    libraryConversions: LibraryConvertItem[];
    libraryRenames: LibraryRenameAction[];
    titleValidations: Map<string, TitleValidationSocketEvent>;
    onRefreshLibrary: () => void | Promise<void>;
    onVerifyLibrary: () => void | Promise<void>;
    onRenameLibrary: () => void | Promise<void>;
    onCancelLibraryRename: () => void;
    onRetryLibraryRename: () => void;
    queueStorageCopy: (
        titleId: string,
        destination: string,
        platform: TitleGroup['platform']
    ) => Promise<unknown>;
    queueLibraryConvert: (titleId: string) => Promise<unknown>;
    requestTitleValidation: (
        titleId: string,
        name: string,
        platform: TitleGroup['platform']
    ) => void;
    populateFat32DeviceSelect: (
        select: HTMLSelectElement,
        button: HTMLButtonElement
    ) => Promise<StorageFat32ListResponse | null>;
};

function getBusyKinds(options: UiOptions, group: TitleGroup): Set<TitleKinds> {
    const busyKinds = new Set<TitleKinds>();
    const running = (state: string): boolean =>
        state === 'queued' || state === 'in-progress';

    for (const item of options.downloads) {
        if (item.family === group.family && running(item.state)) {
            busyKinds.add(item.kind);
        }
    }
    for (const item of options.libraryConversions) {
        if (
            group.platform === 'wiiu' &&
            identifyTitle(item.titleId, 'wiiu')?.family === group.family &&
            running(item.state)
        ) {
            busyKinds.add(item.kind);
        }
    }
    for (const item of [...options.storageDeletes, ...options.storageCopies]) {
        if (
            !item.titleId ||
            item.platform !== group.platform ||
            identifyTitle(item.titleId, item.platform)?.family !==
                group.family ||
            !running(item.state)
        ) {
            continue;
        }
        const kind =
            item.titleKind ??
            group.entries.find((entry) => entry.titleId === item.titleId)?.kind;
        if (kind) {
            busyKinds.add(kind);
        }
    }
    return busyKinds;
}

function setupActionBar(options: UiOptions): void {
    mountActionBar({
        getItems: () => [
            ...getDownloadActionBarEntries(options.downloads),
            ...getStorageCopyActionBarEntries(options.storageCopies),
            ...getStorageDeleteActionBarEntries(options.storageDeletes),
            ...getLibraryVerifyActionBarEntries(
                options.libraryVerifications,
                options.downloads
            ),
            ...getLibraryConvertActionBarEntries(options.libraryConversions),
            ...getLibraryRenameActionBarEntries(options.libraryRenames),
        ],
        onCommand(action, itemId) {
            if (
                handleDownloadActionBarCommand(
                    action,
                    itemId,
                    options.downloads
                )
            ) {
                return;
            }
            if (handleStorageCopyActionBarCommand(action, itemId)) {
                return;
            }
            if (handleStorageDeleteActionBarCommand(action, itemId)) {
                return;
            }
            handleLibraryActionBarCommand(
                action,
                itemId,
                options.libraryVerifications,
                options.libraryRenames,
                options.onCancelLibraryRename,
                options.onRetryLibraryRename,
                (items) => queueDownloads(options.downloads, items).length > 0
            );
            updateActionBar();
        },
    });
}

function setupSidebars(options: UiOptions): void {
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
                void options.onRefreshLibrary();
            },
        }
    );
    setupSidebar({
        titleValidations: options.titleValidations,
        onActionsChanged: updateActionBar,
        getDownloadProgress(family, kind, titleId) {
            const item = getDownloadItem(
                options.downloads,
                family,
                kind,
                titleId
            );
            return item ? formatDownloadProgress(item) : null;
        },
        queueSelectedDownloads(root, selectedOnly) {
            queueDownloads(
                options.downloads,
                collectSelectedDownloads(root, selectedOnly)
            );
        },
        getBusyKinds: (group) => getBusyKinds(options, group),
        confirmAndQueueStorageDeletes,
        queueStorageCopy: options.queueStorageCopy,
        requestTitleValidation: options.requestTitleValidation,
        isTitleValidationUnavailable,
        renderWud: (group, conversionBusy) =>
            renderLibrarySidebarWud(
                group,
                conversionBusy,
                options.queueLibraryConvert
            ),
        populateFat32DeviceSelect: options.populateFat32DeviceSelect,
    });
}

function setupTitlesUi(options: UiOptions): void {
    setupTitles({
        downloads: options.downloads,
        onRefresh: options.onRefreshLibrary,
        onVerify: options.onVerifyLibrary,
        onRename: options.onRenameLibrary,
        onOpenSettings: openSettingsSidebar,
        renderDownloadMarkers: () => renderDownloadMarkers(options.downloads),
        buildDetailSidebar,
        getSelectedDetailFamily,
        toggleDetailSidebar,
    });

    const root = document.querySelector<HTMLElement>('#output');
    if (!root) {
        throw new Error('Missing #output');
    }
    mountTitles(root);
}

function setTheme(darkMode: boolean, save = false): void {
    const lightIcon = document.getElementById('theme-icon-light');
    const darkIcon = document.getElementById('theme-icon-dark');

    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';

    if (save) {
        localStorage.theme = document.documentElement.dataset.theme;
    }

    if (lightIcon) {
        lightIcon.hidden = !darkMode;
    }
    if (darkIcon) {
        darkIcon.hidden = darkMode;
    }
}

function setupTheme(): void {
    const prefers = window.matchMedia('(prefers-color-scheme: dark)');
    const savedTheme = localStorage.getItem('theme');

    setTheme(savedTheme ? savedTheme === 'dark' : prefers.matches);

    prefers.addEventListener('change', (event) => {
        if (!localStorage.getItem('theme')) {
            setTheme(event.matches);
        }
    });

    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        setTheme(document.documentElement.dataset.theme !== 'dark', true);
    });
}

export function setupUi(options: UiOptions): void {
    setupTheme();
    setupActionBar(options);
    setupSidebars(options);
    setupTitlesUi(options);
    resetDetailSidebars();
    window.addEventListener('pageshow', resetDetailSidebars);
}

export function refreshTitleGroupUi(group: TitleGroup): void {
    refreshRenderedTitleGroup(group);
    refreshOpenDetailSidebarForGroup(group);
}

export function refreshDetailSidebarForGroup(group: TitleGroup): void {
    refreshOpenDetailSidebarForGroup(group);
}

export function refreshSelectedDetailSidebar(): void {
    const selectedFamily = getSelectedDetailFamily();
    if (!selectedFamily) {
        return;
    }

    const group = getCurrentTitleGroups().find(
        (candidate) => candidate.family === selectedFamily
    );
    if (group) {
        refreshOpenDetailSidebarForGroup(group);
    }
}

export function refreshActionBar(): void {
    updateActionBar();
}

export function refreshActionsAndSelectedSidebar(): void {
    updateActionBar();
    refreshSelectedDetailSidebar();
}

export function resetUiDetailSidebars(): void {
    resetDetailSidebars();
}
