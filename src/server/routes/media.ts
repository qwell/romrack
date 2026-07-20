import { Router } from 'express';

import { sendServerError } from '../request.js';
import { readThreeDSTitleMedia } from '../platforms/3ds.js';
import { readGameCubeTitleMedia } from '../platforms/gamecube.js';
import { readWiiTitleMedia } from '../platforms/wii.js';
import { readWiiUTitleMedia } from '../platforms/wiiu.js';
import logger from '../../shared/logger.js';
import {
    isTitleMediaType,
    isTitlePlatform,
    type TitleMediaType,
    type TitlePlatform,
} from '../../shared/titles.js';
import { formatLogError } from '../../shared/utils.js';

function readTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
) {
    switch (platform) {
        case '3ds':
            return readThreeDSTitleMedia(type, platform, productCode);
        case 'gamecube':
            return readGameCubeTitleMedia(type, platform, productCode);
        case 'wii':
            return readWiiTitleMedia(type, platform, productCode);
        case 'wiiu':
            return readWiiUTitleMedia(type, platform, productCode);
    }
}

export function createMediaRouter(): Router {
    const router = Router();

    router.get('/:type/:platform/:productCode', async (req, res) => {
        const { type, platform, productCode } = req.params;

        try {
            if (!isTitlePlatform(platform)) {
                res.status(400).json({
                    error: 'Invalid title media platform',
                });
                return;
            }

            if (!isTitleMediaType(type)) {
                res.status(400).json({
                    error: 'Invalid title media type',
                });
                return;
            }

            const image = await readTitleMedia(type, platform, productCode);
            if (!image) {
                res.status(404).json({
                    error: 'Missing title media',
                });
                return;
            }

            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.set('Content-Type', image.contentType);
            res.send(image.body);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to load title media: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to load title media', error);
        }
    });

    return router;
}
