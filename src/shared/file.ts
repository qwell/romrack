import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';

import { mapConcurrent } from './utils.js';

const DIRECTORY_SIZE_CONCURRENCY = 8;

export type PathStats = {
    sizeBytes: number;
    fileCount: number;
};

export type PathFileSize = {
    relativePath: string;
    sizeBytes: number;
};

export async function assertReadableDirectory(root: string): Promise<void> {
    const info = await lstat(root);
    if (!info.isDirectory()) {
        throw new Error(`not a directory: ${root}`);
    }
}

export async function readOptionalFile(
    filePath: string
): Promise<Buffer | null> {
    try {
        return await readFile(filePath);
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return null;
        }
        throw error;
    }
}

export function isFileNotFoundError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function isSameOrNestedPath(left: string, right: string): boolean {
    const root = path.resolve(left);
    let current = path.resolve(right);

    for (;;) {
        if (current === root) {
            return true;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return false;
        }

        current = parent;
    }
}

export async function getImmediatePathSizeBytes(
    targetPath: string
): Promise<number> {
    const info = await lstat(targetPath);

    if (info.isFile()) {
        return info.size;
    }

    if (!info.isDirectory()) {
        return 0;
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const sizes = await mapConcurrent(
        entries.filter((entry) => entry.isFile()),
        DIRECTORY_SIZE_CONCURRENCY,
        async (entry) => {
            try {
                const childInfo = await lstat(
                    path.join(targetPath, entry.name)
                );
                return childInfo.size;
            } catch {
                return 0;
            }
        }
    );

    return sizes.reduce((total, size) => total + size, 0);
}

export async function getPathStats(targetPath: string): Promise<PathStats> {
    const info = await lstat(targetPath);

    if (info.isFile()) {
        return {
            sizeBytes: info.size,
            fileCount: 1,
        };
    }

    if (!info.isDirectory()) {
        return {
            sizeBytes: 0,
            fileCount: 0,
        };
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const stats = await mapConcurrent(
        entries,
        DIRECTORY_SIZE_CONCURRENCY,
        async (entry) => getPathStats(path.join(targetPath, entry.name))
    );

    return stats.reduce(
        (total, next) => ({
            sizeBytes: total.sizeBytes + next.sizeBytes,
            fileCount: total.fileCount + next.fileCount,
        }),
        {
            sizeBytes: 0,
            fileCount: 0,
        }
    );
}

export async function getPathFileSizes(
    targetPath: string
): Promise<PathFileSize[]> {
    const info = await lstat(targetPath);
    const root = info.isDirectory() ? targetPath : path.dirname(targetPath);
    return collectPathFileSizes(root, targetPath);
}

async function collectPathFileSizes(
    rootPath: string,
    targetPath: string
): Promise<PathFileSize[]> {
    const info = await lstat(targetPath);

    if (info.isFile()) {
        const relativePath = path.relative(rootPath, targetPath);
        return [
            {
                relativePath: relativePath || path.basename(targetPath),
                sizeBytes: info.size,
            },
        ];
    }

    if (!info.isDirectory()) {
        return [];
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const sizes = await mapConcurrent(
        entries,
        DIRECTORY_SIZE_CONCURRENCY,
        async (entry) =>
            collectPathFileSizes(rootPath, path.join(targetPath, entry.name))
    );

    return sizes.flat();
}
