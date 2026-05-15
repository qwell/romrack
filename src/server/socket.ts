import { type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
    type AppSocketCommand,
    type AppSocketEvent,
    SOCKET_COMMAND,
    isDownloadSocketCommand,
    isIdSocketCommandType,
    isStorageCopySocketCommand,
    isStorageDeleteSocketCommand,
} from '../shared/socket.js';
import { type DownloadQueueItem } from '../shared/download.js';
import logger from '../shared/logger.js';
import {
    handleStorageCopySocketCommand,
    handleStorageDeleteSocketCommand,
} from './routes/storage.js';
import { handleDownloadSocketCommand } from './routes/download.js';

type AppSocketOptions = {
    server: Server;
    path: string;
    getConnectedEvent: () => AppSocketEvent;
    onCommand: (command: AppSocketCommand) => void;
};

export type AppSocket = {
    server: WebSocketServer;
    broadcast: (event: AppSocketEvent) => void;
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

    function broadcast(event: AppSocketEvent): void {
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
    event: AppSocketEvent
): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify(event));
}

export function handleAppSocketCommand(command: AppSocketCommand): void {
    if (isDownloadSocketCommand(command)) {
        handleDownloadSocketCommand(command);
        return;
    }

    if (isStorageCopySocketCommand(command)) {
        handleStorageCopySocketCommand(command);
        return;
    }

    if (isStorageDeleteSocketCommand(command)) {
        handleStorageDeleteSocketCommand(command);
    }
}

export function broadcastAppSocketEvent(event: AppSocketEvent): void {
    activeAppSocket?.broadcast(event);
}

function socketDataToText(data: RawData): string {
    return Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
}

function formatSocketCommandArgs(command: AppSocketCommand): string {
    return JSON.stringify(
        Object.fromEntries(
            Object.entries(command).filter(([key]) => key !== 'type')
        )
    );
}

function isDownloadQueueItem(value: unknown): value is DownloadQueueItem {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const item = value as Record<string, unknown>;

    return (
        typeof item.id === 'string' &&
        typeof item.family === 'string' &&
        typeof item.groupName === 'string' &&
        typeof item.label === 'string' &&
        typeof item.titleId === 'string' &&
        typeof item.kind === 'string' &&
        (typeof item.sizeText === 'string' || item.sizeText === null) &&
        (typeof item.totalBytes === 'number' || item.totalBytes === null)
    );
}

function parseSocketCommand(data: RawData): AppSocketCommand | null {
    let parsed: unknown;

    try {
        parsed = JSON.parse(socketDataToText(data)) as unknown;
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const command = parsed as { type?: unknown };

    if (command.type === SOCKET_COMMAND.downloadQueue) {
        const items = (command as { items?: unknown }).items;

        if (!Array.isArray(items) || !items.every(isDownloadQueueItem)) {
            return null;
        }

        return parsed as AppSocketCommand;
    }

    if (isIdSocketCommandType(command.type)) {
        const id = (command as { id?: unknown }).id;

        if (typeof id !== 'string' || id.length === 0) {
            return null;
        }

        return parsed as AppSocketCommand;
    }

    return null;
}
