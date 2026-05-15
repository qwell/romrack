import { Router } from 'express';

import { getCachedImage } from '../image-cache.js';
import { sendServerError } from '../routes.js';
import { getTitleIconUrl } from '../wiiu.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/shared.js';

export function createIconRouter(): Router {
    const router = Router();

    router.get('/:family', async (req, res) => {
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
            res.set('Content-Type', image.contentType);
            res.send(image.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to load title icon: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to load title icon', error);
        }
    });

    return router;
}
