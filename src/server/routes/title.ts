import { Router, type Request, type Response } from 'express';

import {
    downloadNusTitleMetadata,
    generateTitleInstallFiles,
    getDlcMetadata,
    getUpdateMetadata,
    TitleDownloadProgress,
} from '../metadata.js';
import { sendServerError } from '../routes.js';
import { findFirstReadableWiiURoot } from '../wiiu.js';
import {
    type TitleDownloadResponse,
    type TitleResponse,
} from '../../shared/api.js';
import { getConfig } from '../../shared/config.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/shared.js';

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

export async function downloadTitle(
    titleId: string,
    onProgress?: (progress: TitleDownloadProgress) => void,
    signal?: AbortSignal
): Promise<TitleDownloadResponse> {
    const romRoot = await findFirstReadableWiiURoot(getConfig().wiiuRoots);

    return generateTitleInstallFiles(titleId, romRoot, {
        onProgress,
        signal,
    });
}

export function createTitleRouter(): Router {
    const router = Router();

    router.get('/', async (req, res) => {
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

            const response: TitleResponse = {
                titleId: metadata.titleId,
                name: metadata.name,
                region: metadata.region,
                productCode: metadata.productCode,
                companyCode: metadata.companyCode,
                baseVersions:
                    metadata.titleVersion === null
                        ? []
                        : [metadata.titleVersion],
                titleKey: metadata.titleKey
                    ? Buffer.from(metadata.titleKey).toString('hex')
                    : null,
                titleKeyPassword: metadata.titleKeyPassword,
                updates:
                    updateMetadata.exists &&
                    updateMetadata.titleVersion !== null
                        ? [updateMetadata.titleVersion]
                        : [],
                dlc:
                    dlcMetadata.exists && dlcMetadata.titleVersion !== null
                        ? [dlcMetadata.titleVersion]
                        : [],
            };
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to load full title metadata: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to load full title metadata', error, {
                includeDetails: true,
            });
        }
    });

    router.get('/download', async (req, res) => {
        const titleId = requireTitleIdQuery(req, res);
        if (!titleId) {
            return;
        }

        try {
            const response: TitleDownloadResponse =
                await downloadTitle(titleId);
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to download title: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to download title', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}
