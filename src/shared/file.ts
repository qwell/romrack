import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

import { mapConcurrent } from './shared.js';

const DIRECTORY_SIZE_CONCURRENCY = 8;

export async function getImmediatePathSizeBytes(
    targetPath: string
): Promise<number> {
    const info = await stat(targetPath);

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
                const childInfo = await stat(path.join(targetPath, entry.name));
                return childInfo.size;
            } catch {
                return 0;
            }
        }
    );

    return sizes.reduce((total, size) => total + size, 0);
}
