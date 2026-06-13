import { Router } from 'express';

import {
    downloadNusBaseMetadata,
    getDlcMetadata,
    getUpdateMetadata,
} from '../title.js';
import { sendServerError } from '../routes.js';
import { broadcastAppSocketEvent } from '../socket.js';
import { requireTitleIdQuery } from '../request.js';
import { findWiiUTitleSourcePaths } from '../wiiu.js';
import { classifyTitleId } from '../../shared/titles.js';
import { type TitleResponse } from '../../shared/api.js';
import { getConfig } from '../../shared/config.js';
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

export function createTitleRouter(): Router {
    const router = Router();

    router.get('/', async (req, res) => {
        const titleId = requireTitleIdQuery(req, res);
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

            const response: TitleResponse = {
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
    const normalizedTitleId = titleId.toLowerCase();
    if (activeTitleValidations.has(normalizedTitleId)) {
        return;
    }

    const cached = titleValidationResults.get(normalizedTitleId);
    if (cached) {
        broadcastAppSocketEvent(cached);
        return;
    }

    await runTitleCopyValidation(normalizedTitleId, null);
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
            const verifiedTitleId =
                validation.titleId?.toLowerCase() ?? normalizedTitleId;
            copies.push({
                sourcePath: readableSourcePath,
                titleId: validation.titleId,
                titleKind: classifyTitleId(verifiedTitleId).kind,
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
        const normalizedTitleId = title.titleId.toLowerCase();
        activeTitleValidations.get(normalizedTitleId)?.abort();
        titleValidationResults.delete(normalizedTitleId);
        void runTitleCopyValidation(normalizedTitleId, [
            ...new Set(title.sourcePaths),
        ]);
    }
}

export function markTitleCopiesValidating(titleIds: string[]): void {
    for (const titleId of new Set(
        titleIds.map((value) => value.toLowerCase())
    )) {
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

export function clearAllTitleValidationResults(): void {
    titleValidationResults.clear();
}
