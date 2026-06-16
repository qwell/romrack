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

function updateActionBarDetails(
    cell: HTMLDivElement,
    entry: ActionBarItem
): void {
    cell.title = entry.details.title ?? '';

    let text = cell.querySelector<HTMLSpanElement>('.action-bar-control-text');
    if (entry.details.text === undefined) {
        text?.remove();
    } else {
        if (!text) {
            text = document.createElement('span');
            text.className = 'action-bar-control-text';
            cell.prepend(text);
        }
        text.title = entry.details.text;
        text.textContent = entry.details.text;
    }

    const existingButtons = new Map(
        [
            ...cell.querySelectorAll<HTMLButtonElement>('button[data-action]'),
        ].map((button) => [button.dataset.action ?? '', button])
    );
    const activeButtons = new Set<HTMLButtonElement>();
    let previousButton: HTMLButtonElement | null = null;
    for (const detailsButton of entry.details.buttons) {
        const button =
            existingButtons.get(detailsButton.command) ??
            createActionButton(
                detailsButton.text,
                detailsButton.command,
                entry.id,
                detailsButton.disabled
            );
        button.textContent = detailsButton.text;
        button.dataset.itemId = entry.id;
        button.disabled = detailsButton.disabled ?? false;
        activeButtons.add(button);
        const expectedButton: ChildNode | null = previousButton
            ? previousButton.nextSibling
            : text
              ? text.nextSibling
              : cell.firstChild;
        if (button !== expectedButton) {
            cell.insertBefore(button, expectedButton);
        }
        previousButton = button;
    }
    for (const button of existingButtons.values()) {
        if (!activeButtons.has(button)) {
            button.remove();
        }
    }
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

function updateEntry(row: HTMLDivElement, entry: ActionBarItem): void {
    row.className = `action-bar-row action-bar-row-${entry.state}`;
    row.dataset.itemState = entry.state;
    row.dataset.actionBarKey = entry.key;

    const existingCells = [
        ...row.querySelectorAll<HTMLDivElement>(
            ':scope > div:not(.action-bar-details-cell)'
        ),
    ];
    for (const [index, cell] of entry.cells.entries()) {
        const element = existingCells[index] ?? document.createElement('div');
        element.className = cell.className;
        element.textContent = cell.text;
        element.title = cell.title ?? '';
        if (!element.parentElement) {
            row.append(element);
        }
    }
    for (const element of existingCells.slice(entry.cells.length)) {
        element.remove();
    }

    let details = row.querySelector<HTMLDivElement>(
        ':scope > .action-bar-details-cell'
    );
    if (!details) {
        details = renderActionBarDetails(entry);
        row.append(details);
        return;
    }
    updateActionBarDetails(details, entry);
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

function updateActionBarSummary(
    summary: HTMLElement,
    entries: ActionBarItem[]
): void {
    const count = (state: ActionState): number =>
        entries.filter((entry) => entry.state === state).length;
    const counts = summary.querySelector<HTMLElement>(
        ':scope > div:not(.action-bar-summary-controls)'
    );
    if (counts) {
        counts.textContent = `Actions: ${count('in-progress')} active, ${count('queued')} queued, ${count('failed')} failed, ${count('complete') + count('cancelled')} finished`;
    }

    const clearAll = summary.querySelector<HTMLButtonElement>(
        'button[data-action-bar-clear-all]'
    );
    if (clearAll) {
        clearAll.disabled = !entries.some(
            (entry) => entry.clearCommand && isTerminalActionState(entry.state)
        );
    }
}

function syncActionBar(entries: ActionBarItem[]): void {
    if (!actionBarRoot) {
        return;
    }

    let summary = actionBarRoot.querySelector<HTMLElement>(
        ':scope > .action-bar-summary'
    );
    if (!summary) {
        summary = renderSummary(entries);
        actionBarRoot.append(summary);
    } else {
        updateActionBarSummary(summary, entries);
    }

    let details = actionBarRoot.querySelector<HTMLDivElement>(
        ':scope > .action-bar-details'
    );
    if (!details) {
        details = document.createElement('div');
        details.className = 'action-bar-details';
        actionBarRoot.append(details);
    }

    const existingRows = new Map(
        [
            ...details.querySelectorAll<HTMLDivElement>(
                ':scope > .action-bar-row'
            ),
        ].map((row) => [row.dataset.actionBarKey ?? '', row])
    );
    const activeRows = new Set<HTMLDivElement>();
    let previousRow: HTMLDivElement | null = null;
    for (const entry of entries) {
        const row = existingRows.get(entry.key) ?? renderEntry(entry);
        updateEntry(row, entry);
        activeRows.add(row);
        const expectedRow: ChildNode | null = previousRow
            ? previousRow.nextSibling
            : details.firstChild;
        if (row !== expectedRow) {
            details.insertBefore(row, expectedRow);
        }
        previousRow = row;
    }
    for (const row of existingRows.values()) {
        if (!activeRows.has(row)) {
            row.remove();
        }
    }
}

export function updateActionBar(): void {
    if (!actionBarRoot || !actionBarOptions) {
        return;
    }

    const entries = getOrderedEntries(actionBarOptions.getItems());
    actionBarRoot.hidden = entries.length === 0;

    syncActionBar(entries);
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
