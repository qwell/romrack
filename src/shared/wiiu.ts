import path from 'path';
import fs from 'fs';

import { DEFAULT_ROM_DIR } from './config.js';
import { TitleGroup, TitleKinds } from './titles.js';

type WiiURootInspection = {
    normalizedRoot: string;
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
};

let libraryGroups: TitleGroup[] = [];

export function setLibraryCacheGroups(groups: TitleGroup[]): void {
    libraryGroups = groups;
}

export function readWiiURoots(
    config: Record<string, unknown>,
    options: { useDefaultIfEmpty?: boolean } = {}
): string[] {
    const roots: string[] = [];
    const hasConfiguredRoots = 'wiiuRoots' in config;

    if (Array.isArray(config.wiiuRoots)) {
        for (const root of config.wiiuRoots) {
            if (typeof root !== 'string') {
                continue;
            }

            const trimmedRoot = root.trim();
            if (trimmedRoot.length > 0) {
                roots.push(normalizeWiiURoot(trimmedRoot));
            }
        }
    } else if (typeof config.wiiuRoots === 'string') {
        const trimmedRoot = config.wiiuRoots.trim();

        if (trimmedRoot.length > 0) {
            roots.push(normalizeWiiURoot(trimmedRoot));
        }
    }

    if (
        roots.length === 0 &&
        options.useDefaultIfEmpty &&
        !hasConfiguredRoots
    ) {
        roots.push(DEFAULT_ROM_DIR);
    }

    return [...new Set(roots)];
}

function normalizeWiiURoot(root: string): string {
    const resolvedRoot = path.resolve(root.trim());

    try {
        return fs.realpathSync.native(resolvedRoot);
    } catch {
        return resolvedRoot;
    }
}

async function inspectWiiURoot(root: string): Promise<WiiURootInspection> {
    const normalizedRoot = normalizeWiiURoot(root);

    try {
        const stats = await fs.promises.stat(normalizedRoot);
        if (!stats.isDirectory()) {
            return {
                normalizedRoot,
                exists: true,
                isDirectory: false,
                readable: false,
            };
        }

        try {
            await fs.promises.access(normalizedRoot, fs.constants.R_OK);
            return {
                normalizedRoot,
                exists: true,
                isDirectory: true,
                readable: true,
            };
        } catch {
            return {
                normalizedRoot,
                exists: true,
                isDirectory: true,
                readable: false,
            };
        }
    } catch (error) {
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return {
                normalizedRoot,
                exists: false,
                isDirectory: false,
                readable: false,
            };
        }

        throw error;
    }
}

export async function validateWiiURoot(root: string): Promise<{
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    message: string;
}> {
    const normalizedRoot = root.trim();

    if (normalizedRoot.length === 0) {
        return {
            exists: false,
            isDirectory: false,
            readable: false,
            message: 'Path is empty.',
        };
    }

    const inspection = await inspectWiiURoot(normalizedRoot);

    if (!inspection.exists) {
        return {
            exists: false,
            isDirectory: false,
            readable: false,
            message: 'Path does not exist.',
        };
    }

    if (!inspection.isDirectory) {
        return {
            exists: true,
            isDirectory: false,
            readable: false,
            message: 'Path exists but is not a directory.',
        };
    }

    return {
        exists: true,
        isDirectory: true,
        readable: inspection.readable,
        message: inspection.readable
            ? 'Path exists and is readable.'
            : 'Directory exists but is not readable.',
    };
}

export function getLibraryCacheEntry(
    titleId: string
): { name: string; kind: TitleKinds | null } | null {
    const normalized = titleId.toLowerCase();
    const family = normalized.slice(8);
    const group = libraryGroups.find((g) => g.family === family);
    if (!group || !group.name) {
        return null;
    }
    const kind =
        group.entries.find((e) => e.titleId.toLowerCase() === normalized)
            ?.kind ?? null;
    return { name: group.name, kind };
}
