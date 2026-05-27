import path from 'path';
import fs from 'fs';

import { DEFAULT_ROM_DIR } from './config.js';
import { resolveReadablePath } from './os.js';
import { isWindowsPath } from './os/path.js';

type WiiURootInspection = {
    normalizedRoot: string;
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
};

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

async function inspectWiiURoot(root: string): Promise<WiiURootInspection> {
    const normalizedRoot = normalizeWiiURoot(root);
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
