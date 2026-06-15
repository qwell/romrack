import express from 'express';
import open from 'open';
import { createServer } from 'node:http';
import path from 'node:path';

import { getAppRoot } from './paths.js';
import { createAppSocket } from './socket.js';
import { getConfig } from './routes/config.js';
import logger from '../shared/logger.js';
import { formatLogError } from '../shared/shared.js';
import {
    type SocketCommand,
    APP_SOCKET_EVENT,
    DOWNLOAD_SOCKET_COMMAND,
    LIBRARY_CONVERT_SOCKET_COMMAND,
    LIBRARY_VERIFY_SOCKET_COMMAND,
    STORAGE_COPY_SOCKET_COMMAND,
    STORAGE_DELETE_SOCKET_COMMAND,
    TITLE_VALIDATE_SOCKET_COMMAND,
    isSocketCommand,
} from '../shared/socket.js';
import {
    createIconRouter,
    createConfigRouter,
    createStorageRouter,
    getStorageCopies,
    getStorageDeletes,
    handleStorageCopySocketCommand,
    handleStorageDeleteSocketCommand,
    createLibraryRouter,
    getLibraryConversions,
    getLibraryVerifyEvents,
    handleLibraryConvertSocketCommand,
    handleLibraryVerifySocketCommand,
    createTitleRouter,
    handleTitleValidationSocketCommand,
    getTitleValidationResults,
    getDownloadQueue,
    handleDownloadSocketCommand,
} from './routes.js';

const config = getConfig();

const app = express();
const host = config.host;
const port = config.port;

const clientDir = path.join(getAppRoot(), 'client');

function handleAppSocketCommand(command: SocketCommand): void {
    if (isSocketCommand(command, DOWNLOAD_SOCKET_COMMAND)) {
        handleDownloadSocketCommand(command);
        return;
    }
    if (isSocketCommand(command, STORAGE_COPY_SOCKET_COMMAND)) {
        handleStorageCopySocketCommand(command);
        return;
    }
    if (isSocketCommand(command, STORAGE_DELETE_SOCKET_COMMAND)) {
        handleStorageDeleteSocketCommand(command);
        return;
    }
    if (isSocketCommand(command, LIBRARY_VERIFY_SOCKET_COMMAND)) {
        handleLibraryVerifySocketCommand(command);
        return;
    }
    if (isSocketCommand(command, LIBRARY_CONVERT_SOCKET_COMMAND)) {
        handleLibraryConvertSocketCommand(command);
        return;
    }
    if (isSocketCommand(command, TITLE_VALIDATE_SOCKET_COMMAND)) {
        handleTitleValidationSocketCommand(command);
    }
}

function formatUrlHost(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function getBrowserUrl(host: string, port: number): string {
    const browserHost =
        host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `http://${formatUrlHost(browserHost)}:${port}`;
}

function getListenUrl(host: string, port: number): string {
    return `http://${formatUrlHost(host)}:${port}`;
}

app.use((req, _res, next) => {
    logger.log('server', `${req.method} ${req.url}`);
    next();
});

app.use(express.json());
app.use(
    express.static(clientDir, {
        etag: false,
        setHeaders(res) {
            res.setHeader('Cache-Control', 'no-store');
        },
    })
);

app.use('/api/config', createConfigRouter());
app.use('/api/icon', createIconRouter());
app.use('/api/library', createLibraryRouter());
app.use('/api/storage', createStorageRouter());
app.use('/api/title', createTitleRouter());

const server = createServer(app);
createAppSocket({
    server,
    path: '/api/socket',
    getConnectedEvent: () => ({
        type: APP_SOCKET_EVENT.connected,
        downloads: getDownloadQueue(),
        storageCopies: getStorageCopies(),
        storageDeletes: getStorageDeletes(),
        libraryVerifyEvents: getLibraryVerifyEvents(),
        libraryConversions: getLibraryConversions(),
        titleValidations: getTitleValidationResults(),
    }),
    onCommand: handleAppSocketCommand,
});

server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(
        'server',
        `Failed to listen at ${getListenUrl(host, port)}: ${error.message}`
    );
    process.exit(1);
});

server.on('listening', () => {
    logger.log('server', `Listening at ${getListenUrl(host, port)}`);

    if (config.openBrowser) {
        const url = getBrowserUrl(host, port);
        logger.log('server', `Opening browser at ${url}`);
        void open(url).catch((error: unknown) => {
            logger.warn(
                'server',
                `Failed to open browser: ${formatLogError(error)}`
            );
        });
    }
});

server.listen(port, host);
