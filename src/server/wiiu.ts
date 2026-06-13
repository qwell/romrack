import { readdir, readFile, stat } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import { normalizeRegion } from '../shared/regions.js';
import { verifyTitleInstallFiles } from './install-title.js';

import {
    type AvailableTitleEntry,
    type TitleEntry,
    type TitleGroup,
    type TitleGroupStatus,
    type TitleDetails,
    type TitleInputControl,
    type ChildKind,
    type ParentKind,
    type WudTitleEntry,
    PARENT_KINDS,
    CHILD_KINDS,
    classifyTitleId,
    replaceTitleKind,
    normalizeTitleName,
    TitleKinds,
    TitleDatabaseEntry,
    RawTitleDatabaseEntry,
} from '../shared/titles.js';
import {
    toArray,
    mapConcurrent,
    formatSize,
    formatTitleDisplay,
} from '../shared/shared.js';
import { getAppRoot } from './paths.js';
import { getImmediatePathSizeBytes } from '../shared/file.js';
import { readTmd } from './title.js';
import logger from '../shared/logger.js';
import { ansi } from '../shared/ansi.js';
import { LibraryValidateTitle } from '../shared/api.js';
import { resolveReadablePath } from '../shared/os.js';
import { TMD_TITLE_FILE } from './nus/tmd.js';
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

type LocalTitleEntry = Omit<TitleEntry, 'copyCount'> & {
    family: string;
    sourcePath: string;
};

const LIBRARY_SCAN_CONCURRENCY = 8;
const availableOnCdnByTitleId = new Map<string, boolean>();

const titleScanCache = new Map<string, LocalTitleEntry[]>();

async function assertReadableDirectory(root: string): Promise<void> {
    const info = await stat(root);
    if (!info.isDirectory()) {
        throw new Error(`not a directory: ${root}`);
    }
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

export async function readWiiUTitleIdentity(
    titlePath: string
): Promise<{ titleId: string; version: number; kind: TitleKinds } | null> {
    const tmd = await readTmd(titlePath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    return {
        titleId,
        version: tmd.header.titleVersion,
        kind: classifyTitleId(titleId).kind,
    };
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const json = JSON.parse(jsonText) as RawTitleDatabaseEntry[];

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain an array');
    }

    const entries: TitleDatabaseEntry[] = json.map((entry) => {
        if (typeof entry.titleId !== 'string' || entry.titleId.length !== 16) {
            throw new Error(
                `invalid titleId in titles.json: ${JSON.stringify(entry)}`
            );
        }

        const { family } = classifyTitleId(entry.titleId);

        return {
            titleId: entry.titleId.toLowerCase(),
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

function updateEntryWithNewerVersion(
    target: TitleEntry,
    source: Pick<
        TitleEntry,
        'version' | 'name' | 'region' | 'iconUrl' | 'sizeBytes'
    >
): void {
    if (source.version <= target.version) {
        return;
    }

    target.version = source.version;
    target.name = source.name;
    target.region = source.region;
    target.iconUrl = source.iconUrl;
    target.sizeBytes = source.sizeBytes;
}

function mergeTitleEntry(entries: TitleEntry[], entry: TitleEntry): void {
    const existing = entries.find(
        (candidate) => candidate.titleId === entry.titleId
    );

    if (!existing) {
        entries.push({ ...entry });
        return;
    }

    existing.copyCount += entry.copyCount;
    updateEntryWithNewerVersion(existing, entry);
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

function getTitleAvailableOnCdn(titleId: string): boolean {
    return availableOnCdnByTitleId.get(titleId.toLowerCase()) ?? true;
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
                entry.titleId.toLowerCase(),
                entry.availableOnCdn === true
            );
        }
    }

    return new Map(titleEntries.map((entry) => [entry.family, entry]));
}

export async function getTitleIconUrl(family: string): Promise<string | null> {
    const titleDatabase = await readTitleDatabase();
    return titleDatabase.get(family)?.iconUrl ?? null;
}

async function readTitleEntry(
    root: string,
    dirname: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LocalTitleEntry | null> {
    const dirPath = path.join(root, dirname);
    const tmd = await readTmd(dirPath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const { family, kind } = classifyTitleId(titleId);
    const databaseEntry = titleDatabase.get(family);

    return {
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
    };
}

async function scanTitleEntries(
    root: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LocalTitleEntry[]> {
    const cached = titleScanCache.get(root);
    if (cached) {
        return cached;
    }

    const directories = await findTitleDirs(root);
    const entries = (
        await mapConcurrent(
            directories,
            LIBRARY_SCAN_CONCURRENCY,
            async (dirname) => readTitleEntry(root, dirname, titleDatabase)
        )
    ).filter((entry): entry is LocalTitleEntry => entry !== null);

    titleScanCache.set(root, entries);
    return entries;
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

function createEmptyGroup(family: string): TitleGroup {
    return {
        family,
        name: 'Unknown',
        region: null,
        productCode: null,
        iconUrl: null,
        details: null,
        availableEntries: [],
        wudEntries: [],
        titleInDatabase: false,
        expectedChildren: [],
        status: 'unknown',

        entries: [],
    };
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

export async function scanWiiUTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb] = await Promise.all([
        readTitleDatabase(),
        readGameTdb(),
    ]);

    const scanned = await scanTitleEntries(root, titleDatabase);

    const groups = new Map<string, TitleGroup>();

    for (const entry of scanned) {
        let group = groups.get(entry.family);

        if (!group) {
            group = createEmptyGroup(entry.family);
            groups.set(entry.family, group);
        }

        mergeTitleEntry(group.entries, {
            titleId: entry.titleId,
            version: entry.version,
            name: entry.name,
            region: entry.region,
            iconUrl: entry.iconUrl,
            kind: entry.kind,
            sizeBytes: entry.sizeBytes,
            copyCount: 1,
        });
    }

    for (const family of titleDatabase.keys()) {
        if (!groups.has(family)) {
            groups.set(family, createEmptyGroup(family));
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

        group.entries.sort((a, b) => b.version - a.version);
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    const merged = new Map<string, TitleGroup>();

    for (const group of groups) {
        const existing = merged.get(group.family);
        if (!existing) {
            merged.set(group.family, {
                ...group,
                availableEntries: [...group.availableEntries],
                wudEntries: [...group.wudEntries],
                expectedChildren: [...group.expectedChildren],
                entries: [...group.entries],
            });
            continue;
        }

        for (const entry of group.entries) {
            mergeTitleEntry(group.entries, {
                titleId: entry.titleId,
                version: entry.version,
                name: entry.name,
                region: entry.region,
                iconUrl: entry.iconUrl,
                kind: entry.kind,
                sizeBytes: entry.sizeBytes,
                copyCount: 1,
            });
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
        group.entries.sort((a, b) => b.version - a.version);
        group.status = getGroupStatus(group);
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
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
            const family = classifyTitleId(
                entry.titles[0]?.titleId ?? ''
            ).family;
            let group = groups.find((candidate) => candidate.family === family);
            if (!group) {
                group = createEmptyGroup(family);
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

export async function findWiiUTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    const normalizedTitleId = titleId.toLowerCase();
    const sourcePaths: string[] = [];
    const titleDatabase = await readTitleDatabase();

    for (const root of roots) {
        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            const entries = await scanTitleEntries(readableRoot, titleDatabase);

            sourcePaths.push(
                ...entries
                    .filter((entry) => entry.titleId === normalizedTitleId)
                    .map((entry) => entry.sourcePath)
            );
        } catch {
            logger.warn('wiiu', `skipping Wii U root ${root}`);
        }
    }

    return sourcePaths;
}

export async function findFirstReadableWiiURoot(
    roots: string[]
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

    throw new Error(`No readable Wii U roots found. ${errors.join('; ')}`);
}

type LibraryValidateProgress =
    | {
          status: 'validating';
          titleId: string;
          name: string;
          kind: TitleKinds;
          version: number | null;
          currentFileName?: string | null;
          currentFileSizeBytes?: number | null;
          current: number;
          total: number;
      }
    | {
          status: 'validated';
          titleId: string;
          name: string;
          kind: TitleKinds;
          version: number | null;
          result: 'ok' | 'failed';
          error: string | null;
          current: number;
          total: number;
      };

export type LibraryValidateProgressCallback = (
    progress: LibraryValidateProgress
) => void;

export async function validateWiiUTitles(
    root: string,
    onProgress?: (progress: LibraryValidateProgress) => void,
    options: {
        directories?: string[];
        offset?: number;
        total?: number;
        signal?: AbortSignal;
    } = {}
): Promise<LibraryValidateTitle[]> {
    const directories = options.directories ?? (await findTitleDirs(root));
    const validations: LibraryValidateTitle[] = [];
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
        throwIfLibraryValidateCancelled(options.signal);

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
            status: 'validating',
            titleId,
            name: titleName,
            kind: titleKind,
            version: titleVersion,
            current: offset + index,
            total,
        });

        logger.log(
            'wiiu',
            `validating title: ${formatTitleDisplay(
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
                    status: 'validating',
                    titleId,
                    name: titleName,
                    kind: titleKind,
                    version: titleVersion,
                    currentFileName: progress.currentFileName,
                    currentFileSizeBytes: progress.currentFileSizeBytes,
                    current: offset + index,
                    total,
                });
            }
        );
        throwIfLibraryValidateCancelled(options.signal);
        const result = verification.status === 'ok' ? 'ok' : 'failed';
        const status =
            verification.status === 'failed'
                ? `${ansi.red}failed${ansi.reset}`
                : `${ansi.green}${verification.status}${ansi.reset}`;

        // Keep the extra space, for alignment purposes
        logger.log(
            'wiiu',
            `validated title:  ${formatTitleDisplay(
                titleName,
                titleId,
                titleKind,
                verification.titleVersion
            )} (${status})`
        );

        onProgress?.({
            status: 'validated',
            titleId,
            name: titleName,
            kind: titleKind,
            version: verification.titleVersion,
            result,
            error: verification.error,
            current: offset + index + 1,
            total,
        });

        validations.push({
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

    return validations;
}

export async function verifyWiiUTitleRoots(
    roots: string[],
    onProgress?: (progress: LibraryValidateProgress) => void,
    signal?: AbortSignal
): Promise<LibraryValidateTitle[]> {
    const validations: LibraryValidateTitle[] = [];
    const readableRoots: { root: string; directories: string[] }[] = [];

    for (const root of roots) {
        throwIfLibraryValidateCancelled(signal);

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
        throwIfLibraryValidateCancelled(signal);

        validations.push(
            ...(await validateWiiUTitles(root.root, onProgress, {
                directories: root.directories,
                offset,
                total,
                signal,
            }))
        );
        offset += root.directories.length;
    }

    validations.push(
        ...createMissingExpectedChildValidations(
            await scanWiiUTitleRoots(roots),
            validations
        )
    );

    return sortLibraryTitleValidations(validations);
}

function throwIfLibraryValidateCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error('Validation cancelled');
    }
}

function sortLibraryTitleValidations(
    validations: LibraryValidateTitle[]
): LibraryValidateTitle[] {
    return validations.sort((a, b) => {
        const nameComparison = a.name.localeCompare(b.name);
        if (nameComparison !== 0) {
            return nameComparison;
        }

        return (a.directory ?? a.titleId ?? '').localeCompare(
            b.directory ?? b.titleId ?? ''
        );
    });
}

function createMissingExpectedChildValidations(
    groups: TitleGroup[],
    existingValidations: LibraryValidateTitle[]
): LibraryValidateTitle[] {
    const installedTitleIds = new Set(
        existingValidations
            .map((validation) => validation.titleId)
            .filter((titleId): titleId is string => titleId !== null)
    );
    const missing: LibraryValidateTitle[] = [];

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

export function clearTitleScanCache(): void {
    titleScanCache.clear();
}
