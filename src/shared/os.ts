import os from 'node:os';

import { linux } from './os/linux.js';
import { macos } from './os/macos.js';
import { windows } from './os/windows.js';
import { inspectWslPath, wsl2, isWsl2 } from './os/wsl2.js';
import { normalizePath, resolveStorageDestination } from './os/path.js';
import type { Fat32Volume, OsOperations } from './os/types.js';

export type { Fat32Volume, OsOperations } from './os/types.js';

export type RuntimeOs = 'windows' | 'linux' | 'wsl2' | 'macos' | 'unsupported';

let runtimeOperationsPromise: Promise<OsOperations | null> | null = null;

export function resolveFat32Destination(
    volumes: Fat32Volume[],
    destination: string | null
): Fat32Volume | null {
    if (!destination) {
        return volumes[0] ?? null;
    }

    for (const volume of volumes) {
        const resolved = resolveStorageDestination(volume, destination);
        if (resolved) {
            return resolved;
        }
    }

    return null;
}

export async function getRuntimeOs(): Promise<RuntimeOs> {
    if (await isWsl2()) {
        return 'wsl2';
    }

    switch (os.platform()) {
        case 'win32':
            return 'windows';
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'macos';
        default:
            return 'unsupported';
    }
}

function getRuntimeOperations(): Promise<OsOperations | null> {
    runtimeOperationsPromise ??= resolveRuntimeOperations();
    return runtimeOperationsPromise;
}

export async function listFat32Volumes(): Promise<Fat32Volume[]> {
    const operations = await getRuntimeOperations();
    return operations ? await operations.listFat32Volumes() : [];
}

async function resolveRuntimeOperations(): Promise<OsOperations | null> {
    switch (await getRuntimeOs()) {
        case 'windows':
            return windows;
        case 'linux':
            return linux;
        case 'wsl2':
            return wsl2;
        case 'macos':
            return macos;
        case 'unsupported':
            return null;
    }
}

export async function resolveReadablePath(targetPath: string): Promise<string> {
    if ((await getRuntimeOs()) !== 'wsl2') {
        return targetPath;
    }

    const inspected = await inspectWslPath(targetPath);
    if (!inspected.path) {
        throw new Error(`Path is not accessible from WSL: ${targetPath}`);
    }

    return inspected.path;
}

export const runtimeOs = {
    getRuntimeOs,
    listFat32Volumes,
    resolveReadablePath,
    resolveFat32Destination,
};
