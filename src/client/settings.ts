import { type AppConfig } from '../shared/config.js';
import { getConfig, saveConfig, validateConfigRoot } from './api.js';

type SettingsStatusTone = 'info' | 'success' | 'error';

type SettingsOptions = {
    onRootsChanged: () => void;
};

let settingsRoot: HTMLElement | null = null;
let settingsOptions: SettingsOptions | null = null;
let settingsConfig: AppConfig | null = null;
let settingsStatusMessage = '';
let settingsStatusTone: SettingsStatusTone = 'info';
let settingsLoading = false;
let settingsSaving = false;
let settingsCheckingRoot = false;

export function isSettingsOpen(): boolean {
    return document.body.hasAttribute('data-settings-open');
}

function updateSettingsStatus(
    message: string,
    tone: SettingsStatusTone = 'info'
): void {
    settingsStatusMessage = message;
    settingsStatusTone = tone;
    renderSettingsSidebar();
}

function buildSettingsRootRow(value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'settings-root-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-input settings-root-input';
    input.value = value;

    const checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'settings-button settings-root-check';
    checkButton.textContent = 'Check';
    checkButton.disabled = settingsCheckingRoot;
    checkButton.addEventListener('click', () => {
        void (async () => {
            if (settingsCheckingRoot) {
                return;
            }

            const root = input.value.trim();
            settingsCheckingRoot = true;
            updateSettingsStatus(`Checking ${root || 'path'}...`);
            renderSettingsSidebar();

            try {
                const result = await validateConfigRoot(root);
                updateSettingsStatus(
                    result.message,
                    result.readable ? 'success' : 'error'
                );
            } catch (error) {
                console.error(error);
                updateSettingsStatus('Failed to validate path.', 'error');
            } finally {
                settingsCheckingRoot = false;
                renderSettingsSidebar();
            }
        })();
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'settings-icon-button';
    removeButton.setAttribute('aria-label', 'Remove Wii U root');
    removeButton.innerHTML = '<i class="fa-solid fa-minus"></i>';
    removeButton.addEventListener('click', () => row.remove());

    row.append(input, checkButton, removeButton);
    return row;
}

function readSettingsForm(sidebar: HTMLElement): AppConfig {
    const hostInput = sidebar.querySelector<HTMLInputElement>(
        '.settings-input-host'
    );
    const portInput = sidebar.querySelector<HTMLInputElement>(
        '.settings-input-port'
    );
    const openBrowserInput = sidebar.querySelector<HTMLInputElement>(
        '.settings-input-open-browser'
    );
    const rootInputs = sidebar.querySelectorAll<HTMLInputElement>(
        '.settings-root-input'
    );

    return {
        host: hostInput?.value.trim() ?? '',
        port: Number(portInput?.value ?? 0),
        openBrowser: openBrowserInput?.checked ?? false,
        wiiuRoots: [...rootInputs]
            .map((input) => input.value.trim())
            .filter((value) => value.length > 0),
    };
}

async function loadSettingsConfig(): Promise<void> {
    settingsLoading = true;
    updateSettingsStatus('Loading settings...');

    try {
        const result = await getConfig();
        settingsConfig = result.config;
        settingsStatusMessage = '';
        settingsStatusTone = 'info';
    } catch (error) {
        console.error(error);
        settingsStatusMessage = 'Failed to load settings.';
        settingsStatusTone = 'error';
    } finally {
        settingsLoading = false;
        renderSettingsSidebar(false);
    }
}

async function saveSettingsConfig(sidebar: HTMLElement): Promise<void> {
    if (settingsSaving) {
        return;
    }

    const nextConfig = readSettingsForm(sidebar);
    const previousRoots = JSON.stringify(settingsConfig?.wiiuRoots ?? []);
    const nextRoots = JSON.stringify(nextConfig.wiiuRoots);

    settingsSaving = true;
    updateSettingsStatus('Saving settings...');

    try {
        const result = await saveConfig(nextConfig);
        settingsConfig = result.config;
        settingsStatusMessage = result.restartRequired
            ? 'Settings saved. Restart required for host/port changes.'
            : 'Settings saved.';
        settingsStatusTone = 'success';

        if (previousRoots !== nextRoots) {
            settingsOptions?.onRootsChanged();
        }
    } catch (error) {
        console.error(error);
        settingsStatusMessage = 'Failed to save settings.';
        settingsStatusTone = 'error';
    } finally {
        settingsSaving = false;
        renderSettingsSidebar(false);
    }
}

export function closeSettingsSidebar(): void {
    document.body.removeAttribute('data-settings-open');
    renderSettingsSidebar();
}

export function openSettingsSidebar(): void {
    document.body.setAttribute('data-settings-open', '');
    renderSettingsSidebar();

    if (!settingsLoading) {
        void loadSettingsConfig();
    }
}

function buildSettingsServerSection(config: AppConfig): HTMLElement {
    const serverSection = document.createElement('section');
    serverSection.className = 'settings-section';

    const serverTitle = document.createElement('h3');
    serverTitle.className = 'settings-section-title';
    serverTitle.textContent = 'Server';

    const hostField = document.createElement('label');
    hostField.className = 'settings-field';
    const hostLabel = document.createElement('span');
    hostLabel.className = 'settings-label';
    hostLabel.textContent = 'Host';
    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.className = 'settings-input settings-input-host';
    hostInput.value = config.host;
    hostField.append(hostLabel, hostInput);

    const portField = document.createElement('label');
    portField.className = 'settings-field';
    const portLabel = document.createElement('span');
    portLabel.className = 'settings-label';
    portLabel.textContent = 'Port';
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.className = 'settings-input settings-input-port';
    portInput.value = String(config.port);
    portInput.min = '1';
    portInput.step = '1';
    portField.append(portLabel, portInput);

    const openBrowserLabel = document.createElement('label');
    openBrowserLabel.className = 'settings-checkbox';
    const openBrowserInput = document.createElement('input');
    openBrowserInput.type = 'checkbox';
    openBrowserInput.className = 'settings-input-open-browser';
    openBrowserInput.checked = config.openBrowser;
    const openBrowserText = document.createElement('span');
    openBrowserText.textContent = 'Open browser on server start';
    openBrowserLabel.append(openBrowserInput, openBrowserText);

    const serverHelp = document.createElement('div');
    serverHelp.className = 'settings-help';
    serverHelp.textContent =
        'Host and port changes are saved immediately but require a restart.';

    serverSection.append(
        serverTitle,
        hostField,
        portField,
        openBrowserLabel,
        serverHelp
    );

    return serverSection;
}

function buildSettingsRootsSection(config: AppConfig): HTMLElement {
    const rootsSection = document.createElement('section');
    rootsSection.className = 'settings-section';

    const rootsTitle = document.createElement('h3');
    rootsTitle.className = 'settings-section-title';
    rootsTitle.textContent = 'Wii U Roots';

    const rootsHelp = document.createElement('div');
    rootsHelp.className = 'settings-help';
    rootsHelp.textContent =
        'Add one or more ROM roots. Check verifies that a path exists and is readable.';

    const rootsList = document.createElement('div');
    rootsList.className = 'settings-roots';

    for (const root of config.wiiuRoots) {
        rootsList.append(buildSettingsRootRow(root));
    }

    if (config.wiiuRoots.length === 0) {
        rootsList.append(buildSettingsRootRow(''));
    }

    const addRootButton = document.createElement('button');
    addRootButton.type = 'button';
    addRootButton.className = 'settings-button';
    addRootButton.textContent = 'Add root';
    addRootButton.disabled = settingsCheckingRoot;
    addRootButton.addEventListener('click', () => {
        rootsList.append(buildSettingsRootRow(''));
    });

    rootsSection.append(rootsTitle, rootsHelp, rootsList, addRootButton);
    return rootsSection;
}

function buildSettingsFooter(sidebar: HTMLElement): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'settings-footer';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'settings-button';
    cancelButton.textContent = 'Close';
    cancelButton.addEventListener('click', closeSettingsSidebar);

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'settings-button';
    saveButton.textContent = settingsSaving ? 'Saving...' : 'Save';
    saveButton.disabled = settingsSaving || settingsCheckingRoot;
    saveButton.addEventListener('click', () => {
        void saveSettingsConfig(sidebar);
    });

    footer.append(cancelButton, saveButton);
    return footer;
}

export function renderSettingsSidebar(preserveDraft = true): void {
    if (!settingsRoot) {
        return;
    }

    const currentSidebar =
        settingsRoot.querySelector<HTMLElement>('.settings-sidebar');
    const hasSettingsInputs =
        currentSidebar?.querySelector('.settings-input-host') !== null;
    if (
        preserveDraft &&
        currentSidebar &&
        settingsConfig &&
        hasSettingsInputs
    ) {
        settingsConfig = readSettingsForm(currentSidebar);
    }

    settingsRoot.className = 'settings-root';
    settingsRoot.hidden = false;
    settingsRoot.dataset.open = String(isSettingsOpen());
    settingsRoot.replaceChildren();

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', closeSettingsSidebar);

    const sidebar = document.createElement('aside');
    sidebar.className = 'settings-sidebar';

    const header = document.createElement('div');
    header.className = 'settings-header';

    const title = document.createElement('h2');
    title.className = 'settings-title';
    title.textContent = 'Settings';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'settings-close';
    closeButton.setAttribute('aria-label', 'Close settings');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', closeSettingsSidebar);

    header.append(title, closeButton);

    const status = document.createElement('div');
    status.className = `settings-status settings-status-${settingsStatusTone}`;
    status.textContent = settingsStatusMessage;

    const form = document.createElement('div');
    form.className = 'settings-form';

    if (settingsConfig) {
        form.append(
            buildSettingsServerSection(settingsConfig),
            buildSettingsRootsSection(settingsConfig),
            buildSettingsFooter(sidebar)
        );
    }

    sidebar.append(header, status, form);
    settingsRoot.append(backdrop, sidebar);
}

export function setupSettingsSidebar(
    root: HTMLElement | null,
    options: SettingsOptions
): void {
    settingsRoot = root;
    settingsOptions = options;
    renderSettingsSidebar();
}
