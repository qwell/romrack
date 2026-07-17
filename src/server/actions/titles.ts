import { broadcastAppSocketEvent } from '../socket.js';
import { findWiiUTitleSourcePaths } from '../platforms/wiiu.js';
import {
    identifyTitle,
    type TitleIdentity,
    TitleKinds,
} from '../../shared/titles.js';
import logger from '../../shared/logger.js';
import { resolveReadablePath } from '../../shared/os.js';
import { formatLogError } from '../../shared/utils.js';
import {
    TITLE_VALIDATE_SOCKET_COMMAND,
    TITLE_VALIDATE_SOCKET_EVENT,
    type TitleValidationSocketEvent,
    type TitleValidationCopyResult,
    type TitleValidationSocketCommand,
} from '../../shared/socket.js';
import { validateWupTitleFileSizes } from '../platforms/wiiu.js';
import {
    findThreeDSTitleSourcePaths,
    validateThreeDSTitleFile,
} from '../platforms/3ds.js';
import { getConfig } from '../routes/config.js';

const activeTitleValidations = new Map<string, AbortController>();
const titleValidationResults = new Map<string, TitleValidationSocketEvent>();

function supportsTitleValidation(title: TitleIdentity): boolean {
    switch (title.platform) {
        case '3ds':
        case 'wiiu':
            return true;
    }

    return false;
}

export function getTitleValidationResults(): TitleValidationSocketEvent[] {
    return [...titleValidationResults.values()];
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
    if (!supportsTitleValidation(title)) {
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
            return validateWupTitleFileSizes(sourcePath, signal);

        case 'wii':
            throw new Error('Wii title validation is not implemented');
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
        if (!supportsTitleValidation(titleIdentity)) {
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
