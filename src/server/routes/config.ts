import { Router } from 'express';
import {
    type ConfigResponse,
    type ConfigValidateRootResponse,
} from '../../shared/api.js';
import {
    getConfig,
    saveConfig,
    type AppConfigUpdate,
} from '../../shared/config.js';
import { validateWiiURoot } from '../../shared/wiiu.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/shared.js';
import { sendServerError } from '../routes.js';

function getConfigRootBodyValue(body: unknown): string {
    if (
        typeof body === 'object' &&
        body !== null &&
        'root' in body &&
        typeof body.root === 'string'
    ) {
        return body.root;
    }

    return '';
}

export function createConfigRouter(): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        const response: ConfigResponse = {
            config: getConfig(),
            restartRequired: false,
        };
        logger.log('server', `config loaded: ${JSON.stringify(response)}`);
        res.json(response);
    });

    router.post('/validate-root', async (req, res) => {
        try {
            const root = getConfigRootBodyValue(req.body as unknown);
            const response: ConfigValidateRootResponse =
                await validateWiiURoot(root);
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to validate Wii U root: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to validate Wii U root', error, {
                includeDetails: true,
            });
        }
    });

    router.post('/', (req, res) => {
        try {
            const response: ConfigResponse = saveConfig(
                req.body as AppConfigUpdate
            );
            logger.log('server', `config saved: ${JSON.stringify(response)}`);
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to save config: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to save config', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}
