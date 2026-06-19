import { readdir, readFile } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import { normalizeRegion } from '../shared/regions.js';
import { verifyTitleInstallFiles } from './install-title.js';

import {
    type AvailableTitleEntry,
    type TitleGroup,
    type TitleGroupStatus,
    type TitleDetails,
    type TitleInputControl,
    type ChildKind,
    type ParentKind,
    type WudTitleEntry,
    PARENT_KINDS,
    CHILD_KINDS,
    cloneTitleGroup,
    createTitleGroup,
    mergeTitleEntry,
    identifyTitle,
    replaceTitleKind,
    identifyWiiUTitle,
    normalizeTitleName,
    TitleKinds,
    TitleDatabaseEntry,
    RawTitleDatabaseEntry,
} from '../shared/titles.js';
import {
    findFirstReadableTitleRoot,
    findTitleSourcePathsInRoots,
    getTitleScanCacheEntries,
    type LibraryCacheTitleEntry,
    setTitleScanCacheEntries,
} from './library.js';
import {
    toArray,
    mapConcurrent,
    formatLogError,
    formatSize,
    formatTitleDisplay,
} from '../shared/utils.js';
import { getAppRoot } from './paths.js';
import {
    assertReadableDirectory,
    getImmediatePathSizeBytes,
} from '../shared/file.js';
import { readTmd } from './title.js';
import logger from '../shared/logger.js';
import { ansi } from '../shared/ansi.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
    sortLibraryTitleVerifications,
} from '../shared/api.js';
import { resolveReadablePath } from '../shared/os.js';
import { TMD_TITLE_FILE } from './formats/tmd.js';
import { scanWudTitleEntries } from './wud.js';

type GameTdbLocale = {
    '@lang'?: string;
    synopsis?: string;
};

type GameTdbControl = {
    '@type'?: string;
    '@required'?: string;
};

type GameTdbGameImage = {
    '@size'?: string;
};

type GameTdbGame = {
    id?: string;
    region?: string;
    languages?: string;
    locale?: GameTdbLocale | GameTdbLocale[];
    developer?: string;
    genre?: string;
    input?: {
        control?: GameTdbControl | GameTdbControl[];
        '@players'?: string;
    };
    rom?: GameTdbGameImage;
};

type GameTdbFile = {
    games?: GameTdbGame[];
};

const LIBRARY_SCAN_CONCURRENCY = 8;
const availableOnCdnByTitleId = new Map<string, boolean>();

async function scanWiiUTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb] = await Promise.all([
        readTitleDatabase(),
        readGameTdb(),
    ]);

    const scanned = await scanTitleEntries(root, titleDatabase);

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
        const databaseEntry = titleDatabase.get(group.family) ?? null;
        const parentEntry = getParentByKind(group.entries);
        group.productCode = databaseEntry?.productCode ?? null;
        group.titleInDatabase = databaseEntry !== null;
        group.details = databaseEntry
            ? getGameTdbDetails(gameTdb, databaseEntry)
            : null;
        group.availableEntries = getAvailableEntries(databaseEntry);
        group.expectedChildren = CHILD_KINDS.filter((kind) => {
            if (!databaseEntry) {
                return false;
            }

            return kind === TitleKinds.Update
                ? databaseEntry.updateVersions.length > 0
                : databaseEntry.dlcVersions.length > 0;
        });
        group.status = getGroupStatus(group);

        if (parentEntry) {
            group.name = parentEntry.name;
            group.region = parentEntry.region;
            group.iconUrl = databaseEntry?.iconUrl
                ? getApiIconUrl(group.family)
                : parentEntry.iconUrl;
        } else if (databaseEntry) {
            group.name = databaseEntry.name;
            group.region = databaseEntry.region;
            group.iconUrl = databaseEntry.iconUrl
                ? getApiIconUrl(group.family)
                : null;
        } else {
            const firstLocalChild = group.entries.find((entry) =>
                CHILD_KINDS.includes(entry.kind as ChildKind)
            );

            group.name = firstLocalChild?.name ?? 'Unknown';
            group.region = firstLocalChild?.region ?? null;
            group.iconUrl = firstLocalChild?.iconUrl ?? null;
        }

        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanWiiUTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    const scannedGroups: TitleGroup[] = [];

    for (const root of roots) {
        logger.log('wiiu', `scanning Wii U root: ${root}`);
        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            scannedGroups.push(...(await scanWiiUTitles(readableRoot)));
        } catch {
            logger.warn('wiiu', `skipping Wii U root ${root}`);
        }
    }

    const groups = mergeTitleGroups(scannedGroups);

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

    const sortedGroups = groups.sort((a, b) => a.name.localeCompare(b.name));
    logger.log(
        'wiiu',
        `finished scanning Wii U roots: ${sortedGroups.length} title group(s)`
    );
    return sortedGroups;
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

    const cachedEntries = await scanTitleEntries(root, titleDatabase);
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
                titleKind,
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
                titleKind,
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
    const verifications: LibraryVerifyTitle[] = [];
    const readableRoots: { root: string; directories: string[] }[] = [];

    for (const root of roots) {
        throwIfLibraryVerifyCancelled(signal);

        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            readableRoots.push({
                root: readableRoot,
                directories: await findTitleDirs(readableRoot),
            });
        } catch {
            logger.warn('wiiu', `skipping Wii U root ${root}`);
        }
    }

    const total = readableRoots.reduce(
        (sum, root) => sum + root.directories.length,
        0
    );
    let offset = 0;

    for (const root of readableRoots) {
        throwIfLibraryVerifyCancelled(signal);

        verifications.push(
            ...(await verifyWiiUTitles(root.root, onProgress, {
                directories: root.directories,
                offset,
                total,
                signal,
            }))
        );
        offset += root.directories.length;
    }

    verifications.push(
        ...createMissingExpectedChildVerifications(
            await scanWiiUTitleRoots(roots),
            verifications
        )
    );

    return sortLibraryTitleVerifications(verifications);
}

export async function readWiiUTitleIdentity(
    titlePath: string
): Promise<{ titleId: string; version: number; kind: TitleKinds } | null> {
    const tmd = await readTmd(titlePath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const titleIdentity = identifyTitle(titleId);
    return {
        titleId,
        version: tmd.header.titleVersion,
        kind: titleIdentity?.kind ?? TitleKinds.Unknown,
    };
}

export async function getTitleIconUrl(family: string): Promise<string | null> {
    const titleDatabase = await readTitleDatabase();
    return titleDatabase.get(family)?.iconUrl ?? null;
}

export async function findWiiUTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    const titleDatabase = await readTitleDatabase();
    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        (readableRoot) => scanTitleEntries(readableRoot, titleDatabase),
        'wiiu',
        'Wii U'
    );
}

export async function findFirstReadableWiiURoot(
    roots: string[]
): Promise<string> {
    return findFirstReadableTitleRoot(roots, 'Wii U');
}

function createGroup(
    family: string,
    name = 'Unknown',
    region: string | null = null
): TitleGroup {
    return {
        ...createTitleGroup('wiiu', family),
        name,
        region,
    };
}

function getTitleAvailableOnCdn(titleId: string): boolean {
    return availableOnCdnByTitleId.get(titleId) ?? true;
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
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

        for (const entry of group.wudEntries) {
            mergeWudTitleEntry(existing.wudEntries, entry);
        }

        if (existing.status === 'missing' && group.status !== 'missing') {
            existing.name = group.name;
            existing.region = group.region;
            existing.productCode = group.productCode;
            existing.iconUrl = group.iconUrl;
            existing.details = group.details;
            existing.titleInDatabase = group.titleInDatabase;
            existing.status = group.status;
        }
    }

    for (const group of merged.values()) {
        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
        group.status = getGroupStatus(group);
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function throwIfLibraryVerifyCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error('Verification cancelled');
    }
}

async function findTitleDirs(root: string): Promise<string[]> {
    async function findTitleDirsInPath(
        currentPath: string,
        relative = ''
    ): Promise<string[]> {
        const found: string[] = [];
        let entries: Dirent[];
        try {
            entries = await readdir(currentPath, { withFileTypes: true });
        } catch {
            return found;
        }

        const hasTmd = entries.some(
            (entry) => entry.isFile() && entry.name === TMD_TITLE_FILE
        );
        if (hasTmd) {
            found.push(relative || '.');
        }

        const childDirectories = entries.filter((entry) => entry.isDirectory());
        const childResults = await mapConcurrent(
            childDirectories,
            LIBRARY_SCAN_CONCURRENCY,
            async (entry) => {
                const subRel = path.join(relative, entry.name);
                const childPath = path.join(currentPath, entry.name);
                return findTitleDirsInPath(childPath, subRel);
            }
        );
        found.push(...childResults.flat());

        return found;
    }

    return (await findTitleDirsInPath(root)).sort((a, b) => a.localeCompare(b));
}

async function readTitleEntry(
    root: string,
    dirname: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry | null> {
    const dirPath = path.join(root, dirname);
    const tmd = await readTmd(dirPath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const titleIdentity = identifyTitle(titleId);
    const family = titleIdentity?.family ?? titleId;
    const kind = titleIdentity?.kind ?? TitleKinds.Unknown;
    const databaseEntry = titleDatabase.get(family);

    return {
        platform: 'wiiu',
        titleId,
        sourcePath: dirPath,
        version: tmd.header.titleVersion,
        name: getTitleName(dirname, databaseEntry?.name ?? null),
        region: normalizeRegion(
            databaseEntry?.region ?? tmd.header.region,
            databaseEntry?.productCode
        ),
        iconUrl: databaseEntry?.iconUrl ?? null,

        kind,
        family,
        sizeBytes: await getImmediatePathSizeBytes(dirPath),
        copyCount: 1,
    };
}

async function scanTitleEntries(
    root: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry[]> {
    const cached = getTitleScanCacheEntries(root);
    if (cached) {
        return cached;
    }

    const directories = await findTitleDirs(root);
    const entries = (
        await mapConcurrent(
            directories,
            LIBRARY_SCAN_CONCURRENCY,
            async (dirname) => {
                try {
                    return await readTitleEntry(root, dirname, titleDatabase);
                } catch (error) {
                    logger.warn(
                        'wiiu',
                        `Failed to scan title ${path.join(root, dirname)}: ${formatLogError(error)}`
                    );
                    return null;
                }
            }
        )
    ).filter((entry): entry is LibraryCacheTitleEntry => entry !== null);

    setTitleScanCacheEntries(root, entries);
    return entries;
}

function cleanDirectoryName(dirname: string): string {
    // Clear [ and anything after it.
    return path
        .basename(dirname)
        .replace(/\s*\[.*$/, '')
        .trim();
}

function normalizeRelativeTitleDir(value: string): string {
    return value === '' ? '.' : value;
}

function getApiIconUrl(family: string): string {
    return `/api/icon/${encodeURIComponent(family)}`;
}

function getTitleName(dirname: string, databaseName: string | null): string {
    if (databaseName && databaseName.length > 0) {
        return normalizeTitleName(databaseName);
    }

    const cleaned = cleanDirectoryName(dirname);

    if (cleaned.length > 0) {
        return cleaned;
    }

    return 'Unknown';
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const json = JSON.parse(jsonText) as RawTitleDatabaseEntry[];

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain an array');
    }

    const entries: TitleDatabaseEntry[] = json.map((entry) => {
        const title = identifyWiiUTitle(entry.titleId);
        if (!title) {
            throw new Error(
                `invalid titleId in titles.json: ${JSON.stringify(entry)}`
            );
        }

        const { titleId, family } = title;

        return {
            titleId,
            name: normalizeTitleName(entry.name),
            region: normalizeRegion(entry.region, entry.productCode),
            companyCode: entry.companyCode?.length ? entry.companyCode : null,
            productCode: entry.productCode?.length ? entry.productCode : null,
            iconUrl: entry.iconUrl,

            baseVersions:
                entry.baseVersions?.filter((version) =>
                    Number.isFinite(version)
                ) ?? [],
            updateVersions: entry.updateVersions ?? [],
            dlcVersions: entry.dlcVersions ?? [],

            family,
            availableOnCdn: entry.availableOnCdn,
        };
    });

    return entries;
}

function splitList(value: string | null | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function parseNumber(value: string | null | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function getGameTdbId(entry: TitleDatabaseEntry): string | null {
    const productCode = entry.productCode?.match(/WUP-[PN]-([A-Z0-9]{4})/i);

    if (!productCode) {
        return null;
    }

    return productCode[1].toUpperCase();
}

function getGameTdbDetails(
    gameTdb: Map<string, TitleDetails>,
    entry: TitleDatabaseEntry
): TitleDetails | null {
    const id = getGameTdbId(entry);
    return id ? (gameTdb.get(id) ?? null) : null;
}

function latestVersion(versions: number[]): number[] {
    return versions.length === 0 ? [] : [versions[versions.length - 1]];
}

function getAvailableEntries(
    entry: TitleDatabaseEntry | null
): AvailableTitleEntry[] {
    if (!entry) {
        return [];
    }

    const available: AvailableTitleEntry[] = [
        {
            kind: TitleKinds.Base,
            titleId: entry.titleId,
            versions: latestVersion(entry.baseVersions),
            availableOnCdn: getTitleAvailableOnCdn(entry.titleId),
        },
    ];

    if (entry.updateVersions.length > 0) {
        available.push({
            kind: TitleKinds.Update,
            titleId: replaceTitleKind(entry.titleId, TitleKinds.Update),
            versions: latestVersion(entry.updateVersions),
            availableOnCdn: getTitleAvailableOnCdn(
                replaceTitleKind(entry.titleId, TitleKinds.Update)
            ),
        });
    }

    if (entry.dlcVersions.length > 0) {
        available.push({
            kind: TitleKinds.DLC,
            titleId: replaceTitleKind(entry.titleId, TitleKinds.DLC),
            versions: latestVersion(entry.dlcVersions),
            availableOnCdn: getTitleAvailableOnCdn(
                replaceTitleKind(entry.titleId, TitleKinds.DLC)
            ),
        });
    }

    return available;
}

function parseGameTdbDetails(game: GameTdbGame): TitleDetails {
    const { rom: gameImage } = game;
    const englishLocale =
        toArray(game.locale).find((locale) => locale['@lang'] === 'EN') ?? null;
    const synopsis = englishLocale?.synopsis?.trim() || null;
    const controls: TitleInputControl[] = toArray(game.input?.control)
        .filter((control) => control['@type'])
        .map((control) => ({
            type: control['@type'] ?? '',
            required: control['@required'] === 'true',
        }));

    return {
        tvFormat: game.region ?? null,
        languages: splitList(game.languages),
        synopsis,
        developer: game.developer?.trim() || null,
        genre: splitList(game.genre),
        inputPlayers: parseNumber(game.input?.['@players']),
        inputControls: controls,
        sizeBytes: parseNumber(gameImage?.['@size']),
    };
}

async function readGameTdb(): Promise<Map<string, TitleDetails>> {
    const filePath = path.join(getAppRoot(), 'titles', 'wiiutdb.json');

    try {
        const text = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(text) as GameTdbFile;
        const games = Array.isArray(parsed.games) ? parsed.games : [];

        return new Map(
            games
                .filter((game) => game.id)
                .map((game) => [
                    (game.id ?? '').slice(0, 4).toUpperCase(),
                    parseGameTdbDetails(game),
                ])
        );
    } catch (error) {
        logger.warn(
            'wiiu',
            `failed to read GameTdb at ${filePath}:`,
            String(error)
        );
        return new Map();
    }
}

async function readTitleDatabaseFile(
    filePath: string,
    required = false
): Promise<TitleDatabaseEntry[]> {
    try {
        const jsonText = await readFile(filePath, 'utf8');
        return parseTitleDatabaseEntries(jsonText);
    } catch (error) {
        const message = `[wiiu] failed to read titles DB at ${filePath}:`;

        if (required) {
            logger.error('metadata', message, String(error));
        } else {
            logger.warn('metadata', message, String(error));
        }

        return [];
    }
}

async function readTitleDatabase(): Promise<Map<string, TitleDatabaseEntry>> {
    const titlesDir = path.join(getAppRoot(), 'titles');
    const titlesJsonPath = path.join(titlesDir, 'titles.json');

    const titleEntries = await readTitleDatabaseFile(titlesJsonPath, true);

    for (const entry of titleEntries) {
        if (entry.availableOnCdn !== undefined) {
            availableOnCdnByTitleId.set(
                entry.titleId,
                entry.availableOnCdn === true
            );
        }
    }

    return new Map(titleEntries.map((entry) => [entry.family, entry]));
}

function getParentByKind<T extends { kind: TitleKinds }>(
    entries: T[]
): T | null {
    return (
        entries.find((candidate) =>
            PARENT_KINDS.includes(candidate.kind as ParentKind)
        ) ?? null
    );
}

function getGroupStatus(group: TitleGroup): TitleGroupStatus {
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
