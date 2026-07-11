import { stat } from 'node:fs/promises';
import path from 'node:path';

import { normalizeRegion } from '../shared/regions.js';
import {
    formatLogError,
    formatSize,
    formatTitleDisplay,
} from '../shared/utils.js';
import {
    getWiiProductCode,
    identifyWiiTitle,
    mergeTitleEntry,
    normalizeTitleName,
    type RawTitleDatabaseEntry,
    type TitleDatabaseEntry,
    type TitleDetails,
    TitleKinds,
    type TitleGroup,
    type TitleMediaType,
    TitlePlatform,
} from '../shared/titles.js';
import logger from '../shared/logger.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
} from '../shared/api.js';
import { ansi } from '../shared/ansi.js';
import {
    getGameTdbLocales,
    getPreferredGameTdbSynopsis,
    type GameTdbGame,
    readGameTdbMedia,
} from './gametdb.js';
import { readCachedTitleMedia, type CachedImage } from './image-cache.js';
import {
    type DiscHeaderLocation,
    readDiscHeaderText,
    readIsoDiscHeader,
} from './formats/disc.js';
import {
    getWbfsDiscFilePaths,
    isWbfsSplitPart,
    readWbfsDiscHeader,
    verifyWiiDisc,
} from './formats/wbfs.js';
import {
    cacheLocalTitleIcon,
    createEmptyTitleGroup,
    findFirstReadableTitleRoot,
    findLibraryItems,
    findTitleSourcePathsInRoots,
    getGroupStatus,
    getTitleMediaUrl,
    type LibraryCacheTitleEntry,
    mergeLibraryTitleGroups,
    parseGameTdbInputControls,
    parseGameTdbNumber,
    readGameTdb,
    readTitleDatabase,
    readTitleDatabaseByProductCode,
    readTitleMedia,
    scanCachedTitleEntries,
    scanTitleRoots,
    splitGameTdbList,
    throwIfLibraryVerifyCancelled,
    verifyTitleRoots,
} from './library.js';

const LIBRARY_SCAN_CONCURRENCY = 8;
const WII_DISC_IMAGE_EXTENSIONS = new Set(['.iso', '.wbfs']);
const WII_DISC_TITLE_ID_OFFSET = 0x00; // [0] = systemType, [1-2] = titleId, [3] = region
const WII_DISC_TITLE_ID_LENGTH = 0x04;
const WII_DISC_VERSION_OFFSET = 0x07;
const WII_DISC_MAGIC_OFFSET = 0x18;
const WII_DISC_MAGIC = 0x5d1c9ea3;
const WII_DISC_TITLE_NAME_OFFSET = 0x20;
const WII_DISC_TITLE_NAME_LENGTH = 64;
const WII_DISC_TITLE_NAME_ENCODING = 'shift-jis';
const WII_DISC_HEADER_LOCATION: DiscHeaderLocation = {
    position: 0,
    length: WII_DISC_TITLE_NAME_OFFSET + WII_DISC_TITLE_NAME_LENGTH,
};

const WII_SYSTEM_CODES = 'CDEFGHJLMNPQRSWX';
const WII_REGION_CODES = 'ABCDEFIJKLMNPQSTUWX';

const WII_GAME_ID_PATTERN = new RegExp(
    `^[${WII_SYSTEM_CODES}][A-Z0-9]{2}[${WII_REGION_CODES}]$`
);

type DiscHeaderInfo = {
    titleId: string | null;
    name: string | null;
    region: string | null;
    version: number | null;
};

async function scanWiiTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb] = await Promise.all([
        readWiiTitleDatabase(),
        readWiiGameTdb(),
    ]);
    const groups = new Map<string, TitleGroup>();
    const scanned = await scanTitleEntries(root, titleDatabase);

    for (const entry of scanned) {
        let group = groups.get(entry.family);

        if (!group) {
            group = createGroup(entry.family, entry);
            groups.set(entry.family, group);
        }

        mergeTitleEntry(group.entries, entry);
    }

    for (const family of titleDatabase.keys()) {
        if (!groups.has(family)) {
            groups.set(family, createGroup(family));
        }
    }

    for (const group of groups.values()) {
        const databaseEntry = titleDatabase.get(group.family) ?? null;
        const parentEntry = group.entries.find(
            (entry) => entry.kind === TitleKinds.Base
        );
        const productCode = databaseEntry?.productCode ?? group.family;
        const titleUrls = getTitleMediaUrls(databaseEntry);
        const gameTdbDetails = gameTdb.get(productCode) ?? null;
        const gameTdbRegion = normalizeRegion(
            gameTdbDetails?.tvFormat ?? null,
            null
        );

        group.productCode = productCode;
        group.titleInDatabase = databaseEntry !== null;
        group.details = gameTdbDetails;
        group.expectedChildren = [];
        group.status = getGroupStatus(group);

        if (parentEntry) {
            group.name = parentEntry.name;
            group.region = parentEntry.region || gameTdbRegion;
            group.iconUrl = titleUrls.iconUrl ?? parentEntry.iconUrl;
            group.bannerUrl = titleUrls.bannerUrl ?? parentEntry.bannerUrl;
        } else if (databaseEntry) {
            group.name = databaseEntry.name;
            group.region = databaseEntry.region || gameTdbRegion;
            group.iconUrl = titleUrls.iconUrl;
            group.bannerUrl = titleUrls.bannerUrl;
        }
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanWiiTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    return scanTitleRoots(roots, {
        platformLabel: 'Wii',
        logNamespace: 'wii',
        scanTitles: scanWiiTitles,
        mergeTitleGroups,
        resultLabel: 'disc image group(s)',
    });
}

async function verifyWiiTitles(
    root: string,
    onProgress?: (progress: LibraryVerifyProgress) => void,
    options: {
        directories?: string[];
        offset?: number;
        total?: number;
        signal?: AbortSignal;
    } = {}
): Promise<LibraryVerifyTitle[]> {
    const directories = options.directories ?? (await findTitleDirs(root));
    const verifications: LibraryVerifyTitle[] = [];
    const offset = options.offset ?? 0;
    const total = options.total ?? directories.length;

    const cachedEntries = await scanTitleEntries(
        root,
        await readWiiTitleDatabase()
    );
    const entriesByDirectory = new Map(
        cachedEntries.map((entry) => [
            path.relative(root, entry.sourcePath),
            entry,
        ])
    );

    for (const [index, directory] of directories.entries()) {
        throwIfLibraryVerifyCancelled(options.signal);

        const filePath = path.join(root, directory);
        const titleEntry = entriesByDirectory.get(directory) ?? null;
        const sizeBytes =
            titleEntry?.sizeBytes ??
            (await getDiscSizeBytes(await getDiscFilePaths(filePath)));
        const titleId = titleEntry?.titleId ?? 'unknown';
        const titleName = titleEntry?.name ?? directory;
        const titleKind = titleEntry?.kind ?? TitleKinds.Base;
        const titleVersion = titleEntry?.version ?? null;
        const sizeText = formatSize(sizeBytes);

        onProgress?.({
            titleId,
            name: titleName,
            kind: titleKind,
            version: titleVersion,
            current: offset + index,
            total,
        });

        logger.log(
            'wii',
            `verifying title: ${formatTitleDisplay(
                titleName,
                titleId,
                titleVersion
            )} (${sizeText})`
        );

        const verification = await verifyDiscImage(
            filePath,
            (progress) => {
                onProgress?.({
                    titleId,
                    name: titleName,
                    kind: titleKind,
                    version: titleVersion,
                    currentFileName: progress.currentFileName,
                    currentFileSizeBytes: progress.currentFileSizeBytes,
                    current: offset + index,
                    total,
                });
            },
            options.signal
        );
        throwIfLibraryVerifyCancelled(options.signal);

        const result = verification.status === 'ok' ? 'ok' : 'failed';
        const status =
            verification.status === 'failed'
                ? `${ansi.red}failed${ansi.reset}`
                : `${ansi.green}${verification.status}${ansi.reset}`;

        logger.log(
            'wii',
            `verified title:  ${formatTitleDisplay(
                titleName,
                titleId,
                titleVersion
            )} (${status})`
        );

        onProgress?.({
            titleId,
            name: titleName,
            kind: titleKind,
            version: titleVersion,
            result,
            error: verification.error,
            current: offset + index + 1,
            total,
        });

        verifications.push({
            root,
            directory,
            name: titleName,
            titleId,
            version: titleVersion,
            kind: titleKind,
            sizeText,
            status: verification.status,
            error: verification.error,
            verification: verification.verification,
        });
    }

    return verifications;
}

export async function verifyWiiTitleRoots(
    roots: string[],
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyTitleRoots({
        roots,
        onProgress,
        signal,
        platformLabel: 'Wii',
        logNamespace: 'wii',
        findItems: findTitleDirs,
        verifyTitles: verifyWiiTitles,
    });
}

export async function readWiiTitleIdentity(
    titlePath: string
): Promise<{ titleId: string; version: number; kind: TitleKinds } | null> {
    const discInfo = await readDiscInfo(titlePath);
    if (!discInfo?.titleId) {
        return null;
    }

    return {
        titleId: discInfo.titleId,
        version: discInfo.version ?? 0,
        kind: TitleKinds.Base,
    };
}

export async function readWiiTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    const normalizedProductCode = getWiiProductCode(productCode);
    if (!normalizedProductCode) {
        return null;
    }

    const titleDatabase =
        await readTitleDatabaseByProductCode(readWiiTitleDatabase);

    return readTitleMedia({
        type,
        platform,
        productCode: normalizedProductCode,
        readEntry: (productCode) => titleDatabase.get(productCode) ?? null,
        getUrl: (type, entry) => {
            switch (type) {
                case 'icons':
                    return entry?.iconUrl ?? null;
                case 'covers':
                    return entry?.bannerUrl ?? null;
            }
        },
        fallback: async (type, platform, productCode, entry) => {
            switch (type) {
                case 'icons':
                    return (
                        (await readCachedTitleMedia(
                            type,
                            platform,
                            productCode
                        )) ??
                        (entry
                            ? readGameTdbMedia('icons', platform, productCode, {
                                  region: entry.region,
                                  name: entry.name,
                              })
                            : null)
                    );
                case 'covers':
                    return entry
                        ? readGameTdbMedia(type, platform, productCode, {
                              region: entry.region,
                              name: entry.name,
                          })
                        : null;
            }
        },
        logLabel: 'Wii',
    });
}

export async function findWiiTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        scanTitleEntriesWithDatabase,
        'wii',
        'Wii'
    );
}

export async function findFirstReadableWiiRoot(
    roots: string[]
): Promise<string> {
    return findFirstReadableTitleRoot(roots, 'Wii');
}

function createGroup(
    family: string,
    entry?: LibraryCacheTitleEntry
): TitleGroup {
    const productCode = entry?.titleId ?? family;

    return {
        ...createEmptyTitleGroup(
            'wii',
            family,
            entry?.name ?? 'Unknown',
            entry?.region ?? null
        ),
        productCode,
        iconUrl: null,
        bannerUrl: null,
        titleInDatabase: false,
        status: 'complete',
    };
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const json = JSON.parse(jsonText) as RawTitleDatabaseEntry[];

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain an array');
    }

    return json
        .map((entry): TitleDatabaseEntry | null => {
            const title = identifyWiiTitle(entry.titleId);
            if (!title) {
                return null;
            }

            const productCode =
                getWiiProductCode(entry.productCode) ?? title.titleId;
            const region =
                normalizeRegion(null, productCode) ||
                normalizeRegion(entry.region, null);

            return {
                platform: title.platform,
                titleId: title.titleId,
                name: normalizeTitleName(entry.name),
                region,
                companyCode: entry.companyCode?.length
                    ? entry.companyCode
                    : null,
                productCode,
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

async function readWiiTitleDatabase(): Promise<
    Map<string, TitleDatabaseEntry>
> {
    return readTitleDatabase({
        logNamespace: 'wii',
        required: true,
        parseEntries: parseTitleDatabaseEntries,
    });
}

async function readWiiGameTdb(): Promise<Map<string, TitleDetails>> {
    return readGameTdb<GameTdbGame>({
        fileName: 'wii/tdb.xml',
        logNamespace: 'wii',
        getId: (game) => (game.id ?? '').slice(0, 4).toUpperCase() || null,
        parseDetails: parseGameTdbDetails,
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

function getTitleMediaUrls(entry: TitleDatabaseEntry | null): {
    iconUrl: string | null;
    bannerUrl: string | null;
} {
    if (!entry?.productCode) {
        return {
            iconUrl: null,
            bannerUrl: null,
        };
    }

    return {
        iconUrl: getTitleMediaUrl('icons', 'wii', entry.productCode),
        bannerUrl: getTitleMediaUrl('covers', 'wii', entry.productCode),
    };
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    return mergeLibraryTitleGroups(groups);
}

async function findTitleDirs(root: string): Promise<string[]> {
    return findLibraryItems(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'wii',
        logLabel: 'Wii',
        includeFile: (entry) =>
            WII_DISC_IMAGE_EXTENSIONS.has(
                path.extname(entry.name).toLowerCase()
            ) && !isWbfsSplitPart(entry.name),
    });
}

async function readTitleEntry(
    root: string,
    dirname: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry | null> {
    const filePath = path.join(root, dirname);
    let discInfo: DiscHeaderInfo | null = null;
    try {
        discInfo = await readDiscInfo(filePath);
    } catch (error) {
        logger.warn(
            'wii',
            `failed to read Wii disc metadata from ${filePath}: ${formatLogError(error)}`
        );
    }

    const titleId = discInfo?.titleId ?? null;
    const name = discInfo?.name ?? null;
    if (!titleId || !name) {
        logger.warn(
            'wii',
            `skipping Wii disc image with missing metadata: ${filePath}`
        );
        return null;
    }

    const filePaths = await getDiscFilePaths(filePath);
    const databaseEntry = titleDatabase.get(titleId) ?? null;
    const productCode = databaseEntry?.productCode ?? titleId;
    const titleUrls = getTitleMediaUrls(databaseEntry);
    const sidecarIconUrl = await cacheLocalTitleIcon(
        'wii',
        productCode,
        filePath
    );

    return {
        platform: 'wii',
        titleId,
        name: databaseEntry?.name ?? name,
        region: databaseEntry?.region ?? discInfo?.region ?? null,
        iconUrl: sidecarIconUrl ?? titleUrls.iconUrl,
        bannerUrl: titleUrls.bannerUrl,
        version: discInfo?.version ?? null,
        kind: TitleKinds.Base,
        sizeBytes: await getDiscSizeBytes(filePaths),
        copyCount: 1,
        family: titleId,
        sourcePath: filePath,
        extraSourcePaths: filePaths.slice(1),
    };
}

async function scanTitleEntries(
    root: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry[]> {
    return scanCachedTitleEntries(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'wii',
        findItems: findTitleDirs,
        readEntry: readTitleEntry,
        context: titleDatabase,
    });
}

async function scanTitleEntriesWithDatabase(
    root: string
): Promise<LibraryCacheTitleEntry[]> {
    return scanTitleEntries(root, await readWiiTitleDatabase());
}

type DiscImageVerifyProgress = {
    currentFileName: string | null;
    currentFileSizeBytes: number | null;
};

type DiscImageVerifyResult = {
    status: 'ok' | 'failed';
    error: string | null;
    verification: unknown[];
};

function getDiscRegion(gameId: string | null): string | null {
    const regionCode = gameId?.[3]?.toUpperCase();
    switch (regionCode) {
        case 'E':
            return 'USA';
        case 'J':
            return 'JPN';
        case 'P':
        case 'D':
        case 'F':
        case 'H':
        case 'I':
        case 'S':
        case 'U':
        case 'X':
        case 'Y':
            return 'EUR';
        default:
            return null;
    }
}

function parseDiscHeader(buffer: Buffer): DiscHeaderInfo | null {
    if (buffer.length < WII_DISC_HEADER_LOCATION.length) {
        return null;
    }

    if (buffer.readUInt32BE(WII_DISC_MAGIC_OFFSET) !== WII_DISC_MAGIC) {
        return null;
    }

    const headerGameId = buffer
        .subarray(
            WII_DISC_TITLE_ID_OFFSET,
            WII_DISC_TITLE_ID_OFFSET + WII_DISC_TITLE_ID_LENGTH
        )
        .toString('ascii')
        .toUpperCase();

    const gameId = WII_GAME_ID_PATTERN.test(headerGameId) ? headerGameId : null;

    const titleIdentity = gameId ? identifyWiiTitle(gameId) : null;
    const titleId = titleIdentity?.titleId ?? null;
    const region = getDiscRegion(gameId);

    const version = buffer[WII_DISC_VERSION_OFFSET];

    const name = readDiscHeaderText(
        buffer.subarray(
            WII_DISC_TITLE_NAME_OFFSET,
            WII_DISC_TITLE_NAME_OFFSET + WII_DISC_TITLE_NAME_LENGTH
        ),
        WII_DISC_TITLE_NAME_ENCODING
    );

    return {
        titleId,
        name,
        region,
        version,
    };
}

async function readIsoDiscInfo(
    filePath: string
): Promise<DiscHeaderInfo | null> {
    const discHeader = await readIsoDiscHeader(
        filePath,
        WII_DISC_HEADER_LOCATION
    );

    return discHeader === null ? null : parseDiscHeader(discHeader);
}

async function readWbfsDiscInfo(
    filePath: string
): Promise<DiscHeaderInfo | null> {
    const discHeader = await readWbfsDiscHeader(
        filePath,
        WII_DISC_HEADER_LOCATION
    );

    return discHeader === null ? null : parseDiscHeader(discHeader);
}

async function readDiscInfo(filePath: string): Promise<DiscHeaderInfo | null> {
    return path.extname(filePath).toLowerCase() === '.iso'
        ? readIsoDiscInfo(filePath)
        : readWbfsDiscInfo(filePath);
}

async function getDiscFilePaths(filePath: string): Promise<string[]> {
    return path.extname(filePath).toLowerCase() === '.iso'
        ? [filePath]
        : getWbfsDiscFilePaths(filePath);
}

async function getDiscSizeBytes(filePaths: string[]): Promise<number> {
    const sizes = await Promise.all(
        filePaths.map(async (filePath) => (await stat(filePath)).size)
    );
    return sizes.reduce((total, sizeBytes) => total + sizeBytes, 0);
}

async function verifyDiscImage(
    filePath: string,
    onProgress?: (progress: DiscImageVerifyProgress) => void,
    signal?: AbortSignal
): Promise<DiscImageVerifyResult> {
    throwIfLibraryVerifyCancelled(signal);

    onProgress?.({
        currentFileName: path.basename(filePath),
        currentFileSizeBytes: (await stat(filePath)).size,
    });

    try {
        const discInfo = await readDiscInfo(filePath);
        if (!discInfo?.titleId || !discInfo.name) {
            return {
                status: 'failed',
                error: 'Missing Wii disc metadata',
                verification: [],
            };
        }

        return await verifyWiiDisc(filePath, signal);
    } catch (error) {
        return {
            status: 'failed',
            error: formatLogError(error),
            verification: [],
        };
    }
}
