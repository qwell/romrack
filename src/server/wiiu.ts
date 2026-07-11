import path from 'node:path';
import { normalizeRegion } from '../shared/regions.js';
import { verifyTitleInstallFiles } from './install-title.js';

import {
    type TitleGroup,
    type TitleDetails,
    type ChildKind,
    type WudTitleEntry,
    CHILD_KINDS,
    PARENT_KINDS,
    mergeTitleEntry,
    identifyTitle,
    getWiiProductCode,
    getWiiUProductCode,
    normalizeTitleName,
    TitleKinds,
    type TitleDatabaseEntry,
    type RawTitleDatabaseEntry,
    type TitleMediaType,
    type TitlePlatform,
} from '../shared/titles.js';
import {
    cacheLocalTitleIcon,
    createEmptyTitleGroup,
    createExpectedChildren,
    findFirstReadableTitleRoot,
    findLibraryItems,
    findTitleSourcePathsInRoots,
    getAvailableEntries,
    getGroupStatus,
    getTitleMediaUrl,
    type LibraryCacheTitleEntry,
    mergeLibraryTitleGroups,
    parseGameTdbInputControls,
    parseGameTdbNumber,
    readGameTdb as readLibraryGameTdb,
    readTitleDatabase as readLibraryTitleDatabase,
    readTitleDatabaseByProductCode,
    readTitleMedia,
    scanCachedTitleEntries,
    scanTitleRoots,
    throwIfLibraryVerifyCancelled,
    verifyTitleRoots,
    splitGameTdbList,
} from './library.js';
import { formatSize, formatTitleDisplay } from '../shared/utils.js';
import { getImmediatePathSizeBytes, readOptionalFile } from '../shared/file.js';
import { readInstalledWiiUMeta, readTmd, type Tmd } from './title.js';
import logger from '../shared/logger.js';
import { ansi } from '../shared/ansi.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
} from '../shared/api.js';
import { TMD_TITLE_FILE } from './formats/tmd.js';
import { scanWudTitleEntries } from './wud.js';
import {
    getGameTdbLocales,
    getPreferredGameTdbSynopsis,
    type GameTdbGame,
    readGameTdbMedia,
} from './gametdb.js';
import { readCachedTitleMedia, type CachedImage } from './image-cache.js';
import { META_XML_FILES, readMetaXml } from './formats/meta.js';
import { readWiiGameTdb, readWiiTitleDatabase } from './wii.js';

const LIBRARY_SCAN_CONCURRENCY = 8;
const PARENT_KIND_SET: ReadonlySet<TitleKinds> = new Set(PARENT_KINDS);
const availableOnCdnByTitleId = new Map<string, boolean>();
type WiiUTitleScanContext = {
    titleDatabase: Map<string, TitleDatabaseEntry>;
    wiiTitleDatabaseByTitleId: Map<string, TitleDatabaseEntry>;
};

async function scanWiiUTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb, wiiTitleDatabaseByTitleId, wiiGameTdb] =
        await Promise.all([
            readTitleDatabase(),
            readGameTdb(),
            readWiiTitleDatabase(),
            readWiiGameTdb(),
        ]);

    const scanned = await scanTitleEntries(root, {
        titleDatabase,
        wiiTitleDatabaseByTitleId,
    });

    const groups = new Map<string, TitleGroup>();

    for (const entry of scanned) {
        let group = groups.get(entry.family);

        if (!group) {
            group = createGroup(entry.family);
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
        const databaseEntry =
            titleDatabase.get(group.family) ??
            getWiiTitleDatabaseEntry(group, wiiTitleDatabaseByTitleId);
        const parentEntry = getParentEntry(group);
        group.productCode =
            databaseEntry?.productCode ?? getParentProductCode(group);
        group.titleInDatabase = databaseEntry !== null;
        group.details = databaseEntry
            ? getGameTdbDetails(
                  databaseEntry.platform === 'wii' ? wiiGameTdb : gameTdb,
                  databaseEntry
              )
            : null;
        const titleUrls = getTitleMediaUrls(databaseEntry);
        group.availableEntries = getAvailableEntries(
            databaseEntry?.platform === 'wiiu' ? databaseEntry : null,
            getTitleAvailableOnCdn
        );
        group.expectedChildren = createExpectedChildren(
            databaseEntry?.platform === 'wiiu' ? databaseEntry : null
        );
        group.status = getGroupStatus(group);

        if (parentEntry) {
            group.name = parentEntry.name;
            group.region = parentEntry.region;
            group.iconUrl = titleUrls.iconUrl ?? parentEntry.iconUrl;
            group.bannerUrl = titleUrls.bannerUrl ?? parentEntry.bannerUrl;
        } else if (databaseEntry) {
            group.name = databaseEntry.name;
            group.region = databaseEntry.region;
            group.iconUrl = titleUrls.iconUrl;
            group.bannerUrl = titleUrls.bannerUrl;
        } else {
            const firstLocalChild = group.entries.find((entry) =>
                CHILD_KINDS.includes(entry.kind as ChildKind)
            );

            group.name = firstLocalChild?.name ?? 'Unknown';
            group.region = firstLocalChild?.region ?? null;
            group.iconUrl = firstLocalChild?.iconUrl ?? null;
            group.bannerUrl = firstLocalChild?.bannerUrl ?? null;
        }

        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanWiiUTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    const groups = await scanTitleRoots(roots, {
        platform: 'wiiu',
        logNamespace: 'wiiu',
        scanTitles: scanWiiUTitles,
        mergeTitleGroups,
        resultLabel: 'title group(s)',
    });

    try {
        for (const entry of await scanWudTitleEntries(roots)) {
            const family = identifyTitle(entry.titles[0]?.titleId)?.family;
            if (!family) {
                continue;
            }
            let group = groups.find((candidate) => candidate.family === family);
            if (!group) {
                group = createGroup(family);
                groups.push(group);
            }
            mergeWudTitleEntry(group.wudEntries, entry);
        }
    } catch (error) {
        logger.warn(
            'wud',
            `failed to scan WUD/WUX library entries: ${String(error)}`
        );
    }

    return groups.sort((a, b) => a.name.localeCompare(b.name));
}

async function verifyWiiUTitles(
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
    const titleDatabase = await readTitleDatabase();
    const offset = options.offset ?? 0;
    const total = options.total ?? directories.length;

    const cachedEntries = await scanTitleEntries(root, {
        titleDatabase,
        wiiTitleDatabaseByTitleId: new Map(),
    });
    const entriesByDirectory = new Map(
        cachedEntries.map((entry) => [
            normalizeRelativeTitleDir(path.relative(root, entry.sourcePath)),
            entry,
        ])
    );

    for (const [index, directory] of directories.entries()) {
        throwIfLibraryVerifyCancelled(options.signal);

        const dirPath = path.join(root, directory);

        const titleEntry =
            entriesByDirectory.get(normalizeRelativeTitleDir(directory)) ??
            null;

        const sizeBytes =
            titleEntry?.sizeBytes ?? (await getImmediatePathSizeBytes(dirPath));
        const titleId = titleEntry?.titleId ?? 'unknown';
        const titleName = titleEntry?.name ?? directory;
        const titleKind = titleEntry?.kind ?? TitleKinds.Unknown;
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
            'wiiu',
            `verifying title: ${formatTitleDisplay(
                titleName,
                titleId,
                titleVersion
            )} (${sizeText})`
        );
        const verification = await verifyTitleInstallFiles(
            dirPath,
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

        // Keep the extra space, for alignment purposes
        logger.log(
            'wiiu',
            `verified title:  ${formatTitleDisplay(
                titleName,
                titleId,
                verification.titleVersion
            )} (${status})`
        );

        onProgress?.({
            titleId,
            name: titleName,
            kind: titleKind,
            version: verification.titleVersion,
            result,
            error: verification.error,
            current: offset + index + 1,
            total,
        });

        verifications.push({
            root,
            directory,
            name: titleName,
            titleId: verification.titleId,
            version: verification.titleVersion,
            kind: titleKind,
            sizeText,
            status: verification.status,
            error: verification.error,
            verification: verification.verification,
        });
    }

    return verifications;
}

export async function verifyWiiUTitleRoots(
    roots: string[],
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyTitleRoots({
        roots,
        onProgress,
        signal,
        platform: 'wiiu',
        logNamespace: 'wiiu',
        findItems: findTitleDirs,
        verifyTitles: verifyWiiUTitles,
        afterVerify: async (verifications) =>
            createMissingExpectedChildVerifications(
                await scanWiiUTitleRoots(roots),
                verifications
            ),
    });
}

export async function readWiiUTitleIdentity(
    titlePath: string
): Promise<{ titleId: string; version: number; kind: TitleKinds } | null> {
    const tmd = await readTmd(titlePath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const title = identifyTitle(titleId);
    if (!title) {
        return null;
    }

    return {
        titleId,
        version: tmd.header.titleVersion,
        kind: title.kind ?? TitleKinds.Unknown,
    };
}

export async function readWiiUTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    const normalizedProductCode = getWiiUProductCode(productCode);
    if (!normalizedProductCode) {
        return null;
    }

    const titleDatabase =
        await readTitleDatabaseByProductCode(readTitleDatabase);

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
    });
}

export async function findWiiUTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    const titleDatabase = await readTitleDatabase();
    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        (readableRoot) =>
            scanTitleEntries(readableRoot, {
                titleDatabase,
                wiiTitleDatabaseByTitleId: new Map(),
            }),
        'wiiu',
        'wiiu'
    );
}

export async function findFirstReadableWiiURoot(
    roots: string[]
): Promise<string> {
    return findFirstReadableTitleRoot(roots, 'wiiu');
}

function createGroup(
    family: string,
    name = 'Unknown',
    region: string | null = null
): TitleGroup {
    return createEmptyTitleGroup('wiiu', family, name, region);
}

function getTitleAvailableOnCdn(titleId: string): boolean {
    return availableOnCdnByTitleId.get(titleId) ?? true;
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    return mergeLibraryTitleGroups(groups, {
        afterMergeEntry: (existing, group) => {
            for (const entry of group.wudEntries) {
                mergeWudTitleEntry(existing.wudEntries, entry);
            }
        },
        afterMergeGroup: (group) => {
            group.status = getGroupStatus(group);
        },
    });
}

async function findTitleDirs(root: string): Promise<string[]> {
    return findLibraryItems(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'wiiu',
        platform: 'wiiu',
        includeDirectory: (entries) =>
            entries.some(
                (entry) => entry.isFile() && entry.name === TMD_TITLE_FILE
            ),
    });
}

async function readTitleEntry(
    root: string,
    dirname: string,
    context: WiiUTitleScanContext
): Promise<LibraryCacheTitleEntry | null> {
    const dirPath = path.join(root, dirname);
    const tmd = await readTmd(dirPath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const titleIdentity = identifyTitle(titleId);
    if (!titleIdentity) {
        return null;
    }

    const family = titleIdentity.family ?? titleId;
    const kind = titleIdentity.kind ?? TitleKinds.Unknown;
    const meta = await readLocalMetaXml(dirPath, tmd);
    const wiiFallbackTitleId = getWiiFallbackTitleId(meta?.productCode, family);

    const databaseEntry =
        context.titleDatabase.get(family) ??
        (wiiFallbackTitleId
            ? (context.wiiTitleDatabaseByTitleId.get(wiiFallbackTitleId) ??
              null)
            : null);
    const titleUrls = getTitleMediaUrls(databaseEntry);
    const productCode = databaseEntry?.productCode ?? wiiFallbackTitleId;
    const sidecarIconUrl = await cacheLocalTitleIcon(
        'wiiu',
        productCode,
        dirPath
    );

    return {
        titleId,
        platform: titleIdentity.platform,
        name: getTitleName(databaseEntry?.name ?? meta?.name ?? null),
        region: normalizeRegion(
            databaseEntry?.region ?? meta?.region ?? tmd.header.region,
            databaseEntry?.productCode ?? productCode
        ),
        version: tmd.header.titleVersion,

        iconUrl: sidecarIconUrl ?? titleUrls.iconUrl,
        bannerUrl: titleUrls.bannerUrl,

        kind,
        family,
        productCode,

        sizeBytes: await getImmediatePathSizeBytes(dirPath),
        copyCount: 1,
        sourcePath: dirPath,
    };
}

async function scanTitleEntries(
    root: string,
    context: WiiUTitleScanContext
): Promise<LibraryCacheTitleEntry[]> {
    return scanCachedTitleEntries(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'wiiu',
        findItems: findTitleDirs,
        readEntry: readTitleEntry,
        context,
    });
}

function normalizeRelativeTitleDir(value: string): string {
    return value === '' ? '.' : value;
}

function getTitleName(databaseName: string | null): string {
    if (databaseName && databaseName.length > 0) {
        return normalizeTitleName(databaseName);
    }

    return 'Unknown';
}

function getWiiFallbackTitleId(
    value: string | null | undefined,
    family?: string
): string | null {
    return (
        getWiiUProductCode(value) ??
        getWiiProductCode(value) ??
        getWiiProductCodeFromFamily(family)
    );
}

function getWiiProductCodeFromFamily(
    family: string | undefined
): string | null {
    if (!family || !/^[a-f0-9]{8}$/i.test(family)) {
        return null;
    }

    return getWiiProductCode(Buffer.from(family, 'hex').toString('ascii'));
}

async function readLocalMetaXml(
    dirPath: string,
    tmd: Tmd
): Promise<ReturnType<typeof readMetaXml>> {
    for (const relativePath of META_XML_FILES) {
        const metaXml = await readOptionalFile(
            path.join(dirPath, relativePath)
        );
        const meta = metaXml ? readMetaXml(metaXml) : null;
        if (meta) {
            return meta;
        }
    }

    try {
        return await readInstalledWiiUMeta(dirPath, tmd);
    } catch (error) {
        logger.warn(
            'wiiu',
            `failed to read local Wii U metadata from ${dirPath}: ${String(error)}`
        );
        return null;
    }
}

function getWiiTitleDatabaseEntry(
    group: TitleGroup,
    entriesByTitleId: Map<string, TitleDatabaseEntry>
): TitleDatabaseEntry | null {
    const titleId = getWiiFallbackTitleId(
        getParentProductCode(group),
        group.family
    );
    return titleId ? (entriesByTitleId.get(titleId) ?? null) : null;
}

function getParentEntry(
    group: TitleGroup
): TitleGroup['entries'][number] | null {
    return (
        group.entries.find((entry) => PARENT_KIND_SET.has(entry.kind)) ?? null
    );
}

function getParentProductCode(group: TitleGroup): string | null {
    const parentEntry = getParentEntry(group);
    if (!parentEntry || !('productCode' in parentEntry)) {
        return null;
    }
    return typeof parentEntry.productCode === 'string'
        ? parentEntry.productCode
        : null;
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const json = JSON.parse(jsonText) as RawTitleDatabaseEntry[];

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain an array');
    }

    const entries = json
        .map((entry): TitleDatabaseEntry | null => {
            const title = identifyTitle(entry.titleId);
            if (!title) {
                throw new Error(
                    `invalid titleId in titles.json: ${JSON.stringify(entry)}`
                );
            }

            if (title.platform !== 'wiiu') {
                return null;
            }

            const { titleId, family } = title;

            return {
                platform: title.platform,
                titleId,
                name: normalizeTitleName(entry.name),
                region: normalizeRegion(entry.region, entry.productCode),
                companyCode: entry.companyCode?.length
                    ? entry.companyCode
                    : null,
                productCode: getWiiUProductCode(entry.productCode),
                iconUrl: entry.iconUrl,
                bannerUrl: entry.bannerUrl ?? null,

                baseVersions:
                    entry.baseVersions?.filter((version) =>
                        Number.isFinite(version)
                    ) ?? [],
                updateVersions: entry.updateVersions ?? [],
                dlcVersions: entry.dlcVersions ?? [],

                family,
                availableOnCdn: entry.availableOnCdn,
            };
        })
        .filter((entry): entry is TitleDatabaseEntry => entry !== null);

    return entries;
}

function getGameTdbDetails(
    gameTdb: Map<string, TitleDetails>,
    entry: TitleDatabaseEntry
): TitleDetails | null {
    const id = entry.productCode;
    return id ? (gameTdb.get(id) ?? null) : null;
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

    const platform = entry.platform;

    return {
        iconUrl: getTitleMediaUrl('icons', platform, entry.productCode),
        bannerUrl: getTitleMediaUrl('covers', platform, entry.productCode),
    };
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

async function readGameTdb(): Promise<Map<string, TitleDetails>> {
    return readLibraryGameTdb<GameTdbGame>({
        fileName: 'wiiu/tdb.xml',
        logNamespace: 'wiiu',
        getId: (game) => (game.id ?? '').slice(0, 4).toUpperCase() || null,
        parseDetails: parseGameTdbDetails,
    });
}

async function readTitleDatabase(): Promise<Map<string, TitleDatabaseEntry>> {
    return readLibraryTitleDatabase({
        logNamespace: 'wiiu',
        required: true,
        parseEntries: parseTitleDatabaseEntries,
        onEntry: (entry) => {
            if (entry.availableOnCdn === undefined) {
                return;
            }
            availableOnCdnByTitleId.set(
                entry.titleId,
                entry.availableOnCdn === true
            );
        },
    });
}

function mergeWudTitleEntry(
    entries: WudTitleEntry[],
    entry: WudTitleEntry
): void {
    const existing = entries.find(
        (candidate) => candidate.imageName === entry.imageName
    );

    if (existing) {
        for (const title of entry.titles) {
            const existingTitle = existing.titles.find(
                (candidate) => candidate.titleId === title.titleId
            );
            if (!existingTitle) {
                existing.titles.push({ ...title });
            } else if (title.version > existingTitle.version) {
                existingTitle.version = title.version;
            }
        }
        existing.copyCount += entry.copyCount;
        return;
    }

    entries.push({
        ...entry,
        titles: entry.titles.map((title) => ({ ...title })),
    });
}

function createMissingExpectedChildVerifications(
    groups: TitleGroup[],
    existingVerifications: LibraryVerifyTitle[]
): LibraryVerifyTitle[] {
    const installedTitleIds = new Set(
        existingVerifications
            .map((verification) => verification.titleId)
            .filter((titleId): titleId is string => titleId !== null)
    );
    const missing: LibraryVerifyTitle[] = [];

    for (const group of groups) {
        if (group.entries.length === 0) {
            continue;
        }

        for (const expectedKind of group.expectedChildren) {
            const expectedEntry = group.availableEntries.find(
                (entry) => entry.kind === expectedKind
            );

            if (
                !expectedEntry ||
                installedTitleIds.has(expectedEntry.titleId)
            ) {
                continue;
            }

            missing.push({
                root: null,
                directory: null,
                name: group.name,
                titleId: expectedEntry.titleId,
                version: expectedEntry.versions[0] ?? null,
                kind: expectedKind,
                sizeText: null,
                status: 'failed',
                error: `Missing expected ${expectedKind}`,
                verification: [],
            });
        }
    }

    return missing;
}
