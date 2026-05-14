import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { normalizeRegion } from '../shared/regions.js';
import {
    type ContentTreeVerification,
    TMD_TITLE_FILE,
    validateTitleInstallFiles,
} from './metadata.js';

import {
    type AvailableTitleEntry,
    type TitleEntry,
    type TitleGroup,
    type TitleGroupStatus,
    type TitleDetails,
    type TitleInputControl,
    type ChildKind,
    type ParentKind,
    PARENT_KINDS,
    CHILD_KINDS,
    normalizeTitleName,
    TitleKinds,
    TitleDatabaseEntry,
    RawTitleDatabaseEntry,
} from '../shared/titles.js';
import { toArray, mapConcurrent, formatSize } from '../shared/shared.js';
import { getAppRoot } from './paths.js';
import { getImmediatePathSizeBytes } from '../shared/file.js';
import { readTmd } from './metadata.js';
import logger from '../shared/logger.js';
import { ansi } from '../shared/ansi.js';

export type LibraryTitleValidation = {
    root: string | null;
    directory: string | null;
    titleName: string;
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    error: string | null;
    verification: ContentTreeVerification[];
};

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

function classifyTitleId(titleId: string): {
    family: string;
    kind: TitleKinds;
} {
    const normalized = titleId?.toLowerCase() ?? '';

    if (normalized.length !== 16) {
        return { family: normalized, kind: TitleKinds.Unknown };
    }

    const prefix = normalized.slice(0, 8);
    const family = normalized.slice(8);

    switch (prefix) {
        case '00000007':
            return { family, kind: TitleKinds.vWii };

        case '00050000':
            return { family, kind: TitleKinds.Base };

        case '00050002':
            return { family, kind: TitleKinds.Demo };

        case '0005000b':
            return { family, kind: TitleKinds.FCT };

        case '0005000c':
            return { family, kind: TitleKinds.DLC };

        case '0005000d':
            return { family, kind: TitleKinds.Unknown };

        case '0005000e':
            return { family, kind: TitleKinds.Update };

        case '00050010':
            return { family, kind: TitleKinds.SystemApp };

        case '0005001b':
            return { family, kind: TitleKinds.SystemData };

        case '00050030':
            return { family, kind: TitleKinds.SystemApplet };

        default:
            return { family, kind: TitleKinds.Unknown };
    }
}

export async function readWiiUTitleIdentity(
    titlePath: string
): Promise<{ titleId: string; kind: TitleKinds } | null> {
    const tmd = await readTmd(titlePath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    return {
        titleId,
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
            updates: entry.updates,
            dlc: entry.dlc,

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

function replaceTitleKind(titleId: string, kind: TitleKinds): string {
    switch (kind) {
        case TitleKinds.Update:
            return `0005000e${titleId.slice(8)}`;
        case TitleKinds.DLC:
            return `0005000c${titleId.slice(8)}`;
        default:
            return titleId;
    }
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

    if (entry.updates.length > 0) {
        available.push({
            kind: TitleKinds.Update,
            titleId: replaceTitleKind(entry.titleId, TitleKinds.Update),
            versions: latestVersion(entry.updates),
            availableOnCdn: getTitleAvailableOnCdn(
                replaceTitleKind(entry.titleId, TitleKinds.Update)
            ),
        });
    }

    if (entry.dlc.length > 0) {
        available.push({
            kind: TitleKinds.DLC,
            titleId: replaceTitleKind(entry.titleId, TitleKinds.DLC),
            versions: latestVersion(entry.dlc),
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
        logger.warn('wiiu', `failed to read GameTdb at ${filePath}:`, error);
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
            logger.error('metadata', message, error);
        } else {
            logger.warn('metadata', message, error);
        }

        return [];
    }
}

async function readTitleDatabase(): Promise<Map<string, TitleDatabaseEntry>> {
    const titlesDir = path.join(getAppRoot(), 'titles');
    const titlesJsonPath = path.join(titlesDir, 'titles.json');
    const extraJsonPath = path.join(titlesDir, 'extra.json');

    const [titleEntries, extraEntries] = await Promise.all([
        readTitleDatabaseFile(titlesJsonPath, true),
        readTitleDatabaseFile(extraJsonPath),
    ]);

    for (const entry of [...titleEntries, ...extraEntries]) {
        if (entry.availableOnCdn !== undefined) {
            availableOnCdnByTitleId.set(
                entry.titleId.toLowerCase(),
                entry.availableOnCdn !== 'No'
            );
        }
    }

    return new Map(
        [...titleEntries, ...extraEntries].map((entry) => [entry.family, entry])
    );
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
        titleName: getTitleName(dirname, databaseEntry?.name ?? null),
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
                const subRel = relative
                    ? `${relative}/${entry.name}`
                    : entry.name;
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

export async function scanWiiUTitles(
    root: string,
    options: { includeAll?: boolean } = {}
): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb] = await Promise.all([
        readTitleDatabase(),
        readGameTdb(),
    ]);

    const directories = await findTitleDirs(root);

    const scanned = (
        await mapConcurrent(
            directories,
            LIBRARY_SCAN_CONCURRENCY,
            async (dirname) => readTitleEntry(root, dirname, titleDatabase)
        )
    ).filter((entry): entry is LocalTitleEntry => entry !== null);

    const groups = new Map<string, TitleGroup>();

    for (const entry of scanned) {
        let group = groups.get(entry.family);

        if (!group) {
            group = createEmptyGroup(entry.family);
            groups.set(entry.family, group);
        }

        const existingEntry = group.entries.find(
            (candidate) => candidate.titleId === entry.titleId
        );

        if (existingEntry) {
            existingEntry.copyCount += 1;
            if (entry.version > existingEntry.version) {
                existingEntry.version = entry.version;
                existingEntry.titleName = entry.titleName;
                existingEntry.region = entry.region;
                existingEntry.iconUrl = entry.iconUrl;
                existingEntry.sizeBytes = entry.sizeBytes;
            }
            continue;
        }

        const publicEntry: TitleEntry = {
            titleId: entry.titleId,
            version: entry.version,
            titleName: entry.titleName,
            region: entry.region,

            iconUrl: entry.iconUrl,
            kind: entry.kind,
            sizeBytes: entry.sizeBytes,
            copyCount: 1,
        };
        group.entries.push(publicEntry);
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
                ? databaseEntry.updates.length > 0
                : databaseEntry.dlc.length > 0;
        });
        group.status = getGroupStatus(group);

        if (parentEntry) {
            group.name = parentEntry.titleName;
            group.region = parentEntry.region;
            group.iconUrl = databaseEntry?.iconUrl
                ? `/api/title-icon/${encodeURIComponent(group.family)}`
                : parentEntry.iconUrl;
        } else if (databaseEntry) {
            group.name = databaseEntry.name;
            group.region = databaseEntry.region;
            group.iconUrl = databaseEntry.iconUrl
                ? `/api/title-icon/${encodeURIComponent(group.family)}`
                : null;
        } else {
            const firstLocalChild = group.entries.find((entry) =>
                CHILD_KINDS.includes(entry.kind as ChildKind)
            );

            group.name = firstLocalChild?.titleName ?? 'Unknown';
            group.region = firstLocalChild?.region ?? null;
            group.iconUrl = firstLocalChild?.iconUrl ?? null;
        }

        group.entries.sort((a, b) => b.version - a.version);
    }

    return [...groups.values()]
        .filter((group) => options.includeAll || group.entries.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    const merged = new Map<string, TitleGroup>();

    for (const group of groups) {
        const existing = merged.get(group.family);
        if (!existing) {
            merged.set(group.family, {
                ...group,
                availableEntries: [...group.availableEntries],
                expectedChildren: [...group.expectedChildren],
                entries: [...group.entries],
            });
            continue;
        }

        for (const entry of group.entries) {
            const existingEntry = existing.entries.find(
                (candidate) => candidate.titleId === entry.titleId
            );

            if (!existingEntry) {
                existing.entries.push(entry);
                continue;
            }

            existingEntry.copyCount += entry.copyCount;
            if (entry.version > existingEntry.version) {
                existingEntry.version = entry.version;
                existingEntry.titleName = entry.titleName;
                existingEntry.region = entry.region;
                existingEntry.iconUrl = entry.iconUrl;
                existingEntry.sizeBytes = entry.sizeBytes;
            }
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

export async function scanWiiUTitleRoots(
    roots: string[],
    options: { includeAll?: boolean } = {}
): Promise<TitleGroup[]> {
    const scannedGroups: TitleGroup[] = [];
    let scannedRootCount = 0;

    for (const root of roots) {
        try {
            await assertReadableDirectory(root);
            scannedGroups.push(
                ...(await scanWiiUTitles(root, {
                    includeAll: options.includeAll && scannedRootCount === 0,
                }))
            );
            scannedRootCount += 1;
        } catch {
            logger.warn('wiiu', `skipping Wii U root ${root}`);
        }
    }

    return mergeTitleGroups(scannedGroups).filter(
        (group) => options.includeAll || group.entries.length > 0
    );
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
            await assertReadableDirectory(root);
            const directories = await findTitleDirs(root);
            const entries = (
                await mapConcurrent(
                    directories,
                    LIBRARY_SCAN_CONCURRENCY,
                    async (dirname) =>
                        readTitleEntry(root, dirname, titleDatabase)
                )
            ).filter((entry): entry is LocalTitleEntry => entry !== null);

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
            await assertReadableDirectory(root);
            return root;
        } catch (error) {
            errors.push(
                `${root}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    throw new Error(`No readable Wii U roots found. ${errors.join('; ')}`);
}

type LibraryValidationProgress =
    | {
          status: 'validating';
          titleId: string;
          titleName: string;
          titleKind: TitleKinds;
          sizeText: string;
      }
    | {
          status: 'validated';
          titleId: string;
          titleName: string;
          titleKind: TitleKinds;
          result: 'ok' | 'failed';
      };

export type LibraryValidationProgressCallback = (
    progress: LibraryValidationProgress
) => void;

export async function validateWiiUTitles(
    root: string,
    onProgress?: (progress: LibraryValidationProgress) => void
): Promise<LibraryTitleValidation[]> {
    const directories = await findTitleDirs(root);
    const validations: LibraryTitleValidation[] = [];
    const titleDatabase = await readTitleDatabase();

    for (const directory of directories) {
        const dirPath = path.join(root, directory);
        const titleEntry = await readTitleEntry(root, directory, titleDatabase);
        const sizeBytes =
            titleEntry?.sizeBytes ?? (await getImmediatePathSizeBytes(dirPath));
        const titleId = titleEntry?.titleId ?? 'unknown';
        const titleName = titleEntry?.titleName ?? directory;
        const titleKind = titleEntry?.kind ?? TitleKinds.Unknown;

        const sizeText = formatSize(sizeBytes);

        onProgress?.({
            status: 'validating',
            titleId,
            titleName,
            titleKind,
            sizeText,
        });

        logger.log(
            'wiiu',
            `validating title: [${titleId}] ${titleName} [${titleKind}] (${sizeText})`
        );
        const validation = await validateTitleInstallFiles(dirPath);
        const result = validation.status === 'ok' ? 'ok' : 'failed';
        const status =
            validation.status === 'failed'
                ? `${ansi.red}failed${ansi.reset}`
                : `${ansi.green}${validation.status}${ansi.reset}`;

        // Keep the extra space, for alignment purposes
        logger.log(
            'wiiu',
            `validated title:  [${titleId}] ${titleName} [${titleKind}] (${status})`
        );

        onProgress?.({
            status: 'validated',
            titleId,
            titleName,
            titleKind,
            result,
        });

        validations.push({
            root,
            directory,
            titleName,
            titleId: validation.titleId,
            titleVersion: validation.titleVersion,
            status: validation.status,
            error: validation.error,
            verification: validation.verification,
        });
    }

    return validations;
}

export async function validateWiiUTitleRoots(
    roots: string[],
    onProgress?: (progress: LibraryValidationProgress) => void
): Promise<LibraryTitleValidation[]> {
    const validations: LibraryTitleValidation[] = [];

    for (const root of roots) {
        try {
            await assertReadableDirectory(root);
            validations.push(...(await validateWiiUTitles(root, onProgress)));
        } catch {
            logger.warn('wiiu', `skipping Wii U root ${root}`);
        }
    }

    validations.push(
        ...createMissingExpectedChildValidations(
            await scanWiiUTitleRoots(roots),
            validations
        )
    );

    return sortLibraryTitleValidations(validations);
}

function sortLibraryTitleValidations(
    validations: LibraryTitleValidation[]
): LibraryTitleValidation[] {
    return validations.sort((a, b) => {
        const nameComparison = a.titleName.localeCompare(b.titleName);
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
    existingValidations: LibraryTitleValidation[]
): LibraryTitleValidation[] {
    const installedTitleIds = new Set(
        existingValidations
            .map((validation) => validation.titleId)
            .filter((titleId): titleId is string => titleId !== null)
    );
    const missing: LibraryTitleValidation[] = [];

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
                titleName: group.name,
                titleId: expectedEntry.titleId,
                titleVersion: expectedEntry.versions[0] ?? null,
                status: 'failed',
                error: `Missing expected ${expectedKind}`,
                verification: [],
            });
        }
    }

    return missing;
}
