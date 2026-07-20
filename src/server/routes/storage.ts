import { Router, type Request, type Response } from 'express';

import {
    queueStorageDelete,
    queueStorageTransfer,
} from '../actions/storage.js';
import {
    getStringQuery,
    requireTitleQuery,
    sendServerError,
} from '../request.js';
import { getRuntimeOs, listFat32Volumes } from '../../shared/os.js';
import { type StorageFat32ListResponse } from '../../shared/api.js';
import { type StorageTransferQueueInput } from '../../shared/storage.js';
import { type TitleIdentity } from '../../shared/titles.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/utils.js';

export function createStorageRouter(): Router {
    const router = Router();

    router.get('/copy', (req, res) => {
        queueStorageTransferRoute(req, res, false);
    });

    router.get('/move', (req, res) => {
        queueStorageTransferRoute(req, res, true);
    });

    router.get('/delete', (req, res) => {
        const title = requireTitleQuery(req, res);
        if (title === null) {
            return;
        }

        try {
            const result = queueStorageDelete(title);
            res.status(result.status).json(result.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to queue storage delete: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to queue storage delete', error, {
                includeDetails: true,
            });
        }
    });

    router.get('/list-fat32', async (_req, res) => {
        try {
            const [runtimeOs, volumes] = await Promise.all([
                getRuntimeOs(),
                listFat32Volumes(),
            ]);
            const response: StorageFat32ListResponse = { runtimeOs, volumes };
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to list FAT32 volumes: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to list FAT32 volumes', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}

function queueStorageTransferRoute(
    req: Request,
    res: Response,
    move: boolean
): void {
    const title = requireTitleQuery(req, res);
    if (title === null) {
        return;
    }

    try {
        const result = queueStorageTransfer(
            getStorageTransferQueueInput(req, title, move)
        );
        res.status(result.status).json(result.body);
    } catch (error) {
        const operation = move ? 'move' : 'copy';
        logger.warn(
            'server',
            `Failed to queue storage ${operation}: ${formatLogError(error)}`
        );
        sendServerError(res, `Failed to queue storage ${operation}`, error, {
            includeDetails: true,
        });
    }
}

function getStorageTransferQueueInput(
    req: Request,
    title: TitleIdentity,
    move: boolean
): StorageTransferQueueInput {
    return {
        title,
        requestedDestination: getStringQuery(req, 'dest'),
        move,
    };
}
