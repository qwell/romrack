import { Router } from 'express';

import {
    downloadNusBaseMetadata,
    getDlcMetadata,
    getUpdateMetadata,
} from '../title.js';
import { sendServerError } from '../routes.js';
import { broadcastAppSocketEvent } from '../socket.js';
import { requireTitleIdQuery } from '../request.js';
import { classifyTitleId, findWiiUTitleSourcePaths } from '../wiiu.js';
import { type TitleResponse } from '../../shared/api.js';
import { getConfig } from '../../shared/config.js';
import { isHttpErrorStatus } from '../../shared/download.js';
import logger from '../../shared/logger.js';
import { resolveReadablePath } from '../../shared/os.js';
import { formatLogError } from '../../shared/shared.js';
import {
    TITLE_VERIFY_SOCKET_COMMAND,
    TITLE_VERIFY_SOCKET_EVENT,
    TitleVerifySocketEvent,
    type TitleVerifyCopyResult,
    type TitleVerifySocketCommand,
} from '../../shared/socket.js';
import { validateTitleInstallFileSizes } from '../install-title.js';

const activeTitleVerifications = new Set<string>();
const titleVerificationResults = new Map<string, TitleVerifySocketEvent>();

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

export function handleTitleVerifySocketCommand(
    command: TitleVerifySocketCommand
): void {
    switch (command.type) {
        case TITLE_VERIFY_SOCKET_COMMAND.queue:
            void verifyTitleCopies(command.titleId);
            return;
    }
}

async function verifyTitleCopies(titleId: string): Promise<void> {
    const normalizedTitleId = titleId.toLowerCase();
    if (activeTitleVerifications.has(normalizedTitleId)) {
        return;
    }

    const cached = titleVerificationResults.get(normalizedTitleId);
    if (cached) {
        broadcastAppSocketEvent(cached);
        return;
    }

    activeTitleVerifications.add(normalizedTitleId);
    broadcastAppSocketEvent({
        type: TITLE_VERIFY_SOCKET_EVENT.changed,
        titleId: normalizedTitleId,
        status: 'verifying',
        copies: [],
    });

    try {
        const sourcePaths = await findWiiUTitleSourcePaths(
            getConfig().wiiuRoots,
            normalizedTitleId
        );
        const copies: TitleVerifyCopyResult[] = [];

        for (const sourcePath of sourcePaths) {
            const readableSourcePath = await resolveReadablePath(sourcePath);
            const validation =
                await validateTitleInstallFileSizes(readableSourcePath);
            const verifiedTitleId =
                validation.titleId?.toLowerCase() ?? normalizedTitleId;
            const failedCount = validation.verification.filter(
                (result) => result.status !== 'ok'
            ).length;

            copies.push({
                sourcePath: readableSourcePath,
                titleId: validation.titleId,
                titleKind: classifyTitleId(verifiedTitleId).kind,
                titleVersion: validation.titleVersion,
                status: validation.status,
                failedCount,
                totalCount: validation.verification.length,
                error: validation.error,
            });
        }

        const event: TitleVerifySocketEvent = {
            type: TITLE_VERIFY_SOCKET_EVENT.changed,
            titleId: normalizedTitleId,
            status: 'complete',
            copies,
        };

        titleVerificationResults.set(normalizedTitleId, event);

        broadcastAppSocketEvent(event);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
            'server',
            `Failed to verify title ${normalizedTitleId}: ${formatLogError(error)}`
        );
        broadcastAppSocketEvent({
            type: TITLE_VERIFY_SOCKET_EVENT.changed,
            titleId: normalizedTitleId,
            status: 'failed',
            copies: [],
            error: message,
        });
    } finally {
        activeTitleVerifications.delete(normalizedTitleId);
    }
}

export function clearTitleVerificationResult(titleId: string): void {
    titleVerificationResults.delete(titleId.toLowerCase());
}

export function clearAllTitleVerificationResults(): void {
    titleVerificationResults.clear();
}
