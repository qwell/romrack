import express, { type Request, type Response } from 'express';
import open from 'open';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import path from 'node:path';

import { getAppRoot } from './paths.js';
import { loadConfig } from './config.js';
import {
    downloadNusTitleMetadata,
    generateTitleInstallFiles,
    getDlcMetadata,
    getUpdateMetadata,
    TitleDownloadProgress,
} from './metadata.js';
import { getCachedImage } from './image-cache.js';
import {
    findFirstReadableWiiURoot,
    getTitleIconUrl,
    scanWiiUTitleRoots,
    validateWiiUTitleRoots,
} from './wiiu.js';
import {
    AppSocketCommand,
    AppSocketEvent,
    DownloadSocketCommand,
    DownloadQueueItem,
} from '../shared/socket.js';
import logger from '../shared/logger.js';

const config = loadConfig();

const app = express();
const host = config.host;
const port = config.port;
const romRoots = config.wiiuRoots;

const clientDir = path.join(getAppRoot(), 'client');

type TitleIdQueryResult =
    | {
          ok: true;
          titleId: string;
      }
    | {
          ok: false;
          error: string;
      };

function getTitleIdQuery(req: Request): TitleIdQueryResult {
    const { titleId } = req.query;

    if (typeof titleId !== 'string' || titleId.length === 0) {
        return {
            ok: false,
            error: 'Missing titleId query parameter',
        };
    }

    if (!/^[0-9a-f]{16}$/i.test(titleId)) {
        return {
            ok: false,
            error: 'titleId query parameter must be 16 hexadecimal characters',
        };
    }

    return {
        ok: true,
        titleId: titleId.toLowerCase(),
    };
}

function requireTitleIdQuery(req: Request, res: Response): string | null {
    const result = getTitleIdQuery(req);
    if (result.ok) {
        return result.titleId;
    }

    res.status(400).json({
        error: result.error,
    });
    return null;
}

function getErrorStage(error: unknown): string | null {
    return typeof error === 'object' &&
        error !== null &&
        'stage' in error &&
        typeof error.stage === 'string'
        ? error.stage
        : null;
}

function sendServerError(
    res: Response,
    publicError: string,
    error: unknown,
    options: { includeDetails?: boolean } = {}
): void {
    const body: {
        error: string;
        message?: string;
        stage?: string | null;
    } = {
        error: publicError,
    };

    if (options.includeDetails) {
        body.message = error instanceof Error ? error.message : String(error);
        body.stage = getErrorStage(error);
    }

    res.status(500).json(body);
}

function handleAppSocketCommand(command: AppSocketCommand): void {
    if (command.type.startsWith('download.')) {
        handleDownloadSocketCommand(command);
        return;
    }
}

let downloadQueue: DownloadQueueItem[] = [];
let activeDownloadItemId: string | null = null;

function sendAppSocketEvent(socket: WebSocket, event: AppSocketEvent): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify(event));
}

function broadcastAppSocketEvent(event: AppSocketEvent): void {
    for (const client of socketServer.clients) {
        sendAppSocketEvent(client, event);
    }
}

function broadcastDownloadQueue(): void {
    broadcastAppSocketEvent({
        type: 'download.queueChanged',
        items: downloadQueue,
    });
}

function parseSocketCommand(data: RawData): AppSocketCommand | null {
    try {
        const text = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');

        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const command = parsed as { type?: unknown };

        if (typeof command.type !== 'string') {
            return null;
        }

        return parsed as AppSocketCommand;
    } catch {
        return null;
    }
}

async function downloadTitle(
    titleId: string,
    onProgress?: (progress: TitleDownloadProgress) => void
) {
    const romRoot = await findFirstReadableWiiURoot(romRoots);

    return generateTitleInstallFiles(titleId, romRoot, {
        onProgress,
    });
}

async function processDownloadQueue(): Promise<void> {
    if (activeDownloadItemId) {
        return;
    }

    const nextItem = downloadQueue.find((item) => item.state === 'queued');

    if (!nextItem) {
        broadcastDownloadQueue();
        return;
    }

    activeDownloadItemId = nextItem.id;
    nextItem.state = 'downloading';
    nextItem.error = null;
    nextItem.progress = 0;
    nextItem.downloadedBytes = null;
    nextItem.speedText = null;
    nextItem.installedSizeBytes = null;
    nextItem.installedVersion = null;
    nextItem.installedTitleName = null;
    broadcastDownloadQueue();

    try {
        const result = await downloadTitle(nextItem.titleId, (progress) => {
            nextItem.progress =
                progress.totalFiles > 0
                    ? Math.round(
                          (progress.completedFiles / progress.totalFiles) * 100
                      )
                    : 0;

            nextItem.downloadedBytes = null;
            nextItem.speedText = `${progress.completedFiles}/${progress.totalFiles} files`;

            broadcastDownloadQueue();
        });
        nextItem.state = 'complete';
        nextItem.error = null;
        nextItem.progress = 100;
        nextItem.downloadedBytes = result.sizeBytes;
        nextItem.speedText = null;
        nextItem.installedSizeBytes = result.sizeBytes;
        nextItem.installedVersion = result.titleVersion;
        nextItem.installedTitleName = result.name;

        broadcastDownloadQueue();
    } catch (error) {
        nextItem.state = 'failed';
        nextItem.error = error instanceof Error ? error.message : String(error);
        broadcastDownloadQueue();
    } finally {
        activeDownloadItemId = null;
        void processDownloadQueue();
    }
}

function handleDownloadSocketCommand(command: DownloadSocketCommand): void {
    switch (command.type) {
        case 'download.enqueue': {
            const newItems = command.items.filter(
                (item) =>
                    !downloadQueue.some(
                        (existing) =>
                            existing.family === item.family &&
                            existing.kind === item.kind &&
                            existing.titleId === item.titleId &&
                            existing.state !== 'complete'
                    )
            );

            if (newItems.length === 0) {
                return;
            }

            downloadQueue.push(
                ...newItems.map((item) => ({
                    ...item,
                    state: 'queued' as const,
                    error: null,
                    progress: 0,
                    downloadedBytes: null,
                    speedText: null,
                    installedSizeBytes: null,
                    installedVersion: null,
                    installedTitleName: null,
                }))
            );

            broadcastDownloadQueue();
            void processDownloadQueue();
            return;
        }

        case 'download.retry': {
            const item = downloadQueue.find(
                (candidate) => candidate.id === command.id
            );

            if (!item || item.state !== 'failed') {
                return;
            }

            item.state = 'queued';
            item.error = null;
            item.installedSizeBytes = null;
            item.installedVersion = null;
            item.installedTitleName = null;

            broadcastDownloadQueue();
            void processDownloadQueue();
            return;
        }

        case 'download.remove': {
            const item = downloadQueue.find(
                (candidate) => candidate.id === command.id
            );

            if (!item || item.state === 'downloading') {
                return;
            }

            downloadQueue = downloadQueue.filter(
                (candidate) => candidate.id !== command.id
            );

            broadcastDownloadQueue();
            return;
        }
    }
}

function formatLogError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function logServerError(message: string, error: unknown): void {
    logger.error('server', `${message} ${formatLogError(error)}`);
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
app.use(express.static(clientDir));

app.get('/api/library', async (req, res) => {
    try {
        const includeAll = req.query.includeAll === 'true';
        const groups = await scanWiiUTitleRoots(romRoots, { includeAll });

        res.json({
            groups,
        });
    } catch (error) {
        logServerError('[server] Failed to scan library:', error);
        sendServerError(res, 'Failed to scan library', error);
    }
});

app.get('/api/library/validate', async (_req, res) => {
    try {
        broadcastAppSocketEvent({
            type: 'library.validationStatus',
            status: 'started',
        });

        const titles = await validateWiiUTitleRoots(romRoots, (progress) => {
            broadcastAppSocketEvent({
                type: 'library.validationStatus',
                ...progress,
            });
        });
        const failed = titles.filter((title) => title.status !== 'ok').length;

        broadcastAppSocketEvent({
            type: 'library.validationStatus',
            status: 'complete',
            total: titles.length,
            failed,
        });

        res.json({
            status: failed === 0 ? 'ok' : 'failed',
            total: titles.length,
            failed,
            titles,
        });
    } catch (error) {
        logServerError('[server] Failed to validate library:', error);
        sendServerError(res, 'Failed to validate library', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-icon/:family', async (req, res) => {
    try {
        const iconUrl = await getTitleIconUrl(req.params.family);

        if (!iconUrl) {
            res.status(404).json({
                error: 'Missing title icon',
            });
            return;
        }

        const image = await getCachedImage(iconUrl);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(image.body);
    } catch (error) {
        logServerError('[server] Failed to load title icon:', error);
        sendServerError(res, 'Failed to load title icon', error);
    }
});

app.get('/api/title-metadata', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const metadata = await downloadNusTitleMetadata(titleId);

        if (!metadata) {
            res.status(404).json({
                error: 'Failed to parse title metadata',
            });
            return;
        }

        res.json({
            titleId: metadata.titleId,
            name: metadata.name,
            region: metadata.region,
            productCode: metadata.productCode,
            companyCode: metadata.companyCode,
            baseVersions:
                metadata.titleVersion === null ? [] : [metadata.titleVersion],
            metaJson: metadata.metaJson,
            titleKey: metadata.titleKey
                ? Buffer.from(metadata.titleKey).toString('hex')
                : null,
            titleKeyPassword: metadata.titleKeyPassword,
        });
    } catch (error) {
        logServerError('[server] Failed to download title metadata:', error);
        sendServerError(res, 'Failed to download title metadata', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-all', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const [metadata, updateMetadata, dlcMetadata] = await Promise.all([
            downloadNusTitleMetadata(titleId),
            getUpdateMetadata(titleId),
            getDlcMetadata(titleId),
        ]);

        if (!metadata) {
            res.status(404).json({
                error: 'Failed to parse title metadata',
            });
            return;
        }

        res.json({
            titleId: metadata.titleId,
            name: metadata.name,
            region: metadata.region,
            productCode: metadata.productCode,
            companyCode: metadata.companyCode,
            baseVersions:
                metadata.titleVersion === null ? [] : [metadata.titleVersion],
            titleKey: metadata.titleKey
                ? Buffer.from(metadata.titleKey).toString('hex')
                : null,
            titleKeyPassword: metadata.titleKeyPassword,
            updates:
                updateMetadata.exists && updateMetadata.titleVersion !== null
                    ? [updateMetadata.titleVersion]
                    : [],
            dlc:
                dlcMetadata.exists && dlcMetadata.titleVersion !== null
                    ? [dlcMetadata.titleVersion]
                    : [],
        });
    } catch (error) {
        logServerError('[server] Failed to load full title metadata:', error);
        sendServerError(res, 'Failed to load full title metadata', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-download', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        res.json(await downloadTitle(titleId));
    } catch (error) {
        logServerError('[server] Failed to download title:', error);
        sendServerError(res, 'Failed to download title', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-update', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const metadata = await getUpdateMetadata(titleId);
        res.json({
            titleId: metadata.titleId,
            updateTitleId: metadata.childTitleId,
            exists: metadata.exists,
            titleVersion: metadata.titleVersion,
        });
    } catch (error) {
        logServerError('[server] Failed to load title update metadata:', error);
        sendServerError(res, 'Failed to load title update metadata', error, {
            includeDetails: true,
        });
    }
});

app.get('/api/title-dlc', async (req, res) => {
    const titleId = requireTitleIdQuery(req, res);
    if (!titleId) {
        return;
    }

    try {
        const metadata = await getDlcMetadata(titleId);
        res.json({
            titleId: metadata.titleId,
            dlcTitleId: metadata.childTitleId,
            exists: metadata.exists,
            titleVersion: metadata.titleVersion,
        });
    } catch (error) {
        logServerError('[server] Failed to load title DLC metadata:', error);
        sendServerError(res, 'Failed to load title DLC metadata', error, {
            includeDetails: true,
        });
    }
});

const server = createServer(app);

const socketServer = new WebSocketServer({
    server,
    path: '/api/socket',
});

socketServer.on('connection', (socket) => {
    logger.log('server', 'WebSocket client connected');

    sendAppSocketEvent(socket, {
        type: 'app.connected',
        downloads: downloadQueue,
    });

    socket.on('message', (data) => {
        const command = parseSocketCommand(data);

        if (!command) {
            return;
        }

        handleAppSocketCommand(command);
    });

    socket.on('close', () => {
        logger.warn('server', 'WebSocket client disconnected');
    });

    socket.on('error', (error) => {
        logger.warn(
            'server',
            `WebSocket client error: ${formatLogError(error)}`
        );
    });
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
