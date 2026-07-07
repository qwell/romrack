import { readdir, readFile, stat } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import {
    CHILD_KINDS,
    cloneTitleGroup,
    createTitleGroup,
    mergeTitleEntry,
    PARENT_KINDS,
    replaceTitleKind,
    type AvailableTitleEntry,
    type ChildKind,
    type ParentKind,
    identifyTitle,
    type TitleDatabaseEntry,
    type TitleDetails,
    type TitleEntry,
    type TitleGroup,
    type TitleGroupStatus,
    type TitleKinds,
    TitleKinds as TitleKindValues,
    type TitleMediaType,
    type TitlePlatform,
} from '../shared/titles.js';
import { assertReadableDirectory, readOptionalFile } from '../shared/file.js';
import { resolveReadablePath } from '../shared/os.js';
import logger from '../shared/logger.js';
import { type Subsystems } from '../shared/ansi.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
    sortLibraryTitleVerifications,
} from '../shared/api.js';
import {
    formatLogError,
    latestVersion,
    mapConcurrent,
    toArray,
} from '../shared/utils.js';
import { getAppRoot } from './paths.js';
import {
    cacheTitleMedia,
    getImageContentType,
    readTitleMediaFromUrl,
    type CachedImage,
} from './image-cache.js';
import {
    isGameTdbGame,
    isSkippedGameTdbTitle,
    type GameTdbGame,
    type GameTdbXmlFile,
} from './gametdb.js';

export type LibraryCacheTitleEntry = TitleEntry & {
    family: string;
    sourcePath: string;
    productCode?: string | null;
    extraSourcePaths?: string[];
};

let libraryGroups: TitleGroup[] = [];
const titleScanCache = new Map<string, LibraryCacheTitleEntry[]>();
const titleDatabaseFileCache = new Map<string, TitleDatabaseFileCacheEntry>();
const LOCAL_TITLE_ICON_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

type ScanTitleEntries = (
    readableRoot: string
) => Promise<LibraryCacheTitleEntry[]>;

type TitleDatabaseFileCacheEntry = {
    mtimeMs: number;
    size: number;
    entries: TitleDatabaseEntry[];
};

export type LibraryFindItemOptions = {
    concurrency: number;
    logNamespace: Subsystems;
    logLabel: string;
    includeDirectory?: (entries: Dirent[]) => boolean;
    includeFile?: (entry: Dirent) => boolean;
};

export type LibraryScanEntriesOptions<TContext> = {
    concurrency: number;
    logNamespace: Subsystems;
    findItems: (root: string) => Promise<string[]>;
    readEntry: (
        root: string,
        item: string,
        context: TContext
    ) => Promise<LibraryCacheTitleEntry | null>;
    context: TContext;
};

export type ReadTitleDatabaseOptions = {
    fileName?: string;
    required?: boolean;
    logNamespace: Subsystems;
    parseEntries: (jsonText: string) => TitleDatabaseEntry[];
    onEntry?: (entry: TitleDatabaseEntry) => void;
};

export type GameTdbDetailsOptions<TGame extends GameTdbGame> = {
    fileName: string;
    logNamespace: Subsystems;
    getId: (game: TGame) => string | null;
    parseDetails: (game: TGame) => TitleDetails;
};

const gameTdbParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
});

export type TitleGroupMergeOptions = {
    afterMergeEntry?: (existing: TitleGroup, group: TitleGroup) => void;
    afterMergeGroup?: (group: TitleGroup) => void;
};

export type ScanTitleRootsOptions = {
    platformLabel: string;
    logNamespace: Subsystems;
    scanTitles: (root: string) => Promise<TitleGroup[]>;
    mergeTitleGroups: (groups: TitleGroup[]) => TitleGroup[];
    resultLabel: string;
};

export type VerifyTitleRootsOptions = {
    roots: string[];
    onProgress?: (progress: LibraryVerifyProgress) => void;
    signal?: AbortSignal;
    platformLabel: string;
    logNamespace: Subsystems;
    findItems: (root: string) => Promise<string[]>;
    verifyTitles: (
        root: string,
        onProgress: ((progress: LibraryVerifyProgress) => void) | undefined,
        options: {
            directories: string[];
            offset: number;
            total: number;
            signal?: AbortSignal;
        }
    ) => Promise<LibraryVerifyTitle[]>;
    afterVerify?: (
        verifications: LibraryVerifyTitle[]
    ) => Promise<LibraryVerifyTitle[]> | LibraryVerifyTitle[];
};

export type ReadTitleMediaOptions = {
    type: TitleMediaType;
    platform: TitlePlatform;
    productCode: string;
    readEntry?: (
        productCode: string
    ) => Promise<TitleDatabaseEntry | null> | TitleDatabaseEntry | null;
    getUrl: (
        type: TitleMediaType,
        entry: TitleDatabaseEntry | null,
        productCode: string
    ) => string | null;
    fallback?: (
        type: TitleMediaType,
        platform: TitlePlatform,
        productCode: string,
        entry: TitleDatabaseEntry | null
    ) => Promise<CachedImage | null> | CachedImage | null;
    logLabel: string;
};

export function setLibraryCacheGroups(groups: TitleGroup[]): void {
    libraryGroups = groups;
}

export function getLibraryCacheEntry(titleId: string): {
    platform: TitlePlatform;
    name: string;
    version: number | null;
    kind: TitleKinds | null;
} | null {
    const titleIdentity = identifyTitle(titleId);
    if (!titleIdentity) {
        return null;
    }

    let group;
    switch (titleIdentity.platform) {
        case '3ds':
        case 'wiiu':
            group = libraryGroups.find(
                (candidate) => candidate.family === titleIdentity.family
            );
            break;
        case 'wii':
            group = libraryGroups.find((candidate) =>
                candidate.entries.some((entry) => entry.titleId === titleId)
            );
            break;
    }

    if (!group || !group.name) {
        return null;
    }

    const entry =
        group.entries.find((candidate) => candidate.titleId === titleId) ??
        null;
    return {
        platform: group.platform,
        name: group.name,
        version: entry?.version ?? null,
        kind: entry?.kind ?? null,
    };
}

export function setTitleScanCacheEntries(
    root: string,
    entries: LibraryCacheTitleEntry[]
): void {
    titleScanCache.set(root, entries);
}

export function getTitleScanCacheEntries(
    root: string
): LibraryCacheTitleEntry[] | null {
    return titleScanCache.get(root) ?? null;
}

export function getTitleMediaUrl(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string | null
): string | null {
    return productCode
        ? `/api/media/${type}/${platform}/${encodeURIComponent(productCode)}`
        : null;
}

function getLocalTitleIconPaths(sourcePath: string): string[] {
    const dirname = path.dirname(sourcePath);
    const basename = path.basename(sourcePath);
    const extension = path.extname(sourcePath);
    const stem = extension ? path.basename(sourcePath, extension) : basename;
    const candidates = new Set<string>();

    for (const iconExtension of LOCAL_TITLE_ICON_EXTENSIONS) {
        candidates.add(path.join(dirname, `${stem}${iconExtension}`));
        candidates.add(path.join(dirname, `${basename}${iconExtension}`));
    }

    return [...candidates].filter((candidate) => candidate !== sourcePath);
}

async function readLocalTitleIcon(
    sourcePath: string
): Promise<CachedImage | null> {
    for (const iconPath of getLocalTitleIconPaths(sourcePath)) {
        const body = await readOptionalFile(iconPath);
        if (body) {
            return {
                body,
                contentType: getImageContentType(iconPath),
            };
        }
    }

    return null;
}

export async function cacheLocalTitleIcon(
    platform: TitlePlatform,
    productCode: string | null,
    sourcePath: string
): Promise<string | null> {
    if (!productCode) {
        return null;
    }

    const icon = await readLocalTitleIcon(sourcePath);
    if (!icon) {
        return null;
    }

    await cacheTitleMedia('icons', platform, productCode, icon);
    return getTitleMediaUrl('icons', platform, productCode);
}

export async function readTitleMedia(
    options: ReadTitleMediaOptions
): Promise<CachedImage | null> {
    const entry = (await options.readEntry?.(options.productCode)) ?? null;
    const url = options.getUrl(options.type, entry, options.productCode);

    if (url) {
        try {
            return await readTitleMediaFromUrl(
                url,
                options.type,
                options.platform,
                options.productCode
            );
        } catch (error) {
            if (options.type !== 'icons') {
                throw error;
            }

            logger.warn(
                'assets',
                `failed to load ${options.logLabel} icon media from URL for ${options.productCode}: ${formatLogError(error)}`
            );
        }
    }

    return (
        (await options.fallback?.(
            options.type,
            options.platform,
            options.productCode,
            entry
        )) ?? null
    );
}

export function getCachedTitleSourcePaths(titleId: string): string[] {
    return [
        ...new Set(
            [...titleScanCache.values()]
                .flat()
                .filter((entry) => entry.titleId === titleId)
                .flatMap((entry) => [
                    entry.sourcePath,
                    ...(entry.extraSourcePaths ?? []),
                ])
        ),
    ];
}

export async function findTitleSourcePathsInRoots(
    roots: string[],
    titleId: string,
    scanTitleEntries: ScanTitleEntries,
    logNamespace: Subsystems,
    rootLabel: string
): Promise<string[]> {
    const sourcePaths: string[] = [];

    for (const root of roots) {
        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            const entries = await scanTitleEntries(readableRoot);

            sourcePaths.push(
                ...entries
                    .filter((entry) => entry.titleId === titleId)
                    .flatMap((entry) => [
                        entry.sourcePath,
                        ...(entry.extraSourcePaths ?? []),
                    ])
            );
        } catch {
            logger.warn(logNamespace, `skipping ${rootLabel} root ${root}`);
        }
    }

    return sourcePaths;
}

export async function scanTitleRoots(
    roots: string[],
    options: ScanTitleRootsOptions
): Promise<TitleGroup[]> {
    const scannedGroups: TitleGroup[] = [];

    for (const root of roots) {
        logger.log(
            options.logNamespace,
            `scanning ${options.platformLabel} root: ${root}`
        );
        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            scannedGroups.push(...(await options.scanTitles(readableRoot)));
        } catch {
            logger.warn(
                options.logNamespace,
                `skipping ${options.platformLabel} root ${root}`
            );
        }
    }

    const groups = options.mergeTitleGroups(scannedGroups);
    logger.log(
        options.logNamespace,
        `finished scanning ${options.platformLabel} roots: ${groups.length} ${options.resultLabel}`
    );
    return groups;
}

export async function verifyTitleRoots(
    options: VerifyTitleRootsOptions
): Promise<LibraryVerifyTitle[]> {
    const verifications: LibraryVerifyTitle[] = [];
    const readableRoots: { root: string; directories: string[] }[] = [];

    for (const root of options.roots) {
        throwIfLibraryVerifyCancelled(options.signal);

        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            readableRoots.push({
                root: readableRoot,
                directories: await options.findItems(readableRoot),
            });
        } catch {
            logger.warn(
                options.logNamespace,
                `skipping ${options.platformLabel} root ${root}`
            );
        }
    }

    const total = readableRoots.reduce(
        (sum, root) => sum + root.directories.length,
        0
    );
    let offset = 0;

    for (const root of readableRoots) {
        throwIfLibraryVerifyCancelled(options.signal);

        verifications.push(
            ...(await options.verifyTitles(root.root, options.onProgress, {
                directories: root.directories,
                offset,
                total,
                signal: options.signal,
            }))
        );
        offset += root.directories.length;
    }

    if (options.afterVerify) {
        verifications.push(...(await options.afterVerify(verifications)));
    }

    return sortLibraryTitleVerifications(verifications);
}

export function throwIfLibraryVerifyCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error('Verification cancelled');
    }
}

export async function findFirstReadableTitleRoot(
    roots: string[],
    rootLabel: string
): Promise<string> {
    const errors: string[] = [];

    for (const root of roots) {
        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            return readableRoot;
        } catch (error) {
            errors.push(
                `${root}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    throw new Error(
        `No readable ${rootLabel} roots found. ${errors.join('; ')}`
    );
}

export async function findLibraryItems(
    root: string,
    options: LibraryFindItemOptions
): Promise<string[]> {
    async function findItemsInPath(
        currentPath: string,
        relative = ''
    ): Promise<string[]> {
        const found: string[] = [];
        let entries: Dirent[];
        try {
            entries = await readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            logger.warn(
                options.logNamespace,
                `skipping ${options.logLabel} directory ${currentPath}: ${formatLogError(error)}`
            );
            return found;
        }

        if (options.includeDirectory?.(entries)) {
            found.push(relative || '.');
        }

        if (options.includeFile) {
            for (const entry of entries) {
                if (entry.isFile() && options.includeFile(entry)) {
                    found.push(path.join(relative, entry.name));
                }
            }
        }

        const childDirectories = entries.filter((entry) => entry.isDirectory());
        const childResults = await mapConcurrent(
            childDirectories,
            options.concurrency,
            async (entry) => {
                const subRel = path.join(relative, entry.name);
                const childPath = path.join(currentPath, entry.name);
                return findItemsInPath(childPath, subRel);
            }
        );
        found.push(...childResults.flat());

        return found;
    }

    return (await findItemsInPath(root)).sort((a, b) => a.localeCompare(b));
}

export async function scanCachedTitleEntries<TContext>(
    root: string,
    options: LibraryScanEntriesOptions<TContext>
): Promise<LibraryCacheTitleEntry[]> {
    const cached = getTitleScanCacheEntries(root);
    if (cached) {
        return cached;
    }

    const items = await options.findItems(root);
    const entries = (
        await mapConcurrent(items, options.concurrency, async (item) => {
            try {
                return await options.readEntry(root, item, options.context);
            } catch (error) {
                logger.warn(
                    options.logNamespace,
                    `Failed to scan title ${path.join(root, item)}: ${formatLogError(error)}`
                );
                return null;
            }
        })
    ).filter((entry): entry is LibraryCacheTitleEntry => entry !== null);

    setTitleScanCacheEntries(root, entries);
    return entries;
}

export function mergeLibraryTitleGroups(
    groups: TitleGroup[],
    options: TitleGroupMergeOptions = {}
): TitleGroup[] {
    const merged = new Map<string, TitleGroup>();

    for (const group of groups) {
        const existing = merged.get(group.family);
        if (!existing) {
            merged.set(group.family, cloneTitleGroup(group));
            continue;
        }

        for (const entry of group.entries) {
            mergeTitleEntry(existing.entries, entry);
        }

        options.afterMergeEntry?.(existing, group);

        if (existing.status === 'missing' && group.status !== 'missing') {
            existing.name = group.name;
            existing.region = group.region;
            existing.productCode = group.productCode;
            existing.iconUrl = group.iconUrl;
            existing.bannerUrl = group.bannerUrl;
            existing.details = group.details;
            existing.titleInDatabase = group.titleInDatabase;
            existing.status = group.status;
        }
    }

    for (const group of merged.values()) {
        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
        options.afterMergeGroup?.(group);
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTitleDatabase(
    options: ReadTitleDatabaseOptions
): Promise<Map<string, TitleDatabaseEntry>> {
    const titlesJsonPath = path.join(
        getAppRoot(),
        'titles',
        options.fileName ?? 'titles.json'
    );
    const titleEntries = await readTitleDatabaseFile(titlesJsonPath, options);

    for (const entry of titleEntries) {
        options.onEntry?.(entry);
    }

    return new Map(titleEntries.map((entry) => [entry.family, entry]));
}

export async function readTitleDatabaseByProductCode(
    readDatabase: () => Promise<Map<string, TitleDatabaseEntry>>
): Promise<Map<string, TitleDatabaseEntry>> {
    const titleDatabase = await readDatabase();
    const entriesByProductCode = new Map<string, TitleDatabaseEntry>();

    for (const entry of titleDatabase.values()) {
        if (entry.productCode) {
            entriesByProductCode.set(entry.productCode, entry);
        }
    }

    return entriesByProductCode;
}

export async function readGameTdb<TGame extends GameTdbGame>(
    options: GameTdbDetailsOptions<TGame>
): Promise<Map<string, TitleDetails>> {
    const filePath = path.join(getAppRoot(), 'titles', options.fileName);

    try {
        const text = await readFile(filePath, 'utf8');
        const parsed = gameTdbParser.parse(text) as GameTdbXmlFile;
        const games = toArray(parsed?.datafile?.game).filter(
            (game): game is TGame =>
                isGameTdbGame(game) && !isSkippedGameTdbTitle(game)
        );

        return new Map(
            games
                .map((game): [string, TitleDetails] | null => {
                    const id = options.getId(game);
                    return id ? [id, options.parseDetails(game)] : null;
                })
                .filter(
                    (entry): entry is [string, TitleDetails] => entry !== null
                )
        );
    } catch (error) {
        logger.warn(
            options.logNamespace,
            `failed to read GameTDB at ${filePath}: ${formatLogError(error)}`
        );
        return new Map();
    }
}

export function splitGameTdbList(value: string | null | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

export function parseGameTdbNumber(
    value: string | null | undefined
): number | null {
    if (!value) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function parseGameTdbInputControls(
    game: GameTdbGame
): TitleDetails['inputControls'] {
    return toArray(game.input?.control)
        .filter((control) => control['@type'])
        .map((control) => ({
            type: control['@type'] ?? '',
            required: control['@required'] === 'true',
        }));
}

export function getParentByKind<T extends { kind: TitleKinds }>(
    entries: T[]
): T | null {
    return (
        entries.find((candidate) =>
            PARENT_KINDS.includes(candidate.kind as ParentKind)
        ) ?? null
    );
}

export function getGroupStatus(group: TitleGroup): TitleGroupStatus {
    if (!group.titleInDatabase) {
        return 'unknown';
    }

    if (group.entries.length === 0) {
        return 'missing';
    }

    if (
        !getParentByKind(group.entries) ||
        group.expectedChildren.some(
            (kind) => !group.entries.some((entry) => entry.kind === kind)
        )
    ) {
        return 'incomplete';
    }

    return 'complete';
}

export function getAvailableEntries(
    entry: TitleDatabaseEntry | null,
    getTitleAvailableOnCdn: (titleId: string) => boolean
): AvailableTitleEntry[] {
    if (!entry) {
        return [];
    }

    const available: AvailableTitleEntry[] = [
        {
            kind: TitleKindValues.Base,
            titleId: entry.titleId,
            versions: latestVersion(entry.baseVersions),
            availableOnCdn: getTitleAvailableOnCdn(entry.titleId),
        },
    ];

    if (entry.updateVersions.length > 0) {
        const titleId = replaceTitleKind(entry.titleId, TitleKindValues.Update);
        available.push({
            kind: TitleKindValues.Update,
            titleId,
            versions: latestVersion(entry.updateVersions),
            availableOnCdn: getTitleAvailableOnCdn(titleId),
        });
    }

    if (entry.dlcVersions.length > 0) {
        const titleId = replaceTitleKind(entry.titleId, TitleKindValues.DLC);
        available.push({
            kind: TitleKindValues.DLC,
            titleId,
            versions: latestVersion(entry.dlcVersions),
            availableOnCdn: getTitleAvailableOnCdn(titleId),
        });
    }

    return available;
}

export function createExpectedChildren(
    entry: TitleDatabaseEntry | null
): ChildKind[] {
    return CHILD_KINDS.filter((kind) => {
        if (!entry) {
            return false;
        }

        return kind === TitleKindValues.Update
            ? entry.updateVersions.length > 0
            : entry.dlcVersions.length > 0;
    });
}

export function createEmptyTitleGroup(
    platform: TitlePlatform,
    family: string,
    name = 'Unknown',
    region: string | null = null
): TitleGroup {
    return {
        ...createTitleGroup(platform, family),
        name,
        region,
    };
}

export function clearTitleScanCache(): void {
    titleScanCache.clear();
    libraryGroups = [];
}

async function readTitleDatabaseFile(
    filePath: string,
    options: ReadTitleDatabaseOptions
): Promise<TitleDatabaseEntry[]> {
    try {
        const cacheKey = `${options.logNamespace}:${filePath}`;
        const fileStat = await stat(filePath);
        const cached = titleDatabaseFileCache.get(cacheKey);
        if (
            cached &&
            cached.mtimeMs === fileStat.mtimeMs &&
            cached.size === fileStat.size
        ) {
            return cached.entries;
        }

        const jsonText = await readFile(filePath, 'utf8');
        const entries = options.parseEntries(jsonText);
        titleDatabaseFileCache.set(cacheKey, {
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            entries,
        });
        return entries;
    } catch (error) {
        const message = `[${options.logNamespace}] failed to read titles DB at ${filePath}:`;

        if (options.required) {
            logger.error('metadata', message, String(error));
        } else {
            logger.warn('metadata', message, String(error));
        }

        return [];
    }
}
