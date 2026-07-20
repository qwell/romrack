import { broadcastAppSocketEvent } from '../socket.js';
import { findWiiUTitleSourcePaths } from '../platforms/wiiu.js';
import {
    identifyTitle,
    getTitlePlatformKey,
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
import {
    findGameCubeTitleSourcePaths,
    validateGameCubeTitleFile,
} from '../platforms/gamecube.js';
import {
    findWiiTitleSourcePaths,
    validateWiiTitleFile,
} from '../platforms/wii.js';

const activeTitleValidations = new Map<string, AbortController>();
const titleValidationResults = new Map<string, TitleValidationSocketEvent>();

function getValidationKey(title: TitleIdentity): string {
    return getTitlePlatformKey(title.platform, title.titleId);
}

function supportsTitleValidation(title: TitleIdentity): boolean {
    switch (title.platform) {
        case '3ds':
        case 'gamecube':
        case 'wii':
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
            void validateTitleCopies(command.id, command.platform);
            return;
    }
}

async function validateTitleCopies(
    titleId: string,
    platform: TitleIdentity['platform']
): Promise<void> {
    const title = identifyTitle(titleId, platform);
    if (!title) {
        logger.warn('server', `Invalid title validation request: ${titleId}`);
        return;
    }
    if (!supportsTitleValidation(title)) {
        return;
    }

    const validationKey = getValidationKey(title);
    if (activeTitleValidations.has(validationKey)) {
        return;
    }

    const cached = titleValidationResults.get(validationKey);
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
    const validationKey = getValidationKey(title);
    const abortController = new AbortController();
    activeTitleValidations.set(validationKey, abortController);
    broadcastAppSocketEvent({
        type: TITLE_VALIDATE_SOCKET_EVENT.changed,
        platform: title.platform,
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
            const verifiedTitle = identifyTitle(
                verifiedTitleId,
                title.platform
            );
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
            platform: title.platform,
            titleId,
            status: 'complete',
            copies,
        };

        abortController.signal.throwIfAborted();
        titleValidationResults.set(validationKey, event);

        broadcastAppSocketEvent(event);
    } catch (error) {
        if (abortController.signal.aborted) {
            return;
        }
        const message = formatLogError(error);
        logger.warn(
            'server',
            `Failed to validate title ${titleId}: ${formatLogError(error)}`
        );
        broadcastAppSocketEvent({
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            platform: title.platform,
            titleId,
            status: 'failed',
            copies: [],
            error: message,
        });
    } finally {
        if (activeTitleValidations.get(validationKey) === abortController) {
            activeTitleValidations.delete(validationKey);
        }
    }
}

async function findTitleValidationSourcePaths(
    title: TitleIdentity
): Promise<string[]> {
    const config = getConfig();

    switch (title.platform) {
        case '3ds':
            return findThreeDSTitleSourcePaths(
                config['3dsRoots'],
                title.titleId
            );
        case 'wiiu':
            return findWiiUTitleSourcePaths(config.wiiuRoots, title.titleId);
        case 'gamecube':
            return findGameCubeTitleSourcePaths(
                config.gamecubeRoots,
                title.titleId
            );
        case 'wii':
            return findWiiTitleSourcePaths(config.wiiRoots, title.titleId);
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
            return validateWiiTitleFile(sourcePath, title.titleId, signal);

        case 'gamecube':
            return validateGameCubeTitleFile(sourcePath, title.titleId, signal);
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
    titles: Array<{
        platform: TitleIdentity['platform'];
        titleId: string;
        sourcePaths: string[];
    }>
): void {
    for (const title of titles) {
        const titleIdentity = identifyTitle(title.titleId, title.platform);
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

        const validationKey = getValidationKey(titleIdentity);
        activeTitleValidations.get(validationKey)?.abort();
        titleValidationResults.delete(validationKey);
        void runTitleCopyValidation(titleIdentity, [
            ...new Set(title.sourcePaths),
        ]);
    }
}

export function markTitleCopiesValidating(
    titles: Array<{ platform: TitleIdentity['platform']; titleId: string }>
): void {
    const uniqueTitles = new Map(
        titles.map((title) => [
            getTitlePlatformKey(title.platform, title.titleId),
            title,
        ])
    );
    for (const requested of uniqueTitles.values()) {
        const title = identifyTitle(requested.titleId, requested.platform);
        if (!title) {
            logger.warn(
                'server',
                `Invalid title validating marker: ${requested.titleId}`
            );
            continue;
        }
        const { titleId } = title;
        const validationKey = getValidationKey(title);

        activeTitleValidations.get(validationKey)?.abort();
        titleValidationResults.delete(validationKey);
        broadcastAppSocketEvent({
            type: TITLE_VALIDATE_SOCKET_EVENT.changed,
            platform: title.platform,
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
