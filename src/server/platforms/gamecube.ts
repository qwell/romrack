import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import logger from '../../shared/logger.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
} from '../../shared/api.js';
import { normalizeRegion } from '../../shared/regions.js';
import {
    getDiscProductCode,
    identifyGameCubeTitle,
    mergeTitleEntry,
    normalizeTitleName,
    type RawTitleDatabaseEntry,
    type TitleDatabaseEntry,
    type TitleDetails,
    type TitleGroup,
    TitleKinds,
    type TitleMediaType,
} from '../../shared/titles.js';
import { formatLogError, formatSize } from '../../shared/utils.js';
import {
    getGameTdbLocales,
    getPreferredGameTdbSynopsis,
    isGameCubeGameTdbTitle,
    readCachedGameTdbMedia,
    readGameTdbMedia,
    type GameTdbGame,
} from '../gametdb.js';
import { readCachedTitleMedia, type CachedImage } from '../image-cache.js';
import {
    GCM_DISC_HEADER_SIZE,
    inspectGameCubeDiscStructure,
    parseGcmDiscHeader,
    type GameCubeDiscCheck,
    type GcmDiscHeader,
} from '../formats/gcm.js';
import {
    cacheLocalTitleIcon,
    createEmptyTitleGroup,
    findLibraryItems,
    findTitleSourcePathsInRoots,
    getGroupStatus,
    getTitleMediaUrl,
    mergeLibraryTitleGroups,
    parseGameTdbInputControls,
    parseGameTdbNumber,
    prepareTitleVerifications,
    type PreparedTitleVerification,
    readGameTdb,
    readTitleDatabase,
    readTitleDatabaseByProductCode,
    readTitleMedia,
    scanCachedTitleEntries,
    scanTitleRoots,
    splitGameTdbList,
    throwIfLibraryVerifyCancelled,
    verifyTitleRoots,
    type LibraryCacheTitleEntry,
} from '../library.js';

const LIBRARY_SCAN_CONCURRENCY = 8;
const GAMECUBE_IMAGE_EXTENSIONS = new Set(['.iso', '.gcm']);

type GameCubeDiscInfo = {
    titleId: string;
    productCode: string;
    name: string;
    region: string | null;
    version: number;
};

function getGameCubeDiscInfo(
    header: GcmDiscHeader | null
): GameCubeDiscInfo | null {
    if (!header) {
        return null;
    }
    const productCode = getDiscProductCode(header.gameId);
    const identity = productCode ? identifyGameCubeTitle(productCode) : null;
    return identity && productCode
        ? {
              titleId: identity.titleId,
              productCode,
              name: header.name,
              region: normalizeRegion(null, header.gameId.slice(0, 4)),
              version: header.version,
          }
        : null;
}

async function readDiscInfo(
    filePath: string
): Promise<GameCubeDiscInfo | null> {
    const file = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(GCM_DISC_HEADER_SIZE);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return getGameCubeDiscInfo(
            parseGcmDiscHeader(buffer.subarray(0, bytesRead))
        );
    } finally {
        await file.close();
    }
}

async function inspectGameCubeDisc(
    filePath: string,
    signal?: AbortSignal
): Promise<{ disc: GameCubeDiscInfo | null; checks: GameCubeDiscCheck[] }> {
    signal?.throwIfAborted();
    const file = await open(filePath, 'r');
    try {
        const fileSize = (await file.stat()).size;
        const inspection = await inspectGameCubeDiscStructure(
            {
                async read(position, length) {
                    const buffer = Buffer.alloc(length);
                    const { bytesRead } = await file.read(
                        buffer,
                        0,
                        length,
                        position
                    );
                    return buffer.subarray(0, bytesRead);
                },
                close: async () => undefined,
            },
            fileSize,
            signal
        );
        return {
            disc: getGameCubeDiscInfo(inspection.header),
            checks: inspection.checks,
        };
    } finally {
        await file.close();
    }
}

export async function validateGameCubeTitleFile(
    filePath: string,
    expectedTitleId: string,
    signal?: AbortSignal
): Promise<{
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    failedFileCount: number;
    totalFileCount: number;
    error: string | null;
}> {
    const { disc, checks } = await inspectGameCubeDisc(filePath, signal);
    if (disc) {
        checks.push({
            ok: disc.titleId === expectedTitleId,
            message: `expected ${expectedTitleId}, found ${disc.titleId}`,
        });
    }
    const failed = checks.filter((check) => !check.ok);
    return {
        titleId: disc?.titleId ?? null,
        titleVersion: disc?.version ?? null,
        status: failed.length === 0 ? 'ok' : 'failed',
        failedFileCount: failed.length,
        totalFileCount: checks.length,
        error: failed[0]?.message ?? null,
    };
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const database = JSON.parse(jsonText) as Record<string, unknown>;
    const json = database.gamecube as RawTitleDatabaseEntry[];
    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain a gamecube array');
    }

    return json
        .map((entry): TitleDatabaseEntry | null => {
            const productCode = getDiscProductCode(entry.productCode);
            const title = identifyGameCubeTitle(
                entry.titleId ?? productCode ?? ''
            );
            if (!title) {
                return null;
            }

            const resolvedProductCode = productCode ?? title.titleId;
            const region =
                normalizeRegion(null, resolvedProductCode) ||
                normalizeRegion(entry.region, null);

            return {
                platform: title.platform,
                titleId: title.titleId,
                name: normalizeTitleName(entry.name),
                region,
                companyCode: entry.companyCode?.length
                    ? entry.companyCode
                    : null,
                productCode: resolvedProductCode,
                iconUrl: entry.iconUrl,
                bannerUrl: entry.bannerUrl ?? null,

                baseVersions: [],
                updateVersions: [],
                dlcVersions: [],

                family: title.family,
                availableOnCdn: false,
            };
        })
        .filter((entry): entry is TitleDatabaseEntry => entry !== null);
}

async function readGameCubeTitleDatabase(): Promise<
    Map<string, TitleDatabaseEntry>
> {
    return readTitleDatabase({
        logNamespace: 'gamecube',
        required: true,
        parseEntries: parseTitleDatabaseEntries,
    });
}

function parseGameTdbDetails(game: GameTdbGame): TitleDetails {
    return {
        tvFormat: game.region ?? null,
        languages: splitGameTdbList(game.languages),
        synopsis: getPreferredGameTdbSynopsis(getGameTdbLocales(game)),
        developer: game.developer?.trim() || null,
        genre: splitGameTdbList(game.genre),
        inputPlayers: parseGameTdbNumber(game.input?.['@players']),
        inputControls: parseGameTdbInputControls(game),
        sizeBytes: parseGameTdbNumber(game.rom?.['@size']),
    };
}

async function readGameCubeGameTdb(): Promise<Map<string, TitleDetails>> {
    return readGameTdb<GameTdbGame>({
        fileName: 'wii/tdb.xml',
        logNamespace: 'gamecube',
        includeGame: isGameCubeGameTdbTitle,
        getId: (game) => getDiscProductCode(game.id) ?? null,
        parseDetails: parseGameTdbDetails,
    });
}

async function findGameCubeFiles(root: string): Promise<string[]> {
    return findLibraryItems(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'gamecube',
        platform: 'gamecube',
        includeFile: (entry) =>
            GAMECUBE_IMAGE_EXTENSIONS.has(
                path.extname(entry.name).toLowerCase()
            ),
    });
}

async function readTitleEntry(
    root: string,
    relativePath: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry | null> {
    const sourcePath = path.join(root, relativePath);
    let disc: GameCubeDiscInfo | null = null;
    try {
        disc = await readDiscInfo(sourcePath);
    } catch (error) {
        logger.warn(
            'gamecube',
            `failed to read GameCube disc metadata from ${sourcePath}: ${formatLogError(error)}`
        );
    }
    if (!disc) {
        logger.warn('gamecube', `skipping non-GameCube image: ${sourcePath}`);
        return null;
    }

    const databaseEntry = titleDatabase.get(disc.titleId) ?? null;
    const productCode = databaseEntry?.productCode ?? disc.productCode;
    const iconUrl = await cacheLocalTitleIcon(
        'gamecube',
        productCode,
        sourcePath
    );
    const file = await stat(sourcePath);
    return {
        platform: 'gamecube',
        titleId: disc.titleId,
        name: databaseEntry?.name ?? disc.name,
        region: databaseEntry?.region ?? disc.region,
        iconUrl:
            iconUrl ??
            (databaseEntry
                ? getTitleMediaUrl('icons', 'gamecube', productCode)
                : null),
        bannerUrl: databaseEntry
            ? getTitleMediaUrl('covers', 'gamecube', productCode)
            : null,
        version: disc.version,
        kind: TitleKinds.Base,
        sizeBytes: file.size,
        copyCount: 1,
        family: disc.titleId,
        productCode,
        sourcePath,
    };
}

async function scanGameCubeTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb] = await Promise.all([
        readGameCubeTitleDatabase(),
        readGameCubeGameTdb(),
    ]);
    const entries = await scanCachedTitleEntries(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'gamecube',
        findItems: findGameCubeFiles,
        readEntry: readTitleEntry,
        context: titleDatabase,
    });
    const groups = new Map<string, TitleGroup>();
    for (const entry of entries) {
        let group = groups.get(entry.family);
        if (!group) {
            group = createEmptyTitleGroup(
                'gamecube',
                entry.family,
                entry.name,
                entry.region
            );
            groups.set(entry.family, group);
        }
        mergeTitleEntry(group.entries, entry);
    }

    for (const [family, databaseEntry] of titleDatabase) {
        if (!groups.has(family)) {
            groups.set(
                family,
                createEmptyTitleGroup(
                    'gamecube',
                    family,
                    databaseEntry.name,
                    databaseEntry.region
                )
            );
        }
    }

    for (const group of groups.values()) {
        const entry = titleDatabase.get(group.family) ?? null;
        const parentEntry = group.entries.find(
            (candidate) => candidate.kind === TitleKinds.Base
        );
        const productCode =
            entry?.productCode ??
            getDiscProductCode(parentEntry?.titleId) ??
            null;
        const iconUrl = productCode
            ? getTitleMediaUrl('icons', 'gamecube', productCode)
            : null;
        const bannerUrl = productCode
            ? getTitleMediaUrl('covers', 'gamecube', productCode)
            : null;

        group.productCode = productCode;
        group.details = productCode ? (gameTdb.get(productCode) ?? null) : null;
        group.titleInDatabase = entry !== null;
        group.expectedChildren = [];
        group.status = getGroupStatus(group);

        if (parentEntry) {
            group.name = parentEntry.name;
            group.region = parentEntry.region;
            group.iconUrl = iconUrl ?? parentEntry.iconUrl;
            group.bannerUrl = bannerUrl ?? parentEntry.bannerUrl;
        } else if (entry) {
            group.name = entry.name;
            group.region = entry.region;
            group.iconUrl = iconUrl;
            group.bannerUrl = bannerUrl;
        }
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanGameCubeTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    return scanTitleRoots(roots, {
        platform: 'gamecube',
        logNamespace: 'gamecube',
        scanTitles: scanGameCubeTitles,
        mergeTitleGroups: mergeLibraryTitleGroups,
        resultLabel: 'disc image group(s)',
    });
}

async function verifyGameCubeTitles(
    root: string,
    onProgress?: (progress: LibraryVerifyProgress) => void,
    options: {
        directories?: string[];
        offset?: number;
        total?: number;
        signal?: AbortSignal;
    } = {}
): Promise<LibraryVerifyTitle[]> {
    const files = options.directories ?? (await findGameCubeFiles(root));
    const offset = options.offset ?? 0;
    const total = options.total ?? files.length;
    const results: LibraryVerifyTitle[] = [];

    for (const [index, relativePath] of files.entries()) {
        throwIfLibraryVerifyCancelled(options.signal);
        const sourcePath = path.join(root, relativePath);
        const sizeBytes = (await stat(sourcePath)).size;
        const inspection = await inspectGameCubeDisc(
            sourcePath,
            options.signal
        ).catch(() => ({ disc: null, checks: [] as GameCubeDiscCheck[] }));
        const { disc } = inspection;
        const failed = inspection.checks.filter((check) => !check.ok);
        const titleId = disc?.titleId ?? 'unknown';
        const name = disc?.name ?? relativePath;
        const version = disc?.version ?? null;
        onProgress?.({
            platform: 'gamecube',
            titleId,
            name,
            kind: TitleKinds.Base,
            version,
            current: offset + index,
            total,
        });
        const status = disc && failed.length === 0 ? 'ok' : 'failed';
        const error = failed[0]?.message ?? (disc ? null : 'Unreadable image');
        onProgress?.({
            platform: 'gamecube',
            titleId,
            name,
            kind: TitleKinds.Base,
            version,
            result: status,
            error,
            current: offset + index + 1,
            total,
        });
        results.push({
            platform: 'gamecube',
            root,
            directory: relativePath,
            name,
            titleId: disc?.titleId ?? null,
            version,
            kind: TitleKinds.Base,
            sizeText: formatSize(sizeBytes),
            status,
            error,
            verification: inspection.checks.map((check) => ({
                path: relativePath,
                status: check.ok ? 'ok' : 'failed',
                error: check.ok ? null : check.message,
            })),
        });
    }
    return results;
}

export async function verifyGameCubeTitleRoots(
    roots: string[],
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyTitleRoots({
        roots,
        onProgress,
        signal,
        platform: 'gamecube',
        logNamespace: 'gamecube',
        findItems: findGameCubeFiles,
        verifyTitles: verifyGameCubeTitles,
    });
}

export function prepareGameCubeTitleVerifications(
    roots: string[],
    signal?: AbortSignal
): Promise<PreparedTitleVerification[]> {
    return prepareTitleVerifications({
        roots,
        signal,
        platform: 'gamecube',
        logNamespace: 'gamecube',
        findItems: findGameCubeFiles,
    });
}

export function verifyPreparedGameCubeTitle(
    item: PreparedTitleVerification,
    index: number,
    total: number,
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyGameCubeTitles(item.root, onProgress, {
        directories: [item.directory],
        offset: index,
        total,
        signal,
    });
}

export async function findGameCubeTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        async (root) => {
            const titleDatabase = await readGameCubeTitleDatabase();
            return scanCachedTitleEntries(root, {
                concurrency: LIBRARY_SCAN_CONCURRENCY,
                logNamespace: 'gamecube',
                findItems: findGameCubeFiles,
                readEntry: readTitleEntry,
                context: titleDatabase,
            });
        },
        'gamecube',
        'gamecube'
    );
}

export async function readGameCubeTitleIdentity(
    sourcePath: string
): Promise<{ titleId: string; version: number; kind: TitleKinds } | null> {
    const { disc, checks } = await inspectGameCubeDisc(sourcePath);
    return disc && checks.every((check) => check.ok)
        ? {
              titleId: disc.titleId,
              version: disc.version,
              kind: TitleKinds.Base,
          }
        : null;
}

export async function readGameCubeTitleMedia(
    type: TitleMediaType,
    platform: 'gamecube',
    productCode: string
): Promise<CachedImage | null> {
    const normalized = getDiscProductCode(productCode);
    if (!normalized) {
        return null;
    }
    const cached =
        type === 'icons'
            ? await readCachedTitleMedia(type, platform, normalized)
            : null;
    if (cached) {
        return cached;
    }
    const gameTdbMedia = await readCachedGameTdbMedia(
        type,
        platform,
        normalized
    );
    if (gameTdbMedia) {
        return gameTdbMedia;
    }
    const database = await readTitleDatabaseByProductCode(
        readGameCubeTitleDatabase
    );
    return readTitleMedia({
        type,
        platform,
        productCode: normalized,
        readEntry: (code) => database.get(code) ?? null,
        getUrl: (mediaType, entry) =>
            mediaType === 'icons'
                ? (entry?.iconUrl ?? null)
                : (entry?.bannerUrl ?? null),
        fallback: (mediaType, mediaPlatform, code, entry) =>
            entry
                ? readGameTdbMedia(mediaType, mediaPlatform, code, {
                      region: entry.region,
                      name: entry.name,
                  })
                : null,
    });
}
