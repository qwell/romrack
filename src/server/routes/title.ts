import { type Request, type Response, Router } from 'express';

import {
    downloadNusBaseMetadata,
    getDlcMetadata,
    getUpdateMetadata,
    type NusTitleMetadata,
    readThreeDSDownloadOptions,
} from '../title.js';
import {
    THREE_DS_NUS_BASE_URL,
    WII_U_NUS_BASE_URL,
} from '../download-title.js';
import {
    getStringQuery,
    requireWiiUTitleQuery,
    sendServerError,
} from '../request.js';
import { broadcastAppSocketEvent } from '../socket.js';
import { findWiiUTitleSourcePaths } from '../wiiu.js';
import {
    identifyTitle,
    identifyThreeDSTitle,
    isTitlePlatform,
    replaceTitleKind,
    type TitleIdentity,
    type TitlePlatform,
    TitleKinds,
} from '../../shared/titles.js';
import {
    type TitleLookupResponse,
    type TitleLookupWiiUResponse,
} from '../../shared/api.js';
import { getConfig } from './config.js';
import { HttpError } from '../../shared/download.js';
import logger from '../../shared/logger.js';
import { resolveReadablePath } from '../../shared/os.js';
import { formatLogError } from '../../shared/utils.js';
import {
    TITLE_VALIDATE_SOCKET_COMMAND,
    TITLE_VALIDATE_SOCKET_EVENT,
    TitleValidationSocketEvent,
    type TitleValidationCopyResult,
    type TitleValidationSocketCommand,
} from '../../shared/socket.js';
import { validateTitleInstallFileSizes } from '../install-title.js';
import {
    findThreeDSTitleSourcePaths,
    validateThreeDSTitleFile,
} from '../3ds.js';

const activeTitleValidations = new Map<string, AbortController>();
const titleValidationResults = new Map<string, TitleValidationSocketEvent>();
type NusMetadataOptions = Parameters<typeof downloadNusBaseMetadata>[1];

export function getTitleValidationResults(): TitleValidationSocketEvent[] {
    return [...titleValidationResults.values()];
}

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

        case 'wii':
            handleWiiTitleLookup(res);
            return;

        case 'wiiu':
            await handleWiiUTitleLookup(req, res);
            return;
    }
}

function handleWiiTitleLookup(res: Response): void {
    res.status(404).json({
        error: 'Title lookup is not available for Wii titles',
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

export function handleTitleValidationSocketCommand(
    command: TitleValidationSocketCommand
): void {
    switch (command.type) {
        case TITLE_VALIDATE_SOCKET_COMMAND.queue:
            void validateTitleCopies(command.id);
            return;
    }
}

async function validateTitleCopies(titleId: string): Promise<void> {
    const title = identifyTitle(titleId);
    if (!title) {
        logger.warn('server', `Invalid title validation request: ${titleId}`);
        return;
    }

    if (activeTitleValidations.has(title.titleId)) {
        return;
    }

    const cached = titleValidationResults.get(title.titleId);
    if (cached) {
        broadcastAppSocketEvent(cached);
        return;
    }

    await runTitleCopyValidation(title, null);
}

async function runTitleCopyValidation(
    title: TitleIdentity,
    sourcePaths: string[] | null
): Promise<void> {
    const { titleId } = title;
    const abortController = new AbortController();
    activeTitleValidations.set(titleId, abortController);
    broadcastAppSocketEvent({
        type: TITLE_VALIDATE_SOCKET_EVENT.changed,
        titleId,
        status: 'validating',
        copies: [],
    });

    try {
        const paths =
            sourcePaths ?? (await findTitleValidationSourcePaths(title));
        abortController.signal.throwIfAborted();
        const copies: TitleValidationCopyResult[] = [];

        for (const sourcePath of paths) {
            abortController.signal.throwIfAborted();
            const readableSourcePath = await resolveReadablePath(sourcePath);
            const validation = await validateTitleCopy(
                title,
                readableSourcePath,
                abortController.signal
            );
            const verifiedTitleId = validation.titleId ?? titleId;
            const verifiedTitle = identifyTitle(verifiedTitleId);
            copies.push({
                sourcePath: readableSourcePath,
                titleId: validation.titleId,
                titleKind: verifiedTitle?.kind ?? TitleKinds.Unknown,
                titleVersion: validation.titleVersion,
                status: validation.status,
                failedCount: validation.failedFileCount,
                totalCount: validation.totalFileCount,
                error: validation.error,
            });
        }

        const event: TitleValidationSocketEvent = {
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            titleId,
            status: 'complete',
            copies,
        };

        abortController.signal.throwIfAborted();
        titleValidationResults.set(titleId, event);

        broadcastAppSocketEvent(event);
    } catch (error) {
        if (abortController.signal.aborted) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
            'server',
            `Failed to validate title ${titleId}: ${formatLogError(error)}`
        );
        broadcastAppSocketEvent({
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            titleId,
            status: 'failed',
            copies: [],
            error: message,
        });
    } finally {
        if (activeTitleValidations.get(titleId) === abortController) {
            activeTitleValidations.delete(titleId);
        }
    }
}

async function findTitleValidationSourcePaths(
    title: TitleIdentity
): Promise<string[]> {
    switch (title.platform) {
        case '3ds':
            return findThreeDSTitleSourcePaths(
                getConfig()['3dsRoots'],
                title.titleId
            );

        case 'wiiu':
            return findWiiUTitleSourcePaths(
                getConfig().wiiuRoots,
                title.titleId
            );

        case 'wii':
            return [];
    }
}

async function validateTitleCopy(
    title: TitleIdentity,
    sourcePath: string,
    signal?: AbortSignal
): Promise<{
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    failedFileCount: number;
    totalFileCount: number;
    error: string | null;
}> {
    switch (title.platform) {
        case '3ds':
            return validateThreeDSTitleCopy(title, sourcePath, signal);

        case 'wiiu':
            return validateTitleInstallFileSizes(sourcePath, signal);

        case 'wii':
            return {
                titleId: title.titleId,
                titleVersion: null,
                status: 'ok',
                failedFileCount: 0,
                totalFileCount: 0,
                error: null,
            };
    }
}

async function validateThreeDSTitleCopy(
    title: TitleIdentity,
    sourcePath: string,
    signal?: AbortSignal
): ReturnType<typeof validateTitleCopy> {
    signal?.throwIfAborted();
    const validation = await validateThreeDSTitleFile(
        sourcePath,
        title.titleId
    );
    signal?.throwIfAborted();

    return {
        titleId: validation.titleId,
        titleVersion: validation.version,
        status: validation.status,
        failedFileCount: validation.failedFileCount,
        totalFileCount: validation.totalFileCount,
        error: validation.error,
    };
}

export function revalidateTitleCopies(
    titles: Array<{ titleId: string; sourcePaths: string[] }>
): void {
    for (const title of titles) {
        const titleIdentity = identifyTitle(title.titleId);
        if (!titleIdentity) {
            logger.warn(
                'server',
                `Invalid title revalidation request: ${title.titleId}`
            );
            continue;
        }

        activeTitleValidations.get(titleIdentity.titleId)?.abort();
        titleValidationResults.delete(titleIdentity.titleId);
        void runTitleCopyValidation(titleIdentity, [
            ...new Set(title.sourcePaths),
        ]);
    }
}

export function markTitleCopiesValidating(titleIds: string[]): void {
    for (const requestedTitleId of new Set(titleIds)) {
        const title = identifyTitle(requestedTitleId);
        if (!title) {
            logger.warn(
                'server',
                `Invalid title validating marker: ${requestedTitleId}`
            );
            continue;
        }
        const { titleId } = title;

        activeTitleValidations.get(titleId)?.abort();
        titleValidationResults.delete(titleId);
        broadcastAppSocketEvent({
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            titleId,
            status: 'validating',
            copies: [],
        });
    }
}

export function abortAndClearTitleValidations(): void {
    for (const abortController of activeTitleValidations.values()) {
        abortController.abort();
    }
    activeTitleValidations.clear();
    titleValidationResults.clear();
}
