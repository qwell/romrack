import { readdir, stat } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';

import {
    formatLogError,
    formatSize,
    formatTitleDisplay,
    mapConcurrent,
} from '../shared/shared.js';
import {
    cloneTitleGroup,
    createTitleGroup,
    mergeTitleEntry,
    identifyWiiTitle,
    TitleDatabaseEntry,
    TitleKinds,
    type TitleGroup,
} from '../shared/titles.js';
import { resolveReadablePath } from '../shared/os.js';
import logger from '../shared/logger.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
    sortLibraryTitleVerifications,
} from '../shared/api.js';
import { assertReadableDirectory } from '../shared/file.js';
import { ansi } from '../shared/ansi.js';
import {
    type DiscHeaderLocation,
    getWbfsDiscFilePaths,
    isWbfsSplitPart,
    readDiscHeaderText,
    readIsoDiscHeader,
    readWbfsDiscHeader,
} from './formats/disc.js';
import {
    findFirstReadableTitleRoot,
    findTitleSourcePathsInRoots,
    getTitleScanCacheEntries,
    type LibraryCacheTitleEntry,
    setTitleScanCacheEntries,
} from './library.js';

const LIBRARY_SCAN_CONCURRENCY = 8;
const WII_DISC_IMAGE_EXTENSIONS = new Set(['.iso', '.wbfs']);
const WII_DISC_TITLE_ID_OFFSET = 0x00; // [0] = systemType, [1-2] = titleId, [3] = region
const WII_DISC_TITLE_ID_LENGTH = 0x04;
const WII_DISC_PUBLISHER_ID_OFFSET = 0x04;
const WII_DISC_PUBLISHER_ID_LENGTH = 0x02;
const WII_DISC_VERSION_OFFSET = 0x07;
const WII_DISC_MAGIC_OFFSET = 0x18;
const WII_DISC_MAGIC = 0x5d1c9ea3;
const WII_DISC_TITLE_NAME_OFFSET = 0x20;
const WII_DISC_TITLE_NAME_LENGTH = 64;
const WII_DISC_HEADER_LOCATION: DiscHeaderLocation = {
    position: 0,
    length: WII_DISC_TITLE_NAME_OFFSET + WII_DISC_TITLE_NAME_LENGTH,
};

const WII_SYSTEM_CODES = 'CDEFGHJLMNPQRSWX';
const WII_REGION_CODES = 'ABCDEFIJKLMNPQSTUWX';

const WII_GAME_ID_PATTERN = new RegExp(
    `^[${WII_SYSTEM_CODES}][A-Z0-9]{2}[${WII_REGION_CODES}]$`
);

const WII_PUBLISHER_ID_PATTERN = /^[A-Z0-9]{2}$/;

type DiscHeaderInfo = {
    titleId: string | null;
    name: string | null;
    region: string | null;
    version: number | null;
};

async function scanWiiTitles(root: string): Promise<TitleGroup[]> {
    const groups = new Map<string, TitleGroup>();
    const scanned = await scanTitleEntries(root);

    for (const entry of scanned) {
        let group = groups.get(entry.family);

        if (!group) {
            group = createGroup(entry.family, entry.name, entry.region);
            groups.set(entry.family, group);
        }

        mergeTitleEntry(group.entries, entry);
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanWiiTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    const scannedGroups: TitleGroup[] = [];

    for (const root of roots) {
        logger.log('wii', `scanning Wii root: ${root}`);
        try {
            const readableRoot = await resolveReadablePath(root);
            await assertReadableDirectory(readableRoot);
            scannedGroups.push(...(await scanWiiTitles(readableRoot)));
        } catch {
            logger.warn('wii', `skipping Wii root ${root}`);
        }
    }

    const groups = mergeTitleGroups(scannedGroups);
    logger.log(
        'wii',
        `finished scanning Wii roots: ${groups.length} disc image group(s)`
    );
    return groups;
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

    const cachedEntries = await scanTitleEntries(root);
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
        const titleKind = titleEntry?.kind ?? TitleKinds.Wii;
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
                titleKind,
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
                titleKind,
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

    return sortLibraryTitleVerifications(verifications);
}

export async function verifyWiiTitleRoots(
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
            logger.warn('wii', `skipping Wii root ${root}`);
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
            ...(await verifyWiiTitles(root.root, onProgress, {
                directories: root.directories,
                offset,
                total,
                signal,
            }))
        );
        offset += root.directories.length;
    }

    return sortLibraryTitleVerifications(verifications);
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
        kind: TitleKinds.Wii,
    };
}

export function getTitleIconUrl(family: string): Promise<string | null> {
    void family;
    return Promise.resolve(null);
}

export async function findWiiTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        scanTitleEntries,
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
    name = 'Unknown',
    region: string | null = null
): TitleGroup {
    return {
        ...createTitleGroup('wii', family),
        name,
        region,
        titleInDatabase: getTitleInDatabase(),
        status: 'complete',
    };
}

function getTitleAvailableOnCdn(titleId = ''): boolean {
    void titleId;
    return false;
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
        } catch (error) {
            logger.warn(
                'wii',
                `skipping Wii directory ${currentPath}: ${formatLogError(error)}`
            );
            return found;
        }

        for (const entry of entries) {
            if (
                entry.isFile() &&
                WII_DISC_IMAGE_EXTENSIONS.has(
                    path.extname(entry.name).toLowerCase()
                ) &&
                !isWbfsSplitPart(entry.name)
            ) {
                found.push(path.join(relative, entry.name));
            }
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    titleDatabase: Map<string, TitleDatabaseEntry> | null
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

    return {
        platform: 'wii',
        titleId,
        name,
        region: discInfo?.region ?? null,
        iconUrl: null,
        version: discInfo?.version ?? null,
        kind: TitleKinds.Wii,
        sizeBytes: await getDiscSizeBytes(filePaths),
        copyCount: 1,
        family: titleId.toLowerCase(),
        sourcePath: filePath,
        extraSourcePaths: filePaths.slice(1),
    };
}

async function scanTitleEntries(
    root: string
): Promise<LibraryCacheTitleEntry[]> {
    const cached = getTitleScanCacheEntries(root);
    if (cached) {
        return cached;
    }

    const directories = await findTitleDirs(root);
    const scannedEntries = (
        await mapConcurrent(
            directories,
            LIBRARY_SCAN_CONCURRENCY,
            async (dirname) => readTitleEntry(root, dirname, null)
        )
    ).filter((entry): entry is LibraryCacheTitleEntry => entry !== null);

    setTitleScanCacheEntries(root, scannedEntries);
    return scannedEntries;
}

function getTitleInDatabase(): boolean {
    return !getTitleAvailableOnCdn();
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

    const headerPublisherId = buffer
        .subarray(
            WII_DISC_PUBLISHER_ID_OFFSET,
            WII_DISC_PUBLISHER_ID_OFFSET + WII_DISC_PUBLISHER_ID_LENGTH
        )
        .toString('ascii')
        .toUpperCase();

    const publisherId = WII_PUBLISHER_ID_PATTERN.test(headerPublisherId)
        ? headerPublisherId
        : null;
    const titleIdentity =
        gameId && publisherId
            ? identifyWiiTitle(`${gameId}${publisherId}`)
            : null;
    const titleId = titleIdentity?.titleId ?? null;
    const region = getDiscRegion(gameId);

    const version = buffer[WII_DISC_VERSION_OFFSET];

    const name = readDiscHeaderText(
        buffer.subarray(
            WII_DISC_TITLE_NAME_OFFSET,
            WII_DISC_TITLE_NAME_OFFSET + WII_DISC_TITLE_NAME_LENGTH
        )
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

        return {
            status: 'ok',
            error: null,
            verification: [],
        };
    } catch (error) {
        return {
            status: 'failed',
            error: formatLogError(error),
            verification: [],
        };
    }
}
