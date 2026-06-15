import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
    type ConfigResponse,
    type ConfigValidateRootResponse,
} from '../../shared/api.js';
import { type AppConfig, type AppConfigUpdate } from '../../shared/config.js';
import { validateWiiURoot } from '../../shared/wiiu.js';
import logger from '../../shared/logger.js';
import { formatLogError, isObject } from '../../shared/shared.js';
import { getStringBodyField, sendServerError } from '../request.js';
import { getAppRoot, getUserAppRoot } from '../paths.js';
import { readWiiURoots } from '../../shared/wiiu.js';

const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_BROWSER_OPEN = true;
const DEFAULT_ROM_DIR = getUserAppRoot();

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

function assertConfigValues(
    value: unknown
): asserts value is Record<string, unknown> {
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

function writeConfigFile(configPath: string, contents: string): void {
    const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, contents);
    fs.renameSync(tempPath, configPath);
}

function writeConfig(config: AppConfig): void {
    const configPath = resolveConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigFile(configPath, `${JSON.stringify(config, null, 4)}\n`);
    logger.log('server', `Saved config to ${configPath}`);
}

function loadConfig(): AppConfig {
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
        const defaults = getDefaultConfig();
        writeConfig(defaults);
        logger.log('server', `Created config at ${configPath}`);
        return defaults;
    }

    logger.log('server', `Loaded config from ${configPath}`);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    assertConfigValues(parsed);

    return {
        host:
            typeof parsed.host === 'string' ? parsed.host : DEFAULT_SERVER_HOST,
        port:
            typeof parsed.port === 'number' ? parsed.port : DEFAULT_SERVER_PORT,
        openBrowser:
            typeof parsed.openBrowser === 'boolean'
                ? parsed.openBrowser
                : DEFAULT_BROWSER_OPEN,
        wiiuRoots: readWiiURoots(parsed, { defaultRoot: DEFAULT_ROM_DIR }),
    };
}

export function getConfig(): AppConfig {
    currentConfig ??= loadConfig();
    return currentConfig;
}

export function saveConfig(update: AppConfigUpdate): ConfigResponse {
    assertConfigValues(update);
    const previous = getConfig();
    const next: AppConfig = {
        host: typeof update.host === 'string' ? update.host : previous.host,
        port: typeof update.port === 'number' ? update.port : previous.port,
        openBrowser:
            typeof update.openBrowser === 'boolean'
                ? update.openBrowser
                : previous.openBrowser,
        wiiuRoots:
            update.wiiuRoots === undefined
                ? previous.wiiuRoots
                : readWiiURoots(update),
    };

    writeConfig(next);
    currentConfig = next;
    return {
        config: next,
        restartRequired:
            previous.host !== next.host || previous.port !== next.port,
    };
}

export function createConfigRouter(): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        const response: ConfigResponse = {
            config: getConfig(),
            restartRequired: false,
        };
        logger.log('server', `config loaded: ${JSON.stringify(response)}`);
        res.json(response);
    });

    router.post('/validate-root', async (req, res) => {
        try {
            const root = getStringBodyField(req.body as unknown, 'root');
            const response: ConfigValidateRootResponse =
                await validateWiiURoot(root);
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to validate Wii U root: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to validate Wii U root', error, {
                includeDetails: true,
            });
        }
    });

    router.post('/', (req, res) => {
        try {
            const response: ConfigResponse = saveConfig(
                req.body as AppConfigUpdate
            );
            logger.log('server', `config saved: ${JSON.stringify(response)}`);
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to save config: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to save config', error, {
                includeDetails: true,
            });
        }
    });

    return router;
}
