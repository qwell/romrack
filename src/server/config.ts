import fs from 'node:fs';
import path from 'node:path';

import { getUserAppRoot } from './paths.js';
import logger from '../shared/logger.js';

const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_BROWSER_OPEN = true;
const DEFAULT_ROM_DIR = getUserAppRoot();

type ServerConfig = {
    host: string;
    port: number;
    openBrowser: boolean;
    wiiuRoots: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function assertConfig(value: unknown): asserts value is ServerConfig {
    if (!isObject(value)) {
        throw new Error('Config must be an object.');
    }

    if (
        'host' in value &&
        (typeof value.host !== 'string' || value.host.length === 0)
    ) {
        throw new Error('Config.host must be a non-empty string.');
    }

    if (
        'port' in value &&
        (typeof value.port !== 'number' || !Number.isInteger(value.port))
    ) {
        throw new Error('Config.port must be an integer.');
    }

    if ('openBrowser' in value && typeof value.openBrowser !== 'boolean') {
        throw new Error('Config.openBrowser must be a boolean.');
    }

    if (
        'wiiuRoots' in value &&
        (!Array.isArray(value.wiiuRoots) ||
            !value.wiiuRoots.every(
                (root) => typeof root === 'string' && root.length > 0
            ))
    ) {
        throw new Error(
            'Config.wiiuRoots must be an array of non-empty strings.'
        );
    }
}

function readWiiURoots(config: Record<string, unknown>): string[] {
    const roots: string[] = [];

    if (Array.isArray(config.wiiuRoots)) {
        roots.push(
            ...config.wiiuRoots.filter(
                (root): root is string => typeof root === 'string'
            )
        );
    }

    if (roots.length === 0) {
        roots.push(DEFAULT_ROM_DIR);
    }

    return [...new Set(roots)];
}

function getDefaultConfig(): ServerConfig {
    return {
        host: DEFAULT_SERVER_HOST,
        port: DEFAULT_SERVER_PORT,
        openBrowser: DEFAULT_BROWSER_OPEN,
        wiiuRoots: [DEFAULT_ROM_DIR],
    };
}

function writeDefaultConfig(configPath: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
        configPath,
        `${JSON.stringify(getDefaultConfig(), null, 4)}\n`
    );
    logger.log('server', `Created config at ${configPath}`);
}

export function loadConfig(): ServerConfig {
    const configPath = path.join(getUserAppRoot(), 'config.json');

    if (!fs.existsSync(configPath)) {
        writeDefaultConfig(configPath);
    }

    logger.log('server', `Loaded config from ${configPath}`);

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    assertConfig(parsed);

    return {
        ...parsed,
        host: parsed.host ?? DEFAULT_SERVER_HOST,
        port: parsed.port ?? DEFAULT_SERVER_PORT,
        openBrowser: parsed.openBrowser ?? DEFAULT_BROWSER_OPEN,
        wiiuRoots: readWiiURoots(parsed),
    };
}
