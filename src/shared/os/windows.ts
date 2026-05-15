import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import path from 'node:path';

import type { Fat32Volume, OsOperations } from './types.js';
import { isWindowsPath, normalizePath } from './path.js';
import { toArray } from '../shared.js';
import { nullableNumber, nullableString } from '../value.js';

const execFileAsync = promisify(execFile);

type WindowsVolume = {
    DriveLetter?: unknown;
    FileSystemLabel?: unknown;
    FileSystem?: unknown;
    DriveType?: unknown;
    HealthStatus?: unknown;
    Size?: unknown;
    SizeRemaining?: unknown;
};

function getDriveRoot(driveLetter: string | null): string | null {
    return driveLetter ? `${driveLetter}:\\` : null;
}

export function normalizeWindowsPath(value: string): string {
    return path.win32.normalize(value.trim());
}

export { isWindowsPath };

function parseWindowsVolume(value: unknown): Fat32Volume | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const volume = value as WindowsVolume;
    if (volume.FileSystem !== 'FAT32') {
        return null;
    }

    const driveLetter = nullableString(volume.DriveLetter);
    const path = getDriveRoot(driveLetter);
    if (!path) {
        return null;
    }

    return {
        label: nullableString(volume.FileSystemLabel),
        fileSystem: 'FAT32',
        source: path,
        sizeBytes: nullableNumber(volume.Size),
        freeBytes: nullableNumber(volume.SizeRemaining),
    };
}

export function parseWindowsFat32Volumes(stdout: string): Fat32Volume[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    const parsed = JSON.parse(trimmed) as unknown;
    return toArray(parsed)
        .map(parseWindowsVolume)
        .filter((volume): volume is Fat32Volume => volume !== null);
}

export async function listMountedFat32Volumes(): Promise<Fat32Volume[]> {
    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
            'Get-Volume',
            "Where-Object FileSystem -eq 'FAT32'",
            'Select-Object DriveLetter,FileSystemLabel,FileSystem,DriveType,HealthStatus,Size,SizeRemaining',
            'ConvertTo-Json -Compress',
        ].join(' | '),
    ]);

    return parseWindowsFat32Volumes(stdout);
}

export const listFat32Volumes = listMountedFat32Volumes;

export function appendWindowsSubpath(root: string, subpath: string): string {
    return path.win32.join(
        normalizeWindowsPath(normalizePath(root) ?? root),
        normalizeWindowsPath(normalizePath(subpath) ?? subpath)
    );
}

export const windows: OsOperations = {
    listFat32Volumes,
};
