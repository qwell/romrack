import { Router } from 'express';

import { scanThreeDSTitleRoots } from '../platforms/3ds.js';
import { scanGameCubeTitleRoots } from '../platforms/gamecube.js';
import { scanWiiUTitleRoots } from '../platforms/wiiu.js';
import {
    clearTitleScanCache,
    getLibraryCacheEntry,
    setLibraryCacheGroups,
} from '../library.js';
import { scanWiiTitleRoots } from '../platforms/wii.js';
import { cacheGameTdbMediaForGroups } from '../gametdb.js';
import { requireWiiUTitleQuery, sendServerError } from '../request.js';
import { abortAndClearTitleValidations } from '../actions/titles.js';
import { queueLibraryConversion, verifyLibrary } from '../actions/library.js';
import { type LibraryResponse } from '../../shared/api.js';
import { getConfig } from './config.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/utils.js';

export function createLibraryRouter(): Router {
    const router = Router();

    router.get('/', async (req, res) => {
        if (req.query.clearScanCache === '1') {
            clearTitleScanCache();
            logger.log('server', 'library scan cache cleared');
        }
        try {
            abortAndClearTitleValidations();
        } catch (error) {
            logger.warn(
                'server',
                `Failed to clear title verification cache: ${formatLogError(error)}`
            );
        }
        try {
            const config = getConfig();
            const [threeDSGroups, gameCubeGroups, wiiuGroups, wiiGroups] =
                await Promise.all([
                    scanThreeDSTitleRoots(config['3dsRoots']),
                    scanGameCubeTitleRoots(config.gamecubeRoots),
                    scanWiiUTitleRoots(config.wiiuRoots),
                    scanWiiTitleRoots(config.wiiRoots),
                ]);
            const groups = [
                ...threeDSGroups,
                ...gameCubeGroups,
                ...wiiuGroups,
                ...wiiGroups,
            ].sort((a, b) => a.name.localeCompare(b.name));
            setLibraryCacheGroups(groups);
            const response: LibraryResponse = { groups };
            res.json(response);
            cacheGameTdbMediaForGroups(groups);
            logger.log(
                'server',
                `library scan complete: ${groups.length} title group(s)`
            );
        } catch (error) {
            logger.warn(
                'server',
                `Failed to scan library: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to scan library', error);
        }
    });

    router.get('/verify', async (_req, res) => {
        try {
            res.json(await verifyLibrary());
        } catch (error) {
            const message = formatLogError(error);
            if (message === 'Library verification already in progress') {
                res.status(409).json({ error: message });
                return;
            }
            logger.warn(
                'server',
                `Failed to verify library: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to verify library', error, {
                includeDetails: true,
            });
        }
    });

    router.get('/convert', (req, res) => {
        const title = requireWiiUTitleQuery(req, res);
        if (title === null) return;
        const cached = getLibraryCacheEntry(title.titleId);
        const item = queueLibraryConversion({
            titleId: title.titleId,
            name: cached?.name ?? null,
            kind: title.kind,
            version: cached?.version ?? null,
        });
        res.status(202).json({ conversionId: item.id, item });
    });

    return router;
}
