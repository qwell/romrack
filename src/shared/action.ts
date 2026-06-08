export type ActionState =
    | 'queued'
    | 'in-progress'
    | 'complete'
    | 'failed'
    | 'cancelled';

export function isTerminalActionState(state: ActionState): boolean {
    return state === 'complete' || state === 'failed' || state === 'cancelled';
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
