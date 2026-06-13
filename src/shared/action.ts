export type ActionState =
    | 'queued'
    | 'in-progress'
    | 'complete'
    | 'failed'
    | 'cancelled';

const ACTION_STATE_LABELS: Record<ActionState, string> = {
    queued: 'Queued',
    'in-progress': 'In progress',
    complete: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
};

export function isTerminalActionState(state: ActionState): boolean {
    return state === 'complete' || state === 'failed' || state === 'cancelled';
}

export function formatActionState(
    state: ActionState,
    labels: Partial<Record<ActionState, string>> = {}
): string {
    return labels[state] ?? ACTION_STATE_LABELS[state];
}

export function formatActionStateIcon(
    state: ActionState | null,
    inProgressIcon = '⋯'
): string {
    switch (state) {
        case 'queued':
            return '○';
        case 'in-progress':
            return inProgressIcon;
        case 'complete':
            return '✓';
        case 'failed':
            return '!';
        case 'cancelled':
            return '×';
        default:
            return '';
    }
}

export function formatActionProgress(
    state: ActionState,
    progress: number | null
): string {
    if (state === 'complete') {
        return 'Done';
    }

    if (state === 'queued' || state === 'cancelled') {
        return '-';
    }

    return progress !== null ? `${Math.round(progress)}%` : '-';
}

export function formatActionFileCount(
    completed: number | null,
    total: number | null,
    currentFileActive: boolean
): string {
    if (completed === null || total === null) {
        return '';
    }

    const current = currentFileActive
        ? Math.min(completed + 1, total)
        : completed;
    return `${current} / ${total} files`;
}
