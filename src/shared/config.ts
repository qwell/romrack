import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getAppRoot, getUserAppRoot } from '../server/paths.js';
import logger from './logger.js';
import { isObject } from './shared.js';
import { readWiiURoots } from './wiiu.js';

export type AppConfig = {
    host: string;
    port: number;
    openBrowser: boolean;
    wiiuRoots: string[];
};

export type AppConfigUpdate = Partial<AppConfig>;

export type AppConfigResponse = {
    config: AppConfig;
    restartRequired: boolean;
};

export type AppConfigValidateRootResponse = {
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    message: string;
};

const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_BROWSER_OPEN = true;
export const DEFAULT_ROM_DIR = getUserAppRoot();

let currentConfig: AppConfig | null = null;
let currentConfigPath: string | null = null;

function getDefaultConfig(): AppConfig {
    return {
        host: DEFAULT_SERVER_HOST,
        port: DEFAULT_SERVER_PORT,
        openBrowser: DEFAULT_BROWSER_OPEN,
        wiiuRoots: [DEFAULT_ROM_DIR],
    };
}

export function saveConfig(update: AppConfigUpdate): {
    config: AppConfig;
    restartRequired: boolean;
} {
    const previous = getConfig();
    const next: AppConfig = {
        host: update.host ?? previous.host,
        port: update.port ?? previous.port,
        openBrowser: update.openBrowser ?? previous.openBrowser,
        wiiuRoots:
            update.wiiuRoots === undefined
                ? previous.wiiuRoots
                : readWiiURoots(update),
    };

    assertConfig(next);
    writeConfig(next);
    currentConfig = next;

    return {
        config: next,
        restartRequired:
            previous.host !== next.host || previous.port !== next.port,
    };
}

function getConfigPathCandidates(): string[] {
    return [
        path.join(process.cwd(), 'config.json'),
        path.join(getAppRoot(), 'config.json'),
        path.join(getUserAppRoot(), 'config.json'),
    ].filter((candidate, index, candidates) => {
        return candidates.indexOf(candidate) === index;
    });
}

function resolveConfigPath(): string {
    if (currentConfigPath) {
        return currentConfigPath;
    }

    const existingPath = getConfigPathCandidates().find((candidate) =>
        fs.existsSync(candidate)
    );

    currentConfigPath =
        existingPath ?? path.join(getUserAppRoot(), 'config.json');

    return currentConfigPath;
}

export function writeConfigFile(configPath: string, contents: string): void {
    const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, contents);
    fs.renameSync(tempPath, configPath);
}

function writeDefaultConfig(): void {
    const configPath = resolveConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigFile(
        configPath,
        `${JSON.stringify(getDefaultConfig(), null, 4)}\n`
    );
    logger.log('server', `Created config at ${configPath}`);
}

export function writeConfig(config: AppConfig): void {
    const configPath = resolveConfigPath();
    writeConfigFile(configPath, `${JSON.stringify(config, null, 4)}\n`);
    logger.log('server', `Saved config to ${configPath}`);
}

function loadConfig(): AppConfig {
    if (currentConfig) {
        return currentConfig;
    }

    const configPath = resolveConfigPath();

    if (!fs.existsSync(configPath)) {
        writeDefaultConfig();
    }

    logger.log('server', `Loaded config from ${configPath}`);

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    assertConfig(parsed);

    currentConfig = {
        ...parsed,
        host: parsed.host ?? DEFAULT_SERVER_HOST,
        port: parsed.port ?? DEFAULT_SERVER_PORT,
        openBrowser: parsed.openBrowser ?? DEFAULT_BROWSER_OPEN,
        wiiuRoots: readWiiURoots(parsed, { useDefaultIfEmpty: true }),
    };

    return currentConfig;
}

export function getConfig(): AppConfig {
    return currentConfig ?? loadConfig();
}

export function assertConfig(value: unknown): asserts value is AppConfig {
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
        (typeof value.port !== 'number' ||
            !Number.isInteger(value.port) ||
            value.port < 1 ||
            value.port > 65535)
    ) {
        throw new Error('Config.port must be an integer between 1 and 65535.');
    }

    if ('openBrowser' in value && typeof value.openBrowser !== 'boolean') {
        throw new Error('Config.openBrowser must be a boolean.');
    }

    if (
        'wiiuRoots' in value &&
        !(
            (Array.isArray(value.wiiuRoots) &&
                value.wiiuRoots.every(
                    (root) => typeof root === 'string' && root.length > 0
                )) ||
            (typeof value.wiiuRoots === 'string' && value.wiiuRoots.length > 0)
        )
    ) {
        throw new Error(
            'Config.wiiuRoots must be a non-empty string or an array of non-empty strings.'
        );
    }
}
