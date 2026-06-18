import { Router } from 'express';

import {
    downloadNusBaseMetadata,
    getDlcMetadata,
    getUpdateMetadata,
} from '../title.js';
import { requireWiiUTitleIdQuery, sendServerError } from '../request.js';
import { broadcastAppSocketEvent } from '../socket.js';
import { findWiiUTitleSourcePaths } from '../wiiu.js';
import { normalizeTitle, TitleKinds } from '../../shared/titles.js';
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
        const titleId = requireWiiUTitleIdQuery(req, res);
        if (!titleId) {
            return;
        }

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
    if (activeTitleValidations.has(titleId)) {
        return;
    }

    const cached = titleValidationResults.get(titleId);
    if (cached) {
        broadcastAppSocketEvent(cached);
        return;
    }

    await runTitleCopyValidation(titleId, null);
}

async function runTitleCopyValidation(
    normalizedTitleId: string,
    sourcePaths: string[] | null
): Promise<void> {
    const abortController = new AbortController();
    activeTitleValidations.set(normalizedTitleId, abortController);
    broadcastAppSocketEvent({
        type: TITLE_VALIDATE_SOCKET_EVENT.changed,
        titleId: normalizedTitleId,
        status: 'validating',
        copies: [],
    });

    try {
        const paths =
            sourcePaths ??
            (await findWiiUTitleSourcePaths(
                getConfig().wiiuRoots,
                normalizedTitleId
            ));
        abortController.signal.throwIfAborted();
        const copies: TitleValidationCopyResult[] = [];

        for (const sourcePath of paths) {
            abortController.signal.throwIfAborted();
            const readableSourcePath = await resolveReadablePath(sourcePath);
            const validation = await validateTitleInstallFileSizes(
                readableSourcePath,
                abortController.signal
            );
            const verifiedTitleId = validation.titleId ?? normalizedTitleId;
            copies.push({
                sourcePath: readableSourcePath,
                titleId: validation.titleId,
                titleKind:
                    normalizeTitle(verifiedTitleId)?.kind ?? TitleKinds.Unknown,
                titleVersion: validation.titleVersion,
                status: validation.status,
                failedCount: validation.failedFileCount,
                totalCount: validation.totalFileCount,
                error: validation.error,
            });
        }

        const event: TitleValidationSocketEvent = {
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            titleId: normalizedTitleId,
            status: 'complete',
            copies,
        };

        abortController.signal.throwIfAborted();
        titleValidationResults.set(normalizedTitleId, event);

        broadcastAppSocketEvent(event);
    } catch (error) {
        if (abortController.signal.aborted) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
            'server',
            `Failed to validate title ${normalizedTitleId}: ${formatLogError(error)}`
        );
        broadcastAppSocketEvent({
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            titleId: normalizedTitleId,
            status: 'failed',
            copies: [],
            error: message,
        });
    } finally {
        if (activeTitleValidations.get(normalizedTitleId) === abortController) {
            activeTitleValidations.delete(normalizedTitleId);
        }
    }
}

export function revalidateTitleCopies(
    titles: Array<{ titleId: string; sourcePaths: string[] }>
): void {
    for (const title of titles) {
        activeTitleValidations.get(title.titleId)?.abort();
        titleValidationResults.delete(title.titleId);
        void runTitleCopyValidation(title.titleId, [
            ...new Set(title.sourcePaths),
        ]);
    }
}

export function markTitleCopiesValidating(titleIds: string[]): void {
    for (const titleId of new Set(titleIds)) {
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
