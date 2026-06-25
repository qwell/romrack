import {
    identifyTitle,
    type TitleEntry,
    type TitleGroup,
    type TitleKinds,
    type TitlePlatform,
} from '../shared/titles.js';
import { assertReadableDirectory } from '../shared/file.js';
import { resolveReadablePath } from '../shared/os.js';
import logger from '../shared/logger.js';
import { type Subsystems } from '../shared/ansi.js';

export type LibraryCacheTitleEntry = TitleEntry & {
    family: string;
    sourcePath: string;
    extraSourcePaths?: string[];
};

let libraryGroups: TitleGroup[] = [];
const titleScanCache = new Map<string, LibraryCacheTitleEntry[]>();

type ScanTitleEntries = (
    readableRoot: string
) => Promise<LibraryCacheTitleEntry[]>;

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

export function clearTitleScanCache(): void {
    titleScanCache.clear();
    libraryGroups = [];
}
