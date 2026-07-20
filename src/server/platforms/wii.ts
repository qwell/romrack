import { open, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { normalizeRegion } from '../../shared/regions.js';
import { formatLogError, formatSize } from '../../shared/utils.js';
import {
    getDiscProductCode,
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
} from '../../shared/titles.js';
import logger from '../../shared/logger.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
} from '../../shared/api.js';
import {
    getGameTdbLocales,
    getPreferredGameTdbSynopsis,
    isGameCubeGameTdbTitle,
    type GameTdbGame,
    readCachedGameTdbMedia,
    readGameTdbMedia,
} from '../gametdb.js';
import { readCachedTitleMedia, type CachedImage } from '../image-cache.js';
import { inspectWiiDiscStructure, verifyWiiDisc } from '../formats/disc.js';
import { type RandomAccessReader } from '../formats/reader.js';
import { readWbfsHeader } from '../formats/wbfs.js';
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
} from '../library.js';

const LIBRARY_SCAN_CONCURRENCY = 8;
const WII_DISC_IMAGE_EXTENSIONS = new Set(['.iso', '.wbfs']);
type WiiDiscReader = RandomAccessReader & { sparse: boolean };
const WII_COMMON_KEYS = [
    Buffer.from('6+QqIl6Fk+RI2cVFc4Gq9w==', 'base64'),
    Buffer.from('Y7grtPRhTi4T8v77ukybfg==', 'base64'),
];
const WII_DISC_TITLE_ID_OFFSET = 0x00; // [0] = systemType, [1-2] = titleId, [3] = region
const WII_DISC_TITLE_ID_LENGTH = 0x06;
const WII_DISC_VERSION_OFFSET = 0x07;
const WII_DISC_MAGIC_OFFSET = 0x18;
const WII_DISC_MAGIC = 0x5d1c9ea3;
const WII_DISC_TITLE_NAME_OFFSET = 0x20;
const WII_DISC_TITLE_NAME_LENGTH = 64;
const WII_DISC_TITLE_NAME_ENCODING = 'shift-jis';
const WII_DISC_HEADER_LOCATION = {
    position: 0,
    length: WII_DISC_TITLE_NAME_OFFSET + WII_DISC_TITLE_NAME_LENGTH,
};
const WBFS_HEADER_SIZE = 0x0c;
const WBFS_SPLIT_PART_PATTERN = /^\.wbf([1-9][0-9]*)$/i;
const WII_MAX_DISC_SIZE = 0x230480000;

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

type WbfsPart = {
    file: FileHandle;
    size: number;
    start: number;
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
        platform: 'wii',
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
            platform: 'wii',
            titleId,
            name: titleName,
            kind: titleKind,
            version: titleVersion,
            current: offset + index,
            total,
        });

        const verification = await verifyDiscImage(
            filePath,
            (progress) => {
                onProgress?.({
                    platform: 'wii',
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
        onProgress?.({
            platform: 'wii',
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
            platform: 'wii',
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
        platform: 'wii',
        logNamespace: 'wii',
        findItems: findTitleDirs,
        verifyTitles: verifyWiiTitles,
    });
}

export function prepareWiiTitleVerifications(
    roots: string[],
    signal?: AbortSignal
): Promise<PreparedTitleVerification[]> {
    return prepareTitleVerifications({
        roots,
        signal,
        platform: 'wii',
        logNamespace: 'wii',
        findItems: findTitleDirs,
    });
}

export function verifyPreparedWiiTitle(
    item: PreparedTitleVerification,
    index: number,
    total: number,
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyWiiTitles(item.root, onProgress, {
        directories: [item.directory],
        offset: index,
        total,
        signal,
    });
}

export async function validateWiiTitleFile(
    titlePath: string,
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
    let reader: WiiDiscReader | null = null;
    try {
        signal?.throwIfAborted();
        reader = await openWiiDisc(titlePath);
        const discInfo = await readDiscInfoFromReader(reader);
        const metadataValid = Boolean(discInfo?.titleId && discInfo.name);
        const identityValid = discInfo?.titleId === expectedTitleId;
        const structureChecks = await inspectWiiDiscStructure(reader, signal);
        const failedStructure = structureChecks.filter((check) => !check.ok);
        const failedFileCount =
            (metadataValid ? 0 : 1) +
            (identityValid ? 0 : 1) +
            failedStructure.length;
        const error = !metadataValid
            ? 'Missing Wii disc metadata'
            : !identityValid
              ? `Expected ${expectedTitleId}, found ${discInfo?.titleId ?? 'unknown'}`
              : (failedStructure[0]?.message ?? null);

        return {
            titleId: discInfo?.titleId ?? null,
            titleVersion: discInfo?.version ?? null,
            status: failedFileCount === 0 ? 'ok' : 'failed',
            failedFileCount,
            totalFileCount: 2 + structureChecks.length,
            error,
        };
    } catch (error) {
        signal?.throwIfAborted();
        return {
            titleId: null,
            titleVersion: null,
            status: 'failed',
            failedFileCount: 1,
            totalFileCount: 1,
            error: formatLogError(error),
        };
    } finally {
        await reader?.close();
    }
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
    const normalizedProductCode = getDiscProductCode(productCode);
    if (!normalizedProductCode) {
        return null;
    }

    const cached =
        type === 'icons'
            ? await readCachedTitleMedia(type, platform, normalizedProductCode)
            : null;
    if (cached) {
        return cached;
    }

    const gameTdbMedia = await readCachedGameTdbMedia(
        type,
        platform,
        normalizedProductCode
    );
    if (gameTdbMedia) {
        return gameTdbMedia;
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
                    return entry
                        ? readGameTdbMedia('icons', platform, productCode, {
                              region: entry.region,
                              name: entry.name,
                          })
                        : null;
                case 'covers':
                    return entry
                        ? readGameTdbMedia(type, platform, productCode, {
                              region: entry.region,
                              name: entry.name,
                          })
                        : null;
            }
        },
    });
}

export async function findWiiTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    const sourcePaths = await findTitleSourcePathsInRoots(
        roots,
        titleId,
        scanTitleEntriesWithDatabase,
        'wii',
        'wii'
    );
    return sourcePaths.filter((sourcePath) => !isWbfsSplitPart(sourcePath));
}

export async function findFirstReadableWiiRoot(
    roots: string[]
): Promise<string> {
    return findFirstReadableTitleRoot(roots, 'wii');
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
    const database = JSON.parse(jsonText) as Record<string, unknown>;
    const json = database.wii as RawTitleDatabaseEntry[];

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain a wii array');
    }

    return json
        .map((entry): TitleDatabaseEntry | null => {
            const productCode = getDiscProductCode(entry.productCode);
            const title = identifyWiiTitle(entry.titleId ?? productCode ?? '');
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

export async function readWiiTitleDatabase(): Promise<
    Map<string, TitleDatabaseEntry>
> {
    return readTitleDatabase({
        logNamespace: 'wii',
        required: true,
        parseEntries: parseTitleDatabaseEntries,
    });
}

export async function readWiiGameTdb(): Promise<Map<string, TitleDetails>> {
    return readGameTdb<GameTdbGame>({
        fileName: 'wii/tdb.xml',
        logNamespace: 'wii',
        includeGame: (game) => !isGameCubeGameTdbTitle(game),
        getId: (game) => getDiscProductCode(game.id) ?? null,
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
        platform: 'wii',
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

    const gameId =
        WII_GAME_ID_PATTERN.test(headerGameId.slice(0, 4)) &&
        /^[A-Z0-9]{2}$/.test(headerGameId.slice(4))
            ? headerGameId
            : null;

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

function readDiscHeaderText(buffer: Buffer, encoding = 'utf-8'): string | null {
    const nullIndex = buffer.indexOf(0);
    const textBuffer =
        nullIndex === -1 ? buffer : buffer.subarray(0, nullIndex);
    const text = new TextDecoder(encoding).decode(textBuffer).trim();
    return text.length > 0 ? text : null;
}

function openWiiDisc(filePath: string): Promise<WiiDiscReader> {
    return path.extname(filePath).toLowerCase() === '.iso'
        ? openIso(filePath)
        : openWbfs(filePath);
}

async function openIso(filePath: string): Promise<WiiDiscReader> {
    const file = await open(filePath, 'r');
    return {
        sparse: false,
        read: async (position, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            if (bytesRead !== length) {
                throw new Error('Unexpected end of Wii ISO image');
            }
            return buffer;
        },
        close: () => file.close(),
    };
}

function isWbfsSplitPart(filePath: string): boolean {
    return getWbfsSplitPartIndex(filePath) !== null;
}

export async function getWbfsDiscFilePaths(
    filePath: string
): Promise<string[]> {
    if (getWbfsSplitPartIndex(filePath) !== null) {
        return [filePath];
    }

    const files = [filePath];
    for (let index = 1; ; index += 1) {
        const partPath = getWbfsSplitPartPath(filePath, index);
        try {
            const info = await stat(partPath);
            if (!info.isFile()) {
                break;
            }
            files.push(partPath);
        } catch {
            break;
        }
    }
    return files;
}

async function openWbfs(filePath: string): Promise<WiiDiscReader> {
    const paths = await getWbfsDiscFilePaths(filePath);
    const parts: WbfsPart[] = [];
    let start = 0;
    for (const partPath of paths) {
        const size = (await stat(partPath)).size;
        parts.push({ file: await open(partPath, 'r'), size, start });
        start += size;
    }

    try {
        const physicalRead = (position: number, length: number) =>
            readWbfsParts(parts, position, length);
        const header = readWbfsHeader(await physicalRead(0, WBFS_HEADER_SIZE));
        if (!header) {
            throw new Error('Invalid WBFS header');
        }

        const discTable = await physicalRead(
            WBFS_HEADER_SIZE,
            header.hdSectorSize - WBFS_HEADER_SIZE
        );
        const discIndex = discTable.findIndex((value) => value !== 0);
        if (discIndex === -1) {
            throw new Error('WBFS contains no disc');
        }

        const logicalSectorCount = Math.ceil(
            WII_MAX_DISC_SIZE / header.wbfsSectorSize
        );
        const discInfoSize =
            Math.ceil((0x100 + logicalSectorCount * 2) / header.hdSectorSize) *
            header.hdSectorSize;
        const discOffset = header.hdSectorSize + discIndex * discInfoSize;
        const wlba = await physicalRead(
            discOffset + 0x100,
            logicalSectorCount * 2
        );
        let highestPhysicalSector = 0;
        for (let index = 0; index < logicalSectorCount; index += 1) {
            highestPhysicalSector = Math.max(
                highestPhysicalSector,
                wlba.readUInt16BE(index * 2)
            );
        }
        if (
            highestPhysicalSector > 0 &&
            (highestPhysicalSector + 1) * header.wbfsSectorSize > start
        ) {
            throw new Error(
                'WBFS sector map references data beyond the available split files'
            );
        }

        return {
            sparse: true,
            read: async (position, length) => {
                const output = Buffer.alloc(length);
                let outputOffset = 0;
                while (outputOffset < length) {
                    const logicalPosition = position + outputOffset;
                    const sector = Math.floor(
                        logicalPosition / header.wbfsSectorSize
                    );
                    const sectorOffset =
                        logicalPosition % header.wbfsSectorSize;
                    const chunk = Math.min(
                        length - outputOffset,
                        header.wbfsSectorSize - sectorOffset
                    );
                    const physicalSector = wlba.readUInt16BE(sector * 2);
                    if (physicalSector !== 0) {
                        const data = await physicalRead(
                            physicalSector * header.wbfsSectorSize +
                                sectorOffset,
                            chunk
                        );
                        data.copy(output, outputOffset);
                    }
                    outputOffset += chunk;
                }
                return output;
            },
            close: () => closeWbfsParts(parts),
        };
    } catch (error) {
        await closeWbfsParts(parts);
        throw error;
    }
}

function getWbfsSplitPartPath(filePath: string, index: number): string {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}.wbf${index}`);
}

function getWbfsSplitPartIndex(filePath: string): number | null {
    const match = path.extname(filePath).match(WBFS_SPLIT_PART_PATTERN);
    return match ? Number.parseInt(match[1] ?? '', 10) : null;
}

async function readWbfsParts(
    parts: WbfsPart[],
    position: number,
    length: number
): Promise<Buffer> {
    const output = Buffer.alloc(length);
    let outputOffset = 0;
    while (outputOffset < length) {
        const absolute = position + outputOffset;
        const part = parts.find(
            (candidate) =>
                absolute >= candidate.start &&
                absolute < candidate.start + candidate.size
        );
        if (!part) {
            throw new Error('Unexpected end of split WBFS image');
        }
        const partOffset = absolute - part.start;
        const chunk = Math.min(length - outputOffset, part.size - partOffset);
        const { bytesRead } = await part.file.read(
            output,
            outputOffset,
            chunk,
            partOffset
        );
        if (bytesRead !== chunk) {
            throw new Error('Unexpected end of split WBFS image');
        }
        outputOffset += chunk;
    }
    return output;
}

async function closeWbfsParts(parts: WbfsPart[]): Promise<void> {
    await Promise.all(parts.map((part) => part.file.close()));
}

async function readDiscInfoFromReader(
    reader: RandomAccessReader
): Promise<DiscHeaderInfo | null> {
    return parseDiscHeader(
        await reader.read(
            WII_DISC_HEADER_LOCATION.position,
            WII_DISC_HEADER_LOCATION.length
        )
    );
}

async function readDiscInfo(filePath: string): Promise<DiscHeaderInfo | null> {
    const reader = await openWiiDisc(filePath);
    try {
        return await readDiscInfoFromReader(reader);
    } finally {
        await reader.close();
    }
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

    let reader: WiiDiscReader | null = null;
    try {
        reader = await openWiiDisc(filePath);
        const discInfo = await readDiscInfoFromReader(reader);
        if (!discInfo?.titleId || !discInfo.name) {
            return {
                status: 'failed',
                error: 'Missing Wii disc metadata',
                verification: [],
            };
        }

        return await verifyWiiDisc(
            reader,
            WII_COMMON_KEYS,
            signal,
            reader.sparse
        );
    } catch (error) {
        return {
            status: 'failed',
            error: formatLogError(error),
            verification: [],
        };
    } finally {
        await reader?.close();
    }
}
