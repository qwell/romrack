import { type Request, type Response, Router } from 'express';

import {
    downloadNusBaseMetadata,
    getDlcMetadata,
    getUpdateMetadata,
    type NusTitleMetadata,
    readThreeDSDownloadOptions,
} from '../nus.js';
import { THREE_DS_NUS_BASE_URL, WII_U_NUS_BASE_URL } from '../nus.js';
import {
    getStringQuery,
    requireWiiUTitleQuery,
    sendServerError,
} from '../request.js';
import {
    identifyThreeDSTitle,
    isTitlePlatform,
    replaceTitleKind,
    TitleKinds,
    TitlePlatform,
} from '../../shared/titles.js';
import {
    type TitleLookupResponse,
    type TitleLookupWiiUResponse,
} from '../../shared/api.js';
import { HttpError } from '../../shared/download.js';
import logger from '../../shared/logger.js';
import { formatLogError } from '../../shared/utils.js';

type NusMetadataOptions = Parameters<typeof downloadNusBaseMetadata>[1];

export function createTitleRouter(): Router {
    const router = Router();

    router.get('/:platform', async (req, res) => {
        const { platform } = req.params;
        if (!isTitlePlatform(platform)) {
            res.status(400).json({
                error: 'Invalid title lookup platform',
            });
            return;
        }

        try {
            await handleTitleLookup(platform, req, res);
        } catch (error) {
            handleTitleLookupError(res, error);
        }
    });

    return router;
}

async function handleTitleLookup(
    platform: TitlePlatform,
    req: Request,
    res: Response
): Promise<void> {
    switch (platform) {
        case '3ds':
            await handleThreeDSTitleLookup(req, res);
            return;

        case 'gamecube':
        case 'wii':
            handleUnavailableTitleLookup(platform, res);
            return;

        case 'wiiu':
            await handleWiiUTitleLookup(req, res);
            return;
    }
}

function handleUnavailableTitleLookup(
    platform: TitlePlatform,
    res: Response
): void {
    res.status(404).json({
        error: `Title lookup is not available for ${TitlePlatform[platform]} titles`,
    });
}

async function handleWiiUTitleLookup(
    req: Request,
    res: Response
): Promise<void> {
    const title = requireWiiUTitleQuery(req, res);
    if (!title) {
        return;
    }
    const { titleId } = title;
    const nusOptions = {
        baseUrl: WII_U_NUS_BASE_URL,
    };

    const metadata = await getOptionalBaseMetadata(titleId, nusOptions);
    const updateMetadata = await getOptionalChildMetadata(
        'update',
        titleId,
        () => getUpdateMetadata(titleId, nusOptions)
    );
    const dlcMetadata = await getOptionalChildMetadata('dlc', titleId, () =>
        getDlcMetadata(titleId, nusOptions)
    );

    if (!metadata && !updateMetadata.exists && !dlcMetadata.exists) {
        res.status(404).json({
            error: 'Failed to parse title metadata',
            message: 'base, update, and dlc TMDs are not available',
        });
        return;
    }

    const response: TitleLookupWiiUResponse = {
        titleId: metadata?.titleId ?? titleId,
        name: metadata?.name ?? null,
        region: metadata?.region ?? null,
        productCode: metadata?.productCode ?? null,
        companyCode: metadata?.companyCode ?? null,
        baseVersions: metadata ? [metadata.titleVersion] : [],
        titleKey: metadata?.titleKey
            ? Buffer.from(metadata.titleKey).toString('hex')
            : null,
        titleKeyPassword: metadata?.titleKeyPassword ?? null,
        updateVersions:
            updateMetadata.exists && updateMetadata.titleVersion !== null
                ? [updateMetadata.titleVersion]
                : [],
        dlcVersions:
            dlcMetadata.exists && dlcMetadata.titleVersion !== null
                ? [dlcMetadata.titleVersion]
                : [],
    };
    res.json(response);
}

async function handleThreeDSTitleLookup(
    req: Request,
    res: Response
): Promise<void> {
    const titleId = getStringQuery(req, 'titleId');
    const title = titleId ? identifyThreeDSTitle(titleId) : null;
    if (!title) {
        res.status(400).json({
            error: 'titleId query parameter must be a 3DS title ID',
        });
        return;
    }

    const downloadOptions = await readThreeDSDownloadOptions();
    const nusOptions = {
        baseUrl: THREE_DS_NUS_BASE_URL,
        downloadOptions,
    };
    const baseTitleId = replaceTitleKind(title.titleId, TitleKinds.Base);
    const metadata = await downloadNusBaseMetadata(baseTitleId, nusOptions);
    const updateMetadata = await getOptionalChildMetadata(
        'update',
        baseTitleId,
        () => getUpdateMetadata(baseTitleId, nusOptions)
    );
    const dlcMetadata = await getOptionalChildMetadata('dlc', baseTitleId, () =>
        getDlcMetadata(baseTitleId, nusOptions)
    );

    if (!metadata && !updateMetadata.exists && !dlcMetadata.exists) {
        res.status(404).json({
            error: 'Failed to parse title metadata',
            message: 'base, update, and dlc TMDs are not available',
        });
        return;
    }

    const response: TitleLookupResponse = {
        titleId: metadata?.titleId ?? baseTitleId,
        name: metadata?.name ?? null,
        region: metadata?.region ?? null,
        productCode: metadata?.productCode ?? null,
        companyCode: metadata?.companyCode ?? null,
        baseVersions: metadata ? [metadata.titleVersion] : [],
        updateVersions:
            updateMetadata.exists && updateMetadata.titleVersion !== null
                ? [updateMetadata.titleVersion]
                : [],
        dlcVersions:
            dlcMetadata.exists && dlcMetadata.titleVersion !== null
                ? [dlcMetadata.titleVersion]
                : [],
        iconUrl: null,
        availableOnCdn: metadata !== null,
    };

    res.json(response);
}

function handleTitleLookupError(res: Response, error: unknown): void {
    logger.warn(
        'server',
        `Failed to load full title metadata: ${formatLogError(error)}`
    );
    if (error instanceof HttpError) {
        res.status(error.status).json({
            error: 'Failed to load full title metadata',
            message: error.details ?? error.message,
        });
        return;
    }

    sendServerError(res, 'Failed to load full title metadata', error, {
        includeDetails: true,
    });
}

async function getOptionalChildMetadata(
    kind: string,
    titleId: string,
    readMetadata: () => ReturnType<typeof getUpdateMetadata>
): ReturnType<typeof getUpdateMetadata> {
    try {
        return await readMetadata();
    } catch (error) {
        if (error instanceof HttpError || error instanceof TypeError) {
            logger.warn(
                'server',
                `Skipping ${kind} metadata for ${titleId}: ${formatLogError(error)}`
            );
            return {
                titleId,
                childTitleId: titleId,
                exists: false,
                titleVersion: null,
            };
        }

        throw error;
    }
}

async function getOptionalBaseMetadata(
    titleId: string,
    options: NusMetadataOptions
): Promise<NusTitleMetadata | null> {
    try {
        return await downloadNusBaseMetadata(titleId, options);
    } catch (error) {
        if (error instanceof HttpError || error instanceof TypeError) {
            logger.warn(
                'server',
                `Skipping base metadata for ${titleId}: ${formatLogError(error)}`
            );
            return null;
        }

        throw error;
    }
}
