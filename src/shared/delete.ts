import { DELETE_SOCKET_COMMAND } from './socket.js';
import { type TitleKinds } from './titles.js';

export type DeleteState = 'queued' | 'deleting' | 'failed' | 'complete';

export type DeleteItem = {
    id: string;
    titleId: string;
    titleName: string | null;
    titleVersion: number | null;
    titleKind: TitleKinds | null;
    state: DeleteState;
    message: string | null;
    deletedCount: number;
    totalCount: number | null;
    error: string | null;
};

export type DeleteActionBarCommand =
    (typeof DELETE_SOCKET_COMMAND)[keyof typeof DELETE_SOCKET_COMMAND];

export type DeleteQueueItem = DeleteItem & {
    sourcePaths: string[];
};
