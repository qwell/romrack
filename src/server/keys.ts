import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readOptionalFile } from '../shared/file.js';
import logger from '../shared/logger.js';
import { formatLogError } from '../shared/utils.js';
import { getUserAppRoot } from './paths.js';

export type ThreeDSKeys = {
    generatorConstant: string;
    slot0x18KeyX: string | null;
    slot0x1bKeyX: string | null;
    slot0x25KeyX: string | null;
    slot0x2cKeyX: string | null;
    slot0x3dKeyX: string | null;
    commonKeyYs: Array<string | null>;
};

export type WiiUKeys = string;
export type WudKeys = string;

type KeysByPlatform = {
    '3ds': ThreeDSKeys;
    wiiu: WiiUKeys;
    wud: WudKeys | null;
};

type LoadKeysArguments<Platform extends keyof KeysByPlatform> =
    Platform extends 'wud' ? [imagePath: string] : [];

type CachedKeysOptions<Keys> = {
    platform: string;
    cacheFilename: string;
    encodedUrls: readonly string[];
    parse: (raw: Buffer, source: string) => Keys;
};

const KEYS_DOWNLOAD_TIMEOUT_MS = 30_000;
const KEYS_MAX_SIZE = 1024 * 1024;
const THREE_DS_KEYS_CACHE_FILENAME = 'aes_keys.txt';
const THREE_DS_KEYS_URLS = [
    'aHR0cHM6Ly9naXRodWIuY29tL0FiZGVzcy9yZXRyb2Jpb3MvcmF3L3JlZnMvaGVhZHMvbWFpbi9iaW9zL05pbnRlbmRvLzNEUy9hZXNfa2V5cy50eHQ=',
    'aHR0cHM6Ly93ZWIuYXJjaGl2ZS5vcmcvMjAyNjA3MDcyMTA2MDcvZ2l0aHViLmNvbS9BYmRlc3MvcmV0cm9iaW9zL3JlZnMvaGVhZHMvbWFpbi9iaW9zL05pbnRlbmRvLzNEUy9hZXNfa2V5cy50eHQ=',
    'aHR0cHM6Ly9wYXN0ZWJpbi5jb20vcmF3L3ZSeThjNkpQ',
] as const;
const WII_U_KEYS_CACHE_FILENAME = 'common.key';
const WII_U_KEYS_URLS = [
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9FbXJhbkFobTNkL2JkN2E3OTFkMDI5NzVkNzE4NmQwYzA1NTRmM2NmNmVhL3Jhdy8xYzM4MzM1ZjJhNzFhYjQyNDVkMjM3NjE4YzRmYWZlNjcwZWUzZTgyL3dpaXVjb21tb29ua2V5LnR4dA==',
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9xd2VsbC80NWJhN2QyZjMwNWRlNzJhODFkYjlkNzUxOTA4MTE3YS9yYXcvMWMzODMzNWYyYTcxYWI0MjQ1ZDIzNzYxOGM0ZmFmZTY3MGVlM2U4Mi93aWl1Y29tbW9ua2V5LnR4dA==',
] as const;
const THREE_DS_AES_KEY_NAMES = {
    generatorConstant: ['generatorConstant', 'generator'],
    slot0x18KeyX: ['slot0x18KeyX'],
    slot0x1bKeyX: ['slot0x1BKeyX'],
    slot0x25KeyX: ['slot0x25KeyX'],
    slot0x2cKeyX: ['slot0x2CKeyX'],
    slot0x3dKeyX: ['slot0x3DKeyX'],
} as const;

const keysPromises = new Map<string, Promise<unknown>>();

export function loadKeys<Platform extends keyof KeysByPlatform>(
    platform: Platform,
    ...args: LoadKeysArguments<Platform>
): Promise<KeysByPlatform[Platform]> {
    switch (platform) {
        case '3ds':
            return memoizeKeys('3ds', loadThreeDSKeys) as Promise<
                KeysByPlatform[Platform]
            >;
        case 'wiiu':
            return memoizeKeys('wiiu', loadWiiUKeys) as Promise<
                KeysByPlatform[Platform]
            >;
        case 'wud': {
            const [inputPath] = args as [string];
            const imagePath = path.resolve(inputPath);
            return memoizeKeys(
                `wud:${imagePath}`,
                () => loadWudKeys(imagePath),
                (keys) => keys !== null
            ) as Promise<KeysByPlatform[Platform]>;
        }
    }
}

async function loadThreeDSKeys(): Promise<ThreeDSKeys> {
    return loadCachedKeys({
        platform: '3DS',
        cacheFilename: THREE_DS_KEYS_CACHE_FILENAME,
        encodedUrls: THREE_DS_KEYS_URLS,
        parse: parseThreeDSKeys,
    });
}

async function loadWiiUKeys(): Promise<WiiUKeys> {
    return loadCachedKeys({
        platform: 'Wii U',
        cacheFilename: WII_U_KEYS_CACHE_FILENAME,
        encodedUrls: WII_U_KEYS_URLS,
        parse: parseWiiUKeys,
    });
}

async function loadWudKeys(imagePath: string): Promise<WudKeys | null> {
    const candidates = getWudKeyCandidates(imagePath);
    for (const candidate of candidates) {
        const raw = await readOptionalFile(candidate);
        if (raw) {
            const key = parseWudKeys(raw);
            if (key) {
                return key;
            }
        }
    }

    return null;
}

function parseThreeDSKeys(raw: Buffer): ThreeDSKeys {
    const entries = new Map<string, string>();
    for (const line of Buffer.from(raw).toString('utf8').split(/\r?\n/)) {
        const match = /^([^=#\s]+)\s*=\s*([0-9a-fA-F]{32})\s*$/.exec(
            line.trim()
        );
        if (match) {
            entries.set(match[1], match[2].toLowerCase());
        }
    }

    const readNamedKey = (names: readonly string[]): string | null => {
        for (const name of names) {
            const key = entries.get(name);
            if (key) {
                return key;
            }
        }
        return null;
    };
    const generatorConstant = readNamedKey(
        THREE_DS_AES_KEY_NAMES.generatorConstant
    );
    if (!generatorConstant) {
        throw new Error('3DS keys are missing the generator constant');
    }

    return {
        generatorConstant,
        slot0x18KeyX: readNamedKey(THREE_DS_AES_KEY_NAMES.slot0x18KeyX),
        slot0x1bKeyX: readNamedKey(THREE_DS_AES_KEY_NAMES.slot0x1bKeyX),
        slot0x25KeyX: readNamedKey(THREE_DS_AES_KEY_NAMES.slot0x25KeyX),
        slot0x2cKeyX: readNamedKey(THREE_DS_AES_KEY_NAMES.slot0x2cKeyX),
        slot0x3dKeyX: readNamedKey(THREE_DS_AES_KEY_NAMES.slot0x3dKeyX),
        commonKeyYs: Array.from({ length: 6 }, (_, index) =>
            readNamedKey([`common${index.toString()}`])
        ),
    };
}

function parseWiiUKeys(raw: Buffer): WiiUKeys {
    if (raw.length === 16) {
        return Buffer.from(raw).toString('hex');
    }
    const text = Buffer.from(raw).toString('utf8').trim();
    const compact = text.replace(/\s+/g, '');
    const keyBytes = /^[\da-fA-F]{32}$/.test(compact)
        ? Buffer.from(compact, 'hex')
        : null;
    if (!keyBytes || keyBytes.length !== 16) {
        throw new Error('Invalid Wii U common key');
    }
    return Buffer.from(keyBytes).toString('hex');
}

function parseWudKeys(raw: Buffer): WudKeys | null {
    if (raw.length === 16) {
        return Buffer.from(raw).toString('hex');
    }
    const text = Buffer.from(raw).toString('utf8');
    const compact = text.trim().replace(/\s+/g, '');
    const hex = /^[0-9a-f]{32}$/i.test(compact)
        ? compact
        : (text.match(/[0-9a-f]{32}/i)?.[0] ?? null);
    return hex?.toLowerCase() ?? null;
}

function memoizeKeys<Keys>(
    cacheKey: string,
    load: () => Promise<Keys>,
    isCacheable: (keys: Keys) => boolean = () => true
): Promise<Keys> {
    const existing = keysPromises.get(cacheKey) as Promise<Keys> | undefined;
    if (existing) {
        return existing;
    }

    const pending = load();
    keysPromises.set(cacheKey, pending);
    void pending.then(
        (keys) => {
            if (!isCacheable(keys) && keysPromises.get(cacheKey) === pending) {
                keysPromises.delete(cacheKey);
            }
        },
        () => {
            if (keysPromises.get(cacheKey) === pending) {
                keysPromises.delete(cacheKey);
            }
        }
    );
    return pending;
}

async function loadCachedKeys<Keys>({
    platform,
    cacheFilename,
    encodedUrls,
    parse,
}: CachedKeysOptions<Keys>): Promise<Keys> {
    const cacheRoot = getUserAppRoot();
    const cachePath = path.join(cacheRoot, cacheFilename);
    const errors: string[] = [];
    const cached = await readOptionalFile(cachePath);
    if (cached) {
        try {
            return parse(cached, cachePath);
        } catch (error) {
            errors.push(`${cachePath}: ${formatLogError(error)}`);
        }
    }

    for (const [index, encodedUrl] of encodedUrls.entries()) {
        const url = Buffer.from(encodedUrl, 'base64').toString('utf8');
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(KEYS_DOWNLOAD_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const body = Buffer.from(await response.arrayBuffer());
            if (body.length === 0 || body.length > KEYS_MAX_SIZE) {
                throw new Error(`invalid response size ${body.length}`);
            }
            const keys = parse(body, url);
            await writeKeyFile(cacheRoot, cachePath, body);
            logger.log('metadata', `Saved ${platform} keys to ${cachePath}`);
            return keys;
        } catch (error) {
            errors.push(`source ${index + 1}: ${formatLogError(error)}`);
        }
    }

    throw new Error(`Failed to load ${platform} keys: ${errors.join('; ')}`);
}

async function writeKeyFile(
    directory: string,
    filePath: string,
    contents: Buffer
): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, filePath);
}

function getWudKeyCandidates(imagePath: string): string[] {
    const parsed = path.parse(imagePath);
    return [
        path.join(parsed.dir, `${parsed.name}.key`),
        path.join(parsed.dir, 'game.key'),
    ];
}
