import path from 'path';
import fs from 'fs';

import { resolveReadablePath } from './os.js';
import { isWindowsPath } from './os/path.js';

type LibraryRootInspection = {
    normalizedRoot: string;
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
};

function readConfiguredRoots(
    config: Record<string, unknown>,
    key: string,
    options: { defaultRoot?: string } = {}
): string[] {
    const roots: string[] = [];
    const hasConfiguredRoots = key in config;
    const configuredRoots = config[key];

    if (Array.isArray(configuredRoots)) {
        for (const root of configuredRoots) {
            if (typeof root !== 'string') {
                continue;
            }

            const trimmedRoot = root.trim();
            if (trimmedRoot.length > 0) {
                roots.push(normalizeLibraryRoot(trimmedRoot));
            }
        }
    } else if (typeof configuredRoots === 'string') {
        const trimmedRoot = configuredRoots.trim();

        if (trimmedRoot.length > 0) {
            roots.push(normalizeLibraryRoot(trimmedRoot));
        }
    }

    if (
        roots.length === 0 &&
        options.defaultRoot !== undefined &&
        !hasConfiguredRoots
    ) {
        roots.push(options.defaultRoot);
    }

    return [...new Set(roots)];
}

export function readWiiURoots(
    config: Record<string, unknown>,
    options: { defaultRoot?: string } = {}
): string[] {
    return readConfiguredRoots(config, 'wiiuRoots', options);
}

export function readWiiRoots(
    config: Record<string, unknown>,
    options: { defaultRoot?: string } = {}
): string[] {
    return readConfiguredRoots(config, 'wiiRoots', options);
}

function normalizeLibraryRoot(root: string): string {
    if (process.platform !== 'win32' && isWindowsPath(root)) {
        return root.trim();
    }

    const resolvedRoot = path.resolve(root.trim());

    try {
        return fs.realpathSync.native(resolvedRoot);
    } catch {
        return resolvedRoot;
    }
}

async function inspectLibraryRoot(
    root: string
): Promise<LibraryRootInspection> {
    const normalizedRoot = normalizeLibraryRoot(root);
    const readableRoot = await resolveReadablePath(normalizedRoot);

    try {
        const stats = await fs.promises.stat(readableRoot);
        if (!stats.isDirectory()) {
            return {
                normalizedRoot,
                exists: true,
                isDirectory: false,
                readable: false,
            };
        }

        try {
            await fs.promises.access(readableRoot, fs.constants.R_OK);
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

export async function validateLibraryRoot(root: string): Promise<{
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

    const inspection = await inspectLibraryRoot(normalizedRoot);

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
