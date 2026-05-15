import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { type Fat32Volume, type OsOperations } from './types.js';
import * as linux from './linux.js';
import * as windows from './windows.js';

const execFileAsync = promisify(execFile);

export type WslPathInspection = {
    path: string | null;
    windowsPath: string | null;
    windowsBacked: boolean;
    mountTarget: string | null;
    fileSystem: string | null;
};

export async function isWsl2(): Promise<boolean> {
    if (os.platform() !== 'linux') {
        return false;
    }

    try {
        const version = await readFile('/proc/version', 'utf8');
        return /microsoft/i.test(version);
    } catch {
        return false;
    }
}

function parseOptions(options: string): Map<string, string> {
    const parsed = new Map<string, string>();
    for (const option of options.split(',')) {
        const [key, ...valueParts] = option.split('=');
        if (!key) {
            continue;
        }
        parsed.set(key, valueParts.join('='));
    }
    return parsed;
}

function isWindowsBackedMount(mount: linux.LinuxMount): boolean {
    return (
        mount.fileSystem === 'drvfs' ||
        (mount.fileSystem === '9p' &&
            parseOptions(mount.options).get('aname') === 'drvfs')
    );
}

function getMountWindowsPath(mount: linux.LinuxMount): string | null {
    return (
        normalizeWindowsDriveRoot(mount.source) ??
        normalizeWindowsDriveRoot(
            parseOptions(mount.options).get('path') ?? null
        )
    );
}

function normalizeWindowsDriveRoot(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const match = /^([A-Z]):[\\/]?$/i.exec(value.trim());
    return match ? `${match[1].toUpperCase()}:\\` : null;
}

function getRelativeWindowsPath(
    sourcePath: string,
    mount: linux.LinuxMount
): string {
    const relative = path.posix.relative(mount.target, sourcePath);
    return relative === '' ? '' : path.win32.join(...relative.split('/'));
}

async function wslpath(args: string[]): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('wslpath', args);
        const converted = stdout.trim();
        return converted.length > 0 ? converted : null;
    } catch {
        return null;
    }
}

async function getMountedWindowsPath(windowsPath: string): Promise<{
    path: string;
    mountTarget: string;
    fileSystem: string;
} | null> {
    const normalizedPath = windows.normalizeWindowsPath(windowsPath);
    const root = normalizeWindowsDriveRoot(
        path.win32.parse(normalizedPath).root
    );
    if (!root) {
        return null;
    }

    const mount =
        (await linux.listMounts()).find(
            (candidate) =>
                isWindowsBackedMount(candidate) &&
                getMountWindowsPath(candidate) === root
        ) ?? null;
    if (!mount) {
        return null;
    }

    const relativePath = path.win32.relative(root, normalizedPath);
    return {
        path: relativePath
            ? path.posix.join(mount.target, ...relativePath.split(/[\\/]+/))
            : mount.target,
        mountTarget: mount.target,
        fileSystem: mount.fileSystem,
    };
}

function mergeVolumes(
    linuxVolume: Fat32Volume,
    windowsVolume: Fat32Volume
): Fat32Volume {
    return {
        ...linuxVolume,
        label: windowsVolume.label ?? linuxVolume.label,
        sizeBytes: windowsVolume.sizeBytes ?? linuxVolume.sizeBytes,
        freeBytes: windowsVolume.freeBytes ?? linuxVolume.freeBytes,
    };
}

export async function listMountedFat32Volumes(): Promise<Fat32Volume[]> {
    const [linuxVolumes, windowsVolumes, wslMounts] = await Promise.all([
        linux.listFat32Volumes(),
        windows.listFat32Volumes(),
        linux.listMounts(),
    ]);
    const windowsMounts = wslMounts.filter(isWindowsBackedMount);

    const byLinuxSource = new Map<string, Fat32Volume>();
    const byWindowsPath = new Map<string, Fat32Volume>();

    for (const volume of linuxVolumes) {
        byLinuxSource.set(volume.source, volume);
    }

    for (const volume of windowsVolumes) {
        const normalizedWindowsPath = normalizeWindowsDriveRoot(volume.source);
        if (!normalizedWindowsPath) {
            continue;
        }

        const matchedMount =
            windowsMounts.find(
                (mount) => getMountWindowsPath(mount) === normalizedWindowsPath
            ) ?? null;
        const mountedPath = matchedMount?.target ?? null;
        const existing =
            mountedPath !== null
                ? (byLinuxSource.get(mountedPath) ?? null)
                : null;
        const next: Fat32Volume = {
            ...volume,
            source: mountedPath ?? normalizedWindowsPath,
        };

        const merged = existing ? mergeVolumes(existing, next) : next;
        if (mountedPath) {
            byLinuxSource.set(mountedPath, merged);
        }
        byWindowsPath.set(normalizedWindowsPath, merged);
    }

    return [
        ...byLinuxSource.values(),
        ...[...byWindowsPath.values()].filter((volume) =>
            windows.isWindowsPath(volume.source)
        ),
    ];
}

export async function inspectWslPath(
    sourcePath: string
): Promise<WslPathInspection> {
    if (windows.isWindowsPath(sourcePath)) {
        const convertedPath = await wslpath(['-u', sourcePath]);
        const mountedPath =
            convertedPath === null
                ? await getMountedWindowsPath(sourcePath)
                : null;

        return {
            path: convertedPath ?? mountedPath?.path ?? null,
            windowsPath: sourcePath.trim(),
            windowsBacked: true,
            mountTarget: mountedPath?.mountTarget ?? null,
            fileSystem: mountedPath?.fileSystem ?? null,
        };
    }

    const mount = await linux.findMountForPath(sourcePath);
    if (!mount || !isWindowsBackedMount(mount)) {
        return {
            path: sourcePath,
            windowsPath: null,
            windowsBacked: false,
            mountTarget: mount?.target ?? null,
            fileSystem: mount?.fileSystem ?? null,
        };
    }

    const mountWindowsPath = getMountWindowsPath(mount);
    const windowsPath = mountWindowsPath
        ? windows.appendWindowsSubpath(
              mountWindowsPath,
              getRelativeWindowsPath(sourcePath, mount)
          )
        : await wslpath(['-w', sourcePath]);

    return {
        path: sourcePath,
        windowsPath,
        windowsBacked: true,
        mountTarget: mount.target,
        fileSystem: mount.fileSystem,
    };
}

export const listFat32Volumes = listMountedFat32Volumes;

export const wsl2: OsOperations = {
    listFat32Volumes,
};
