import { type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
    isSocketCommand,
    type SocketCommand,
    type SocketEvent,
    DOWNLOAD_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_COMMAND,
    LIBRARY_VERIFY_SOCKET_COMMAND,
    STORAGE_COPY_SOCKET_COMMAND,
    STORAGE_DELETE_SOCKET_COMMAND,
    TITLE_VALIDATE_SOCKET_COMMAND,
} from '../shared/socket.js';
import { type DownloadQueueItemDetails } from '../shared/download.js';
import {
    getTitleFamily,
    normalizeTitleId,
    TitleKinds,
} from '../shared/titles.js';
import logger from '../shared/logger.js';

type AppSocketOptions = {
    server: Server;
    path: string;
    getConnectedEvent: () => SocketEvent;
    onCommand: (command: SocketCommand) => void;
};

export type AppSocket = {
    server: WebSocketServer;
    broadcast: (event: SocketEvent) => void;
};

let activeAppSocket: AppSocket | null = null;

export function createAppSocket({
    server,
    path,
    getConnectedEvent,
    onCommand,
}: AppSocketOptions): AppSocket {
    const socketServer = new WebSocketServer({
        server,
        path,
    });

    function broadcast(event: SocketEvent): void {
        for (const client of socketServer.clients) {
            sendAppSocketEvent(client, event);
        }
    }

    socketServer.on('connection', (socket) => {
        logger.log('server', 'WebSocket client connected');

        sendAppSocketEvent(socket, getConnectedEvent());

        socket.on('message', (data) => {
            const commandText = socketDataToText(data);

            const commandType = getSocketCommandType(commandText);

            logger.info('server', `socket command received: ${commandType}`);

            const command = parseSocketCommand(data);
            if (!command) {
                logger.warn(
                    'server',
                    `socket command rejected: ${commandType} payload=${commandText}`
                );
                return;
            }

            logger.info(
                'server',
                `socket command dispatch: ${command.type} args=${formatSocketCommandArgs(command)}`
            );

            onCommand(command);
        });

        socket.on('close', () => {
            logger.log('server', 'WebSocket client disconnected');
        });

        socket.on('error', (error) => {
            logger.warn('server', `WebSocket client error: ${error.message}`);
        });
    });

    activeAppSocket = {
        server: socketServer,
        broadcast,
    };

    return activeAppSocket;
}

function getSocketCommandType(commandText: string): string {
    try {
        const raw = JSON.parse(commandText) as { type?: unknown };
        return typeof raw.type === 'string'
            ? raw.type
            : `invalid:${String(raw.type)}`;
    } catch {
        return 'invalid-json';
    }
}

export function sendAppSocketEvent(
    socket: WebSocket,
    event: SocketEvent
): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify(event));
}

function parseSocketCommand(data: RawData): SocketCommand | null {
    let parsed: unknown;

    try {
        parsed = JSON.parse(socketDataToText(data)) as unknown;
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const command = parsed as SocketCommand;

    const hasId = (): boolean => {
        const id = (command as { id?: unknown }).id;
        return typeof id === 'string' && id.length > 0;
    };

    if (isSocketCommand(command, DOWNLOAD_SOCKET_COMMAND.queue)) {
        const items = (command as { items?: unknown }).items;

        if (!Array.isArray(items)) {
            return null;
        }

        const parsedItems: DownloadQueueItemDetails[] = [];
        for (const item of items) {
            const parsedItem = parseDownloadQueueItemDetails(item);
            if (!parsedItem) {
                return null;
            }
            parsedItems.push(parsedItem);
        }

        return {
            ...command,
            items: parsedItems,
        };
    } else if (isSocketCommand(command, DOWNLOAD_SOCKET_COMMAND)) {
        if (!hasId()) {
            return null;
        }

        return command;
    } else if (
        isSocketCommand(command, STORAGE_COPY_SOCKET_COMMAND) ||
        isSocketCommand(command, STORAGE_DELETE_SOCKET_COMMAND)
    ) {
        if (!hasId()) {
            return null;
        }

        return command;
    } else if (isSocketCommand(command, LIBRARY_VERIFY_SOCKET_COMMAND.clear)) {
        return hasId() ? command : null;
    } else if (isSocketCommand(command, LIBRARY_VERIFY_SOCKET_COMMAND)) {
        return command;
    } else if (isSocketCommand(command, LIBRARY_CONVERT_SOCKET_COMMAND)) {
        return hasId() ? command : null;
    } else if (isSocketCommand(command, TITLE_VALIDATE_SOCKET_COMMAND.queue)) {
        const titleId = (command as { titleId?: unknown }).titleId;
        const name = (command as { name?: unknown }).name;
        const normalizedTitleId = normalizeTitleId(titleId);

        if (!normalizedTitleId || typeof name !== 'string') {
            return null;
        }

        return {
            ...command,
            titleId: normalizedTitleId,
        };
    }

    return null;
}

export function broadcastAppSocketEvent(event: SocketEvent): void {
    activeAppSocket?.broadcast(event);
}

function socketDataToText(data: RawData): string {
    return Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
}

function formatSocketCommandArgs(command: SocketCommand): string {
    return JSON.stringify(
        Object.fromEntries(
            Object.entries(command).filter(([key]) => key !== 'type')
        )
    );
}

function parseDownloadQueueItemDetails(
    value: unknown
): DownloadQueueItemDetails | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const item = value as Record<string, unknown>;
    const titleId = normalizeTitleId(item.titleId);

    if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        !titleId ||
        typeof item.groupName !== 'string' ||
        typeof item.label !== 'string' ||
        typeof item.kind !== 'string' ||
        !Object.values(TitleKinds).includes(item.kind as TitleKinds) ||
        (typeof item.sizeText !== 'string' && item.sizeText !== null) ||
        (typeof item.totalBytes !== 'number' && item.totalBytes !== null)
    ) {
        return null;
    }

    return {
        id: item.id,
        family: getTitleFamily(titleId),
        groupName: item.groupName,
        kind: item.kind as TitleKinds,
        label: item.label,
        titleId,
        sizeText: item.sizeText,
        totalBytes: item.totalBytes,
    };
}
