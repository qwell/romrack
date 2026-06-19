import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type Fat32Volume, type OsOperations } from './types.js';
import { nullableNumber, nullableString, toArray } from '../utils.js';

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

export function parseWindowsDriveRoot(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const match = /^([A-Z]):[\\/]?$/i.exec(value.trim());
    return match ? `${match[1].toUpperCase()}:\\` : null;
}

export async function listFat32Volumes(): Promise<Fat32Volume[]> {
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

export const windows: OsOperations = {
    listFat32Volumes,
};
