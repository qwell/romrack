import { Router } from 'express';

import {
    downloadNusBaseMetadata,
    getDlcMetadata,
    getUpdateMetadata,
} from '../title.js';
import { requireWiiUTitleQuery, sendServerError } from '../request.js';
import { broadcastAppSocketEvent } from '../socket.js';
import { findWiiUTitleSourcePaths } from '../wiiu.js';
import {
    identifyWiiUTitle,
    type TitleIdentity,
    TitleKinds,
} from '../../shared/titles.js';
import { type TitleLookupWiiUResponse } from '../../shared/api.js';
import { getConfig } from './config.js';
import { isHttpErrorStatus } from '../../shared/download.js';
import logger from '../../shared/logger.js';
import { resolveReadablePath } from '../../shared/os.js';
import { formatLogError } from '../../shared/shared.js';
import {
    TITLE_VALIDATE_SOCKET_COMMAND,
    TITLE_VALIDATE_SOCKET_EVENT,
    TitleValidationSocketEvent,
    type TitleValidationCopyResult,
    type TitleValidationSocketCommand,
} from '../../shared/socket.js';
import { validateTitleInstallFileSizes } from '../install-title.js';

const activeTitleValidations = new Map<string, AbortController>();
const titleValidationResults = new Map<string, TitleValidationSocketEvent>();

export function getTitleValidationResults(): TitleValidationSocketEvent[] {
    return [...titleValidationResults.values()];
}

export function createTitleLookupWiiURouter(): Router {
    const router = Router();

    router.get('/', async (req, res) => {
        const title = requireWiiUTitleQuery(req, res);
        if (!title) {
            return;
        }
        const { titleId } = title;

        try {
            const [metadata, updateMetadata, dlcMetadata] = await Promise.all([
                downloadNusBaseMetadata(titleId),
                getUpdateMetadata(titleId),
                getDlcMetadata(titleId),
            ]);

            if (!metadata && !updateMetadata.exists && !dlcMetadata.exists) {
                res.status(404).json({
                    error: 'Failed to parse title metadata',
                });
                return;
            }

            const response: TitleLookupWiiUResponse = {
                titleId: metadata?.titleId ?? titleId,
                name: metadata?.name ?? null,
                region: metadata?.region ?? null,
                productCode: metadata?.productCode ?? null,
                companyCode: metadata?.companyCode ?? null,
                baseVersions:
                    metadata?.titleVersion === null ||
                    metadata?.titleVersion === undefined
                        ? []
                        : [metadata.titleVersion],
                titleKey: metadata?.titleKey
                    ? Buffer.from(metadata.titleKey).toString('hex')
                    : null,
                titleKeyPassword: metadata?.titleKeyPassword ?? null,
                updateVersions:
                    updateMetadata.exists &&
                    updateMetadata.titleVersion !== null
                        ? [updateMetadata.titleVersion]
                        : [],
                dlcVersions:
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
            if (isHttpErrorStatus(error, 504)) {
                res.status(504).json({
                    error: 'Failed to load full title metadata',
                });
                return;
            }
            sendServerError(res, 'Failed to load full title metadata', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}

export function handleTitleValidationSocketCommand(
    command: TitleValidationSocketCommand
): void {
    switch (command.type) {
        case TITLE_VALIDATE_SOCKET_COMMAND.queue:
            void validateTitleCopies(command.titleId);
            return;
    }
}

async function validateTitleCopies(titleId: string): Promise<void> {
    const title = identifyWiiUTitle(titleId);
    if (!title) {
        logger.warn(
            'server',
            `Invalid Wii U title validation request: ${titleId}`
        );
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
            sourcePaths ??
            (await findWiiUTitleSourcePaths(getConfig().wiiuRoots, titleId));
        abortController.signal.throwIfAborted();
        const copies: TitleValidationCopyResult[] = [];

        for (const sourcePath of paths) {
            abortController.signal.throwIfAborted();
            const readableSourcePath = await resolveReadablePath(sourcePath);
            const validation = await validateTitleInstallFileSizes(
                readableSourcePath,
                abortController.signal
            );
            const verifiedTitleId = validation.titleId ?? titleId;
            const verifiedTitle = identifyWiiUTitle(verifiedTitleId);
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

export function revalidateTitleCopies(
    titles: Array<{ titleId: string; sourcePaths: string[] }>
): void {
    for (const title of titles) {
        const titleIdentity = identifyWiiUTitle(title.titleId);
        if (!titleIdentity) {
            logger.warn(
                'server',
                `Invalid Wii U title revalidation request: ${title.titleId}`
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
        const title = identifyWiiUTitle(requestedTitleId);
        if (!title) {
            logger.warn(
                'server',
                `Invalid Wii U title validating marker: ${requestedTitleId}`
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
