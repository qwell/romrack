import { isTerminalActionState, type ActionState } from '../shared/action.js';

export type ActionBarCommand = string;

type ActionBarItem = {
    key: string;
    id: string;
    state: ActionState;
    cells: Array<{
        className: string;
        text: string;
        title?: string;
    }>;
    details: {
        text?: string;
        title?: string;
        buttons: Array<{
            text: string;
            command: string;
            disabled?: boolean;
        }>;
    };
    clearCommand?: string;
};

type ActionBarOptions = {
    getItems: () => ActionBarItem[];
    onCommand: (action: ActionBarCommand, itemId: string) => void;
};

let actionBarRoot: HTMLElement | null = null;
let actionBarSignature = '';
let actionBarOptions: ActionBarOptions | null = null;
let actionBarOrderCounter = 0;
const actionBarItemOrder = new Map<string, number>();

function createActionButton(
    text: string,
    action: ActionBarCommand,
    itemId: string,
    disabled = false
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-bar-button';
    button.textContent = text;
    button.dataset.action = action;
    button.dataset.itemId = itemId;
    button.disabled = disabled;
    return button;
}

function renderActionBarDetails(entry: ActionBarItem): HTMLDivElement {
    const cell = document.createElement('div');
    cell.className = 'action-bar-details-cell';
    cell.classList.add('action-bar-controls');
    cell.title = entry.details.title ?? '';

    if (entry.details.text !== undefined) {
        const text = document.createElement('span');
        text.className = 'action-bar-control-text';
        text.title = entry.details.text;
        text.textContent = entry.details.text;
        cell.append(text);
    }

    cell.append(
        ...entry.details.buttons.map((button) =>
            createActionButton(
                button.text,
                button.command,
                entry.id,
                button.disabled
            )
        )
    );
    return cell;
}

function getOrderedEntries(entries: ActionBarItem[]): ActionBarItem[] {
    const activeKeys = new Set(entries.map((entry) => entry.key));
    for (const key of actionBarItemOrder.keys()) {
        if (!activeKeys.has(key)) {
            actionBarItemOrder.delete(key);
        }
    }

    for (const entry of entries) {
        if (!actionBarItemOrder.has(entry.key)) {
            actionBarItemOrder.set(entry.key, actionBarOrderCounter);
            actionBarOrderCounter += 1;
        }
    }

    return entries.sort(
        (left, right) =>
            (actionBarItemOrder.get(left.key) ?? 0) -
            (actionBarItemOrder.get(right.key) ?? 0)
    );
}

function renderEntry(entry: ActionBarItem): HTMLDivElement {
    const row = document.createElement('div');
    row.className = `action-bar-row action-bar-row-${entry.state}`;
    row.dataset.itemState = entry.state;
    row.dataset.actionBarKey = entry.key;

    for (const cell of entry.cells) {
        const element = document.createElement('div');
        element.className = cell.className;
        element.textContent = cell.text;
        element.title = cell.title ?? '';
        row.append(element);
    }

    row.append(renderActionBarDetails(entry));
    return row;
}

function renderSummary(entries: ActionBarItem[]): HTMLElement {
    const summary = document.createElement('div');
    summary.className = 'action-bar-summary';

    const count = (state: ActionState): number =>
        entries.filter((entry) => entry.state === state).length;
    const counts = document.createElement('div');
    counts.textContent = `Actions: ${count('in-progress')} active, ${count('queued')} queued, ${count('failed')} failed, ${count('complete') + count('cancelled')} finished`;

    const controls = document.createElement('div');
    controls.className = 'action-bar-summary-controls';

    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'action-bar-button';
    clearAll.textContent = 'Clear All';
    clearAll.dataset.actionBarClearAll = 'true';
    clearAll.disabled = !entries.some(
        (entry) => entry.clearCommand && isTerminalActionState(entry.state)
    );

    controls.append(clearAll);
    summary.append(counts, controls);
    return summary;
}

function rebuildActionBar(entries: ActionBarItem[]): void {
    if (!actionBarRoot) {
        return;
    }

    const details = document.createElement('div');
    details.className = 'action-bar-details';
    details.append(...entries.map(renderEntry));
    actionBarRoot.replaceChildren(renderSummary(entries), details);
}

export function updateActionBar(): void {
    if (!actionBarRoot || !actionBarOptions) {
        return;
    }

    const entries = getOrderedEntries(actionBarOptions.getItems());
    actionBarRoot.hidden = entries.length === 0;

    const signature = JSON.stringify(
        entries.map((entry) => [
            entry.key,
            entry.state,
            entry.cells,
            entry.details,
        ])
    );
    if (signature === actionBarSignature) {
        return;
    }

    actionBarSignature = signature;
    rebuildActionBar(entries);
}

function buildActionBar(): HTMLElement {
    const strip = document.createElement('section');
    strip.className = 'action-bar';
    strip.hidden = true;
    strip.setAttribute('aria-label', 'Action bar');
    return strip;
}

export function mountActionBar(options: ActionBarOptions): void {
    actionBarOptions = options;

    if (actionBarRoot) {
        updateActionBar();
        return;
    }

    actionBarRoot = buildActionBar();
    actionBarRoot.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !actionBarOptions) {
            return;
        }

        const clearAll = target.closest('button[data-action-bar-clear-all]');
        if (clearAll instanceof HTMLButtonElement && !clearAll.disabled) {
            for (const entry of actionBarOptions.getItems()) {
                if (entry.clearCommand && isTerminalActionState(entry.state)) {
                    actionBarOptions.onCommand(entry.clearCommand, entry.id);
                }
            }
            return;
        }

        const button = target.closest<HTMLButtonElement>(
            'button[data-action][data-item-id]'
        );
        if (!button || !actionBarRoot?.contains(button)) {
            return;
        }

        const action = button.dataset.action;
        const itemId = button.dataset.itemId;
        if (action && itemId) {
            actionBarOptions.onCommand(action, itemId);
        }
    });

    document.body.append(actionBarRoot);
    updateActionBar();
}
