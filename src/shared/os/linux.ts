import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { type Fat32Volume, type OsOperations } from './types.js';
import { isSameOrNestedPath } from '../file.js';

const execFileAsync = promisify(execFile);

export type LinuxMount = {
    source: string;
    target: string;
    fileSystem: string;
    options: string;
};

type FindmntFileSystem = {
    target?: unknown;
    fstype?: unknown;
    source?: unknown;
    options?: unknown;
    children?: unknown;
};

function decodeMountValue(value: string): string {
    return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8))
    );
}

function parseLinuxMountLine(line: string): LinuxMount | null {
    const [source, mountPath, fileSystem, options] = line.split(' ');
    if (!source || !mountPath || !fileSystem) {
        return null;
    }

    return {
        source: decodeMountValue(source),
        target: decodeMountValue(mountPath),
        fileSystem,
        options: options ? decodeMountValue(options) : '',
    };
}

function flattenFindmntFileSystems(value: unknown): FindmntFileSystem[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const output: FindmntFileSystem[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const fileSystem = item as FindmntFileSystem;
        output.push(fileSystem);
        output.push(...flattenFindmntFileSystems(fileSystem.children));
    }
    return output;
}

function parseFindmntJson(stdout: string): LinuxMount[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    const parsed = JSON.parse(trimmed) as { filesystems?: unknown };
    return flattenFindmntFileSystems(parsed.filesystems)
        .map((fileSystem): LinuxMount | null => {
            if (
                typeof fileSystem.target !== 'string' ||
                typeof fileSystem.fstype !== 'string'
            ) {
                return null;
            }

            return {
                target: fileSystem.target,
                fileSystem: fileSystem.fstype,
                source:
                    typeof fileSystem.source === 'string'
                        ? fileSystem.source
                        : '',
                options:
                    typeof fileSystem.options === 'string'
                        ? fileSystem.options
                        : '',
            };
        })
        .filter((mount): mount is LinuxMount => mount !== null);
}

async function listProcMounts(): Promise<LinuxMount[]> {
    const text = await readFile('/proc/self/mounts', 'utf8');
    return text
        .split('\n')
        .map(parseLinuxMountLine)
        .filter((mount): mount is LinuxMount => mount !== null);
}

export async function listMounts(): Promise<LinuxMount[]> {
    try {
        const { stdout } = await execFileAsync('findmnt', [
            '-J',
            '-o',
            'TARGET,FSTYPE,SOURCE,OPTIONS',
        ]);
        return parseFindmntJson(stdout);
    } catch {
        return listProcMounts();
    }
}

export async function findMountForPath(
    targetPath: string
): Promise<LinuxMount | null> {
    try {
        const { stdout } = await execFileAsync('findmnt', [
            '-T',
            targetPath,
            '-J',
            '-o',
            'TARGET,FSTYPE,SOURCE,OPTIONS',
        ]);
        return parseFindmntJson(stdout)[0] ?? null;
    } catch {
        const mounts = await listMounts();
        const resolvedTargetPath = path.resolve(targetPath);
        const sorted = mounts
            .filter((mount) =>
                isSameOrNestedPath(
                    path.resolve(mount.target),
                    resolvedTargetPath
                )
            )
            .sort((a, b) => b.target.length - a.target.length);
        return sorted[0] ?? null;
    }
}

async function getMountSize(path: string): Promise<{
    sizeBytes: number | null;
    freeBytes: number | null;
}> {
    try {
        const stats = await statfs(path);
        return {
            sizeBytes: stats.blocks * stats.bsize,
            freeBytes: stats.bavail * stats.bsize,
        };
    } catch {
        return {
            sizeBytes: null,
            freeBytes: null,
        };
    }
}

export async function listFat32Volumes(): Promise<Fat32Volume[]> {
    const mounts = (await listMounts()).filter(
        (mount) => mount.fileSystem === 'vfat'
    );

    const volumes: Fat32Volume[] = [];
    for (const mount of mounts) {
        const size = await getMountSize(mount.target);
        volumes.push({
            label: null,
            fileSystem: 'FAT32',
            source: mount.target,
            sizeBytes: size.sizeBytes,
            freeBytes: size.freeBytes,
        });
    }

    return volumes;
}

export const linux: OsOperations = {
    listFat32Volumes,
};
