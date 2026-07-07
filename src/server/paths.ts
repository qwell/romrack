import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export function getUserAppRoot(): string {
    return path.join(os.homedir(), '.romrack');
}

export function getAppRoot(): string {
    const appRoot = process.env.APP_ROOT;
    if (appRoot && appRoot.length > 0) {
        return path.resolve(appRoot);
    }

    return process.cwd();
}
