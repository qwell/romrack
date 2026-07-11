import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
    type ConfigResponse,
    type ConfigValidateRootResponse,
} from '../../shared/api.js';
import { type AppConfig, type AppConfigUpdate } from '../../shared/config.js';
import logger from '../../shared/logger.js';
import { resolveReadablePath } from '../../shared/os.js';
import { isWindowsPath } from '../../shared/os/path.js';
import { formatLogError, isObject } from '../../shared/utils.js';
import { isFileNotFoundError } from '../../shared/file.js';
import { getStringBodyField, sendServerError } from '../request.js';
import { getAppRoot, getUserAppRoot } from '../paths.js';

const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_BROWSER_OPEN = true;
const DEFAULT_ROM_DIR = getUserAppRoot();

let currentConfig: AppConfig | null = null;
let currentConfigPath: string | null = null;

type LibraryRootInspection = {
    normalizedRoot: string;
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
};

function readConfigValue(
    config: Record<string, unknown>,
    key: string
): unknown {
    const normalizedKey = key.toLowerCase();
    const entry = Object.entries(config).find(
        ([candidate]) => candidate.toLowerCase() === normalizedKey
    );
    return entry?.[1];
}

function hasConfigValue(config: Record<string, unknown>, key: string): boolean {
    const normalizedKey = key.toLowerCase();
    return Object.keys(config).some(
        (candidate) => candidate.toLowerCase() === normalizedKey
    );
}

function getDefaultConfig(): AppConfig {
    return {
        host: DEFAULT_SERVER_HOST,
        port: DEFAULT_SERVER_PORT,
        openBrowser: DEFAULT_BROWSER_OPEN,
        '3dsRoots': [DEFAULT_ROM_DIR],
        wiiRoots: [DEFAULT_ROM_DIR],
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
        hasConfigValue(value, 'host') &&
        (typeof readConfigValue(value, 'host') !== 'string' ||
            (readConfigValue(value, 'host') as string).length === 0)
    ) {
        throw new Error('Config.host must be a non-empty string.');
    }

    const port = readConfigValue(value, 'port');
    if (
        hasConfigValue(value, 'port') &&
        (typeof port !== 'number' ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535)
    ) {
        throw new Error('Config.port must be an integer between 1 and 65535.');
    }

    if (
        hasConfigValue(value, 'openBrowser') &&
        typeof readConfigValue(value, 'openBrowser') !== 'boolean'
    ) {
        throw new Error('Config.openBrowser must be a boolean.');
    }

    for (const key of ['3dsRoots', 'wiiRoots', 'wiiuRoots']) {
        const roots = readConfigValue(value, key);
        if (
            hasConfigValue(value, key) &&
            !(
                (Array.isArray(roots) &&
                    roots.every(
                        (root) => typeof root === 'string' && root.length > 0
                    )) ||
                (typeof roots === 'string' && roots.length > 0)
            )
        ) {
            throw new Error(
                `Config.${key} must be a non-empty string or an array of non-empty strings.`
            );
        }
    }
}

function readConfiguredRoots(
    config: Record<string, unknown>,
    key: string,
    options: { defaultRoot?: string } = {}
): string[] {
    const roots: string[] = [];
    const hasConfiguredRoots = hasConfigValue(config, key);
    const configuredRoots = readConfigValue(config, key);

    if (Array.isArray(configuredRoots)) {
        for (const root of configuredRoots) {
            if (typeof root !== 'string') {
                continue;
            }

            const trimmedRoot = root.trim();
            if (trimmedRoot.length > 0) {
                roots.push(normalizeLibraryRoot(trimmedRoot));
            }
        }
    } else if (typeof configuredRoots === 'string') {
        const trimmedRoot = configuredRoots.trim();

        if (trimmedRoot.length > 0) {
            roots.push(normalizeLibraryRoot(trimmedRoot));
        }
    }

    if (
        roots.length === 0 &&
        options.defaultRoot !== undefined &&
        !hasConfiguredRoots
    ) {
        roots.push(options.defaultRoot);
    }

    return [...new Set(roots)];
}

function readWiiURoots(
    config: Record<string, unknown>,
    options: { defaultRoot?: string } = {}
): string[] {
    return readConfiguredRoots(config, 'wiiuRoots', options);
}

function readThreeDSRoots(
    config: Record<string, unknown>,
    options: { defaultRoot?: string } = {}
): string[] {
    return readConfiguredRoots(config, '3dsRoots', options);
}

function readWiiRoots(
    config: Record<string, unknown>,
    options: { defaultRoot?: string } = {}
): string[] {
    return readConfiguredRoots(config, 'wiiRoots', options);
}

function normalizeLibraryRoot(root: string): string {
    if (process.platform !== 'win32' && isWindowsPath(root)) {
        return root.trim();
    }

    const resolvedRoot = path.resolve(root.trim());

    try {
        return fs.realpathSync.native(resolvedRoot);
    } catch {
        return resolvedRoot;
    }
}

async function inspectLibraryRoot(
    root: string
): Promise<LibraryRootInspection> {
    const normalizedRoot = normalizeLibraryRoot(root);
    const readableRoot = await resolveReadablePath(normalizedRoot);

    try {
        const stats = await fs.promises.stat(readableRoot);
        if (!stats.isDirectory()) {
            return {
                normalizedRoot,
                exists: true,
                isDirectory: false,
                readable: false,
            };
        }

        try {
            await fs.promises.access(readableRoot, fs.constants.R_OK);
            return {
                normalizedRoot,
                exists: true,
                isDirectory: true,
                readable: true,
            };
        } catch {
            return {
                normalizedRoot,
                exists: true,
                isDirectory: true,
                readable: false,
            };
        }
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return {
                normalizedRoot,
                exists: false,
                isDirectory: false,
                readable: false,
            };
        }

        throw error;
    }
}

async function validateLibraryRoot(
    root: string
): Promise<ConfigValidateRootResponse> {
    const normalizedRoot = root.trim();

    if (normalizedRoot.length === 0) {
        return {
            exists: false,
            isDirectory: false,
            readable: false,
            message: 'Path is empty.',
        };
    }

    const inspection = await inspectLibraryRoot(normalizedRoot);

    if (!inspection.exists) {
        return {
            exists: false,
            isDirectory: false,
            readable: false,
            message: 'Path does not exist.',
        };
    }

    if (!inspection.isDirectory) {
        return {
            exists: true,
            isDirectory: false,
            readable: false,
            message: 'Path exists but is not a directory.',
        };
    }

    return {
        exists: true,
        isDirectory: true,
        readable: inspection.readable,
        message: inspection.readable
            ? 'Path exists and is readable.'
            : 'Directory exists but is not readable.',
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
            typeof readConfigValue(parsed, 'host') === 'string'
                ? (readConfigValue(parsed, 'host') as string)
                : DEFAULT_SERVER_HOST,
        port:
            typeof readConfigValue(parsed, 'port') === 'number'
                ? (readConfigValue(parsed, 'port') as number)
                : DEFAULT_SERVER_PORT,
        openBrowser:
            typeof readConfigValue(parsed, 'openBrowser') === 'boolean'
                ? (readConfigValue(parsed, 'openBrowser') as boolean)
                : DEFAULT_BROWSER_OPEN,
        '3dsRoots': readThreeDSRoots(parsed, { defaultRoot: DEFAULT_ROM_DIR }),
        wiiRoots: readWiiRoots(parsed, { defaultRoot: DEFAULT_ROM_DIR }),
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
        host:
            typeof readConfigValue(update, 'host') === 'string'
                ? (readConfigValue(update, 'host') as string)
                : previous.host,
        port:
            typeof readConfigValue(update, 'port') === 'number'
                ? (readConfigValue(update, 'port') as number)
                : previous.port,
        openBrowser:
            typeof readConfigValue(update, 'openBrowser') === 'boolean'
                ? (readConfigValue(update, 'openBrowser') as boolean)
                : previous.openBrowser,
        '3dsRoots': !hasConfigValue(update, '3dsRoots')
            ? previous['3dsRoots']
            : readThreeDSRoots(update),
        wiiRoots: !hasConfigValue(update, 'wiiRoots')
            ? previous.wiiRoots
            : readWiiRoots(update),
        wiiuRoots: !hasConfigValue(update, 'wiiuRoots')
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
                await validateLibraryRoot(root);
            res.json(response);
        } catch (error) {
            logger.warn(
                'server',
                `Failed to validate library root: ${formatLogError(error)}`
            );
            sendServerError(res, 'Failed to validate library root', error, {
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
