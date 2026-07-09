import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function getUserAppRoot(): string {
    return path.join(os.homedir(), '.romrack');
}

export function getAppRoot(): string {
    const appRoot = process.env.APP_ROOT;
    if (appRoot && appRoot.length > 0) {
        return path.resolve(appRoot);
    }

    const dir = path.dirname(fileURLToPath(import.meta.url));
    if (path.basename(dir) === 'server') {
        return path.resolve(dir, '..');
    }

    return process.cwd();
}
