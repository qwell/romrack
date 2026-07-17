import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import * as cheerio from 'cheerio';

import logger from '../shared/logger.js';
import { isFileExistsError, isFileNotFoundError } from '../shared/file.js';
import {
    TITLE_PLATFORM_IDS,
    type TitleGroup,
    type TitlePlatform,
} from '../shared/titles.js';
import { formatLogError } from '../shared/utils.js';
import {
    decompressZipEntry,
    readZipCentralDirectory,
    readZipCentralDirectoryEntries,
    readZipEntryDataLocation,
    type ZipCentralDirectoryEntry,
    ZIP_EOCD_MIN_SIZE,
} from './formats/zip.js';
import { getImageContentType, type CachedImage } from './image-cache.js';
import { getUserAppRoot } from './paths.js';
import { downloadBytes } from './download.js';

const GAME_TDB_MEDIA_TYPES = ['icons', 'covers'] as const;
const GAME_TDB_MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;
const SKIPPED_GAME_TDB_TYPES = new Set(['CUSTOM', 'Homebrew']);

type GameTdbMediaType = (typeof GAME_TDB_MEDIA_TYPES)[number];

type GameTdbPlatformConfig = {
    downloadsPage: string;
    media: Partial<
        Record<
            GameTdbMediaType,
            {
                archiveName: string;
                regions: readonly GameTdbRegion[];
            }
        >
    >;
};

type GameTdbRegion = string;

type GameTdbMediaStep = {
    platform: TitlePlatform;
    type: GameTdbMediaType;
    region: GameTdbRegion;
};

type WantedMediaItem = {
    productCode: string;
    region: string | null;
    name: string;
};

type WantedMediaItems = Map<string, WantedMediaItem[]>;

type WantedMedia = Map<TitlePlatform, Map<GameTdbMediaType, WantedMediaItems>>;

type GameTdbArchiveProductCodes = {
    zipFilename: string | null;
    productCodes: Set<string>;
};

type GameTdbArchiveProductCodesJson = {
    zipFilename?: string | null;
    productCodes: string[];
};

type GameTdbCacheJson = {
    archives?: Record<string, GameTdbArchiveProductCodesJson>;
};

type GameTdbDownloadedArchive = {
    archivePath: string;
    productCodes: Set<string>;
};

type GameTdbArchiveExtraction = {
    mediaKeys: Set<string>;
    mediaItems: WantedMediaItems;
    pending: Promise<void>;
};

export type GameTdbLocale = {
    '@lang'?: string;
    title?: string;
    synopsis?: string;
};

export type GameTdbControl = {
    '@type'?: string;
    '@required'?: string;
};

export type GameTdbGameImage = {
    '@size'?: string;
};

export type GameTdbGame = {
    id?: string;
    type?: string;
    region?: string;
    languages?: string;
    locale?: GameTdbLocale | GameTdbLocale[];
    developer?: string;
    genre?: string;
    input?: {
        control?: GameTdbControl | GameTdbControl[];
        '@players'?: string;
    };
    rom?: GameTdbGameImage;
};

export type GameTdbFile = {
    games?: GameTdbGame[];
};

export type GameTdbXmlFile = {
    datafile?: {
        game?: unknown;
    };
};

const DEFAULT_LOCALE = 'EN';

const THREE_DS_MEDIA_REGIONS = [
    'US',
    'JA',
    'EN',
    'FR',
    'DE',
    'ES',
    'IT',
    'NL',
    'PT',
    'CH',
    'AU',
    'SE',
    'DK',
    'NO',
    'FI',
    'KO',
    'ZH',
    'RU',
] as const;
const THREE_DS_DISC_MEDIA_REGIONS = [...THREE_DS_MEDIA_REGIONS] as const;
const THREE_DS_COVER_MEDIA_REGIONS = [...THREE_DS_MEDIA_REGIONS] as const;

const WII_MEDIA_REGIONS = [
    'US',
    'JA',
    'EN',
    'FR',
    'DE',
    'ES',
    'IT',
    'NL',
    'AU',
    'SE',
    'DK',
    'NO',
    'FI',
    'KO',
    'ZH',
    'RU',
] as const;
const WII_DISC_MEDIA_REGIONS = [...WII_MEDIA_REGIONS] as const;
const WII_COVER_MEDIA_REGIONS = [
    ...WII_MEDIA_REGIONS,
    'PT',
    'CH',
    'TR',
] as const;

const WII_U_MEDIA_REGIONS = ['US', 'JA', 'EN', 'AU', 'RU'] as const;
const WII_U_DISC_MEDIA_REGIONS = [...WII_U_MEDIA_REGIONS] as const;
const WII_U_COVER_MEDIA_REGIONS = [
    ...WII_U_DISC_MEDIA_REGIONS,
    'FR',
    'DE',
    'ES',
    'IT',
    'NL',
    'PT',
    'CH',
    'SE',
    'DK',
    'NO',
    'FI',
] as const;

const platforms: Record<TitlePlatform, GameTdbPlatformConfig> = {
    '3ds': {
        downloadsPage: 'https://www.gametdb.com/3DS/Downloads',
        media: {
            icons: {
                archiveName: 'box',
                regions: THREE_DS_DISC_MEDIA_REGIONS,
            },
            covers: {
                archiveName: 'coverM',
                regions: THREE_DS_COVER_MEDIA_REGIONS,
            },
        },
    },
    wii: {
        downloadsPage: 'https://www.gametdb.com/Wii/Downloads',
        media: {
            icons: {
                archiveName: 'disc',
                regions: WII_DISC_MEDIA_REGIONS,
            },
            covers: {
                archiveName: 'cover',
                regions: WII_COVER_MEDIA_REGIONS,
            },
        },
    },
    wiiu: {
        downloadsPage: 'https://www.gametdb.com/WiiU/Downloads',
        media: {
            icons: {
                archiveName: 'discM',
                regions: WII_U_DISC_MEDIA_REGIONS,
            },
            covers: {
                archiveName: 'coverM',
                regions: WII_U_COVER_MEDIA_REGIONS,
            },
        },
    },
};

const downloadUrl = 'https://www.gametdb.com/download.php';
const mediaCacheRoot = path.join(getUserAppRoot(), '.cache');
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const STALE_TEMP_ARCHIVE_MS = DOWNLOAD_TIMEOUT_MS;
const ZIP_CACHE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_KEY_LENGTHS: Record<TitlePlatform, number> = {
    '3ds': 4,
    wii: 4,
    wiiu: 4,
};
const mediaArchives = new Map<string, Promise<GameTdbDownloadedArchive>>();
const mediaExtractions = new Map<string, GameTdbArchiveExtraction>();
const downloadsPageCache = new Map<TitlePlatform, Promise<string>>();
const remoteArchiveIndexes = new Map<
    string,
    Promise<GameTdbArchiveProductCodes>
>();
const archiveProductCodes = new Map<string, GameTdbArchiveProductCodes>();
const missingMediaArchives = new Set<string>();
let cacheFileLoaded = false;
let startupUpdateStarted = false;

export function isGameTdbGame(value: unknown): value is GameTdbGame {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>).id === 'string'
    );
}

export function isSkippedGameTdbTitle(game: GameTdbGame): boolean {
    return game.type ? SKIPPED_GAME_TDB_TYPES.has(game.type) : false;
}

export function getGameTdbLocales(game: GameTdbGame): GameTdbLocale[] {
    if (Array.isArray(game.locale)) {
        return game.locale;
    }

    return game.locale ? [game.locale] : [];
}

export function getPreferredGameTdbLocale(
    locales: GameTdbLocale[]
): GameTdbLocale | null {
    return getGameTdbLocale(locales, DEFAULT_LOCALE) ?? locales[0] ?? null;
}

export function getGameTdbLocale(
    locales: GameTdbLocale[],
    locale: string
): GameTdbLocale | null {
    return locales.find((candidate) => candidate['@lang'] === locale) ?? null;
}

export function getGameTdbTitle(
    locale: GameTdbLocale | null | undefined
): string | null {
    return locale?.title?.trim() || null;
}

export function getGameTdbSynopsis(
    locale: GameTdbLocale | null | undefined
): string | null {
    return locale?.synopsis?.trim() || null;
}

export function getPreferredGameTdbSynopsis(
    locales: GameTdbLocale[]
): string | null {
    const englishSynopsis = getGameTdbSynopsis(
        getGameTdbLocale(locales, DEFAULT_LOCALE)
    );
    if (englishSynopsis) {
        return englishSynopsis;
    }

    for (const locale of locales) {
        const synopsis = getGameTdbSynopsis(locale);
        if (synopsis) {
            return synopsis;
        }
    }

    return null;
}

async function readDownloadsPage(platform: TitlePlatform): Promise<string> {
    let pending = downloadsPageCache.get(platform);
    if (!pending) {
        logger.log(
            'gametdb',
            `loading GameTDB downloads page for ${platform}: ${platforms[platform].downloadsPage}`
        );
        pending = downloadBuffer(platforms[platform].downloadsPage).then(
            (body) => body.toString('utf8')
        );
        downloadsPageCache.set(platform, pending);
    }

    return pending;
}

function getMediaArchivePath(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion
): string {
    return path.join(
        mediaCacheRoot,
        `GameTDB-${platform}-${type}-${region}.zip`
    );
}

function getCacheFilePath(): string {
    return path.join(mediaCacheRoot, 'gametdb.json');
}

function getArchiveIndexKey(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion
): string {
    return `${platform}:${type}:${region}`;
}

function getMediaCacheDir(
    type: GameTdbMediaType,
    platform: TitlePlatform
): string {
    return path.join(mediaCacheRoot, type, platform);
}

function getMediaCachePath(
    type: GameTdbMediaType,
    platform: TitlePlatform,
    mediaKey: string,
    extension: string
): string {
    return path.join(
        getMediaCacheDir(type, platform),
        `${mediaKey}${extension}`
    );
}

function getZipUrl(filename: string): string {
    const url = new URL(downloadUrl);
    url.searchParams.set('FTP', filename);
    return url.toString();
}

function getMediaCacheFilename(
    platform: TitlePlatform,
    filename: string
): {
    mediaKey: string;
    filename: string;
} | null {
    const parsed = path.parse(path.basename(filename));
    const key = parsed.name.slice(0, MEDIA_KEY_LENGTHS[platform]).toUpperCase();
    const extension = parsed.ext.toLowerCase();

    return key.length === MEDIA_KEY_LENGTHS[platform] && extension
        ? {
              mediaKey: key,
              filename: `${key}${extension}`,
          }
        : null;
}

function getMediaKey(platform: TitlePlatform, id: string): string {
    return id.slice(0, MEDIA_KEY_LENGTHS[platform]).toUpperCase();
}

function formatFileCount(count: number): string {
    return `${count.toString()} file${count === 1 ? '' : 's'}`;
}

function formatArchiveLabel(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region?: GameTdbRegion | null
): string {
    return `GameTDB for ${platform} ${type}${region ? ` [${region}]` : ''} zip`;
}

function formatStepArchiveLabel(step: GameTdbMediaStep): string {
    return formatArchiveLabel(step.platform, step.type, step.region);
}

function formatWantedMediaItem(item: WantedMediaItem): string {
    return `${item.productCode} [${item.region ?? 'unknown'}] ${item.name}`;
}

function logWantedMediaItems(prefix: string, items: WantedMediaItems): void {
    logger.log('gametdb', `${prefix}:`);
    for (const item of [...items.values()].flat()) {
        logger.log('gametdb', `  ${formatWantedMediaItem(item)}`);
    }
}

function mergeWantedMediaItems(
    target: WantedMediaItems,
    source?: WantedMediaItems | null
): void {
    for (const [mediaKey, items] of source ?? []) {
        const targetItems = target.get(mediaKey);
        if (targetItems) {
            targetItems.push(...items);
        } else {
            target.set(mediaKey, [...items]);
        }
    }
}

async function readCacheFile(): Promise<void> {
    if (cacheFileLoaded) {
        return;
    }

    cacheFileLoaded = true;

    try {
        const text = await fs.readFile(getCacheFilePath(), 'utf8');
        const parsed = JSON.parse(text) as GameTdbCacheJson;
        for (const [key, archive] of Object.entries(parsed.archives ?? {})) {
            archiveProductCodes.set(key, {
                zipFilename: archive.zipFilename ?? null,
                productCodes: new Set(archive.productCodes),
            });
        }
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return;
        }

        logger.warn(
            'gametdb',
            `failed to read GameTDB cache: ${formatLogError(error)}`
        );
    }
}

async function writeCacheFile(): Promise<void> {
    const archives: Record<string, GameTdbArchiveProductCodesJson> = {};

    for (const [key, archive] of archiveProductCodes) {
        archives[key] = {
            zipFilename: archive.zipFilename,
            productCodes: [...archive.productCodes].sort(),
        };
    }

    await fs.mkdir(mediaCacheRoot, { recursive: true });
    await fs.writeFile(
        getCacheFilePath(),
        `${JSON.stringify({ archives }, null, 2)}\n`
    );
}

async function downloadBuffer(url: string): Promise<Buffer> {
    try {
        return Buffer.from(
            await downloadBytes(url, 'GameTDB', {
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            })
        );
    } catch (error) {
        if (
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
            throw new Error(
                `GameTDB download timed out after ${(DOWNLOAD_TIMEOUT_MS / 1000).toString()}s: ${url}`,
                { cause: error }
            );
        }
        throw error;
    }
}

async function fetchGameTdb(url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
    } catch (error) {
        if (
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
            throw new Error(
                `GameTDB download timed out after ${(DOWNLOAD_TIMEOUT_MS / 1000).toString()}s: ${url}`,
                { cause: error }
            );
        }

        throw error;
    }
}

async function readRemoteFileSize(url: string): Promise<number> {
    const response = await fetchGameTdb(url, {
        method: 'HEAD',
        headers: {
            Range: 'bytes=0-0',
        },
    });

    if (!response.ok) {
        throw new Error(
            `GameTDB archive HEAD failed: ${url} (${response.status.toString()})`
        );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('text/html')) {
        throw new Error(`GameTDB archive HEAD returned HTML: ${url}`);
    }

    const contentRange = response.headers.get('content-range');
    const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];
    const size = Number(rangeSize ?? response.headers.get('content-length'));

    if (!Number.isSafeInteger(size) || size < ZIP_EOCD_MIN_SIZE) {
        throw new Error(`GameTDB archive size was not available: ${url}`);
    }

    return size;
}

async function downloadRange(
    url: string,
    start: number,
    end: number
): Promise<Buffer> {
    const response = await fetchGameTdb(url, {
        headers: {
            Range: `bytes=${start.toString()}-${end.toString()}`,
        },
    });

    if (response.status !== 206) {
        throw new Error(
            `GameTDB archive range download failed: ${url} (${response.status.toString()})`
        );
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) {
        throw new Error(`GameTDB archive range download was empty: ${url}`);
    }
    return body;
}

async function readRemoteArchiveProductCodes(
    platform: TitlePlatform,
    filename: string
): Promise<Set<string>> {
    const url = getZipUrl(filename);
    const fileSize = await readRemoteFileSize(url);
    const directory = await readZipCentralDirectory(
        fileSize,
        (start, end) => downloadRange(url, start, end),
        url
    );
    const productCodes = new Set<string>();

    for (const entry of readZipCentralDirectoryEntries(directory)) {
        const filename = getMediaCacheFilename(platform, entry.filename);
        if (filename) {
            productCodes.add(filename.mediaKey);
        }
    }

    return productCodes;
}

async function readLocalArchiveProductCodes(
    platform: TitlePlatform,
    archivePath: string
): Promise<Set<string>> {
    const directory = await readLocalZipCentralDirectory(archivePath);
    const productCodes = new Set<string>();

    for (const entry of readZipCentralDirectoryEntries(directory)) {
        const filename = getMediaCacheFilename(platform, entry.filename);
        if (filename) {
            productCodes.add(filename.mediaKey);
        }
    }

    return productCodes;
}

async function readFileRange(
    filePath: string,
    start: number,
    end: number
): Promise<Buffer> {
    const file = await fs.open(filePath, 'r');
    try {
        const length = end - start + 1;
        const body = Buffer.alloc(length);
        const { bytesRead } = await file.read(body, 0, length, start);
        return bytesRead === length ? body : body.subarray(0, bytesRead);
    } finally {
        await file.close();
    }
}

async function readLocalZipCentralDirectory(filePath: string): Promise<Buffer> {
    const info = await fs.stat(filePath);
    return readZipCentralDirectory(
        info.isFile() ? info.size : 0,
        (start, end) => readFileRange(filePath, start, end),
        filePath
    );
}

async function readLocalZipEntryData(
    filePath: string,
    entry: ZipCentralDirectoryEntry
): Promise<Buffer> {
    const header = await readFileRange(
        filePath,
        entry.localHeaderOffset,
        entry.localHeaderOffset + 29
    );
    const location = readZipEntryDataLocation(header, entry);
    const compressed =
        location.length > 0
            ? await readFileRange(
                  filePath,
                  location.offset,
                  location.offset + location.length - 1
              )
            : Buffer.alloc(0);
    return decompressZipEntry(compressed, entry);
}

async function findZipFilename(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion
): Promise<string | null> {
    const config = platforms[platform];
    const media = config.media[type];
    if (!media) {
        return null;
    }

    const html = await readDownloadsPage(platform);
    const query = cheerio.load(html);
    const prefix = `GameTDB-${platform}_${media.archiveName}-${region}-`;

    return query(`a[title^="${prefix}"]`).attr('title') ?? null;
}

function getZipFilenamePrefix(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion
): string | null {
    const media = platforms[platform].media[type];
    return media ? `GameTDB-${platform}_${media.archiveName}-${region}-` : null;
}

async function downloadFile(url: string, filePath: string): Promise<number> {
    let response: Response;
    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
    } catch (error) {
        if (
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
            throw new Error(
                `GameTDB download timed out after ${(DOWNLOAD_TIMEOUT_MS / 1000).toString()}s: ${url}`,
                { cause: error }
            );
        }

        throw error;
    }

    if (!response.ok) {
        throw new Error(
            `GameTDB download failed: ${url} (${response.status.toString()})`
        );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('text/html')) {
        throw new Error(
            `GameTDB download returned HTML instead of ZIP: ${url}`
        );
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(contentLength) && contentLength <= 0) {
        throw new Error(`GameTDB download was empty: ${url}`);
    }

    if (!response.body) {
        throw new Error(`GameTDB download failed: empty response body: ${url}`);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(filePath)
    );

    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
        throw new Error(`GameTDB download wrote an empty file: ${url}`);
    }
    return stats.size;
}

async function removeStaleTemporaryArchiveFiles(
    archivePath: string
): Promise<void> {
    const directory = path.dirname(archivePath);
    const prefix = `${path.basename(archivePath)}.`;
    const suffix = '.tmp';
    let entries;

    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return;
        }

        throw error;
    }

    for (const entry of entries) {
        if (
            !entry.isFile() ||
            !entry.name.startsWith(prefix) ||
            !entry.name.endsWith(suffix)
        ) {
            continue;
        }

        const temporaryPath = path.join(directory, entry.name);
        let stats;
        try {
            stats = await fs.stat(temporaryPath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                continue;
            }

            throw error;
        }
        if (Date.now() - stats.mtimeMs < STALE_TEMP_ARCHIVE_MS) {
            continue;
        }

        await fs.unlink(temporaryPath).catch((error: unknown) => {
            if (!isFileNotFoundError(error)) {
                logger.warn(
                    'gametdb',
                    `failed to remove stale temporary GameTDB archive ${temporaryPath}: ${formatLogError(error)}`
                );
            }
        });
    }
}

async function downloadArchive(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion,
    force = false
): Promise<string> {
    const archivePath = getMediaArchivePath(platform, type, region);
    if (!force) {
        try {
            const info = await fs.stat(archivePath);
            if (info.isFile()) {
                if (info.size > 0) {
                    return archivePath;
                }
                await fs.unlink(archivePath);
            }
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                throw error;
            }
        }
    }

    const filename = await findZipFilename(platform, type, region);
    if (!filename) {
        missingMediaArchives.add(getArchiveIndexKey(platform, type, region));
        const prefix = getZipFilenamePrefix(platform, type, region);
        throw new Error(
            `GameTDB ${platform} ${type} ${region} download was not found at ${platforms[platform].downloadsPage}${
                prefix ? ` (searched for ${prefix}*)` : ''
            }`
        );
    }

    logger.log(
        'gametdb',
        `downloading ${formatArchiveLabel(platform, type, region)}`
    );

    const temporaryPath = `${archivePath}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
    try {
        await removeStaleTemporaryArchiveFiles(archivePath);
        await downloadFile(getZipUrl(filename), temporaryPath);
        await fs.rename(temporaryPath, archivePath);
    } catch (error) {
        await fs.unlink(temporaryPath).catch((unlinkError: unknown) => {
            if (!isFileNotFoundError(unlinkError)) {
                logger.warn(
                    'gametdb',
                    `failed to remove temporary GameTDB archive ${temporaryPath}: ${formatLogError(unlinkError)}`
                );
            }
        });
        throw error;
    }
    return archivePath;
}

async function readRemoteArchiveIndex(
    step: GameTdbMediaStep
): Promise<GameTdbArchiveProductCodes | null> {
    await readCacheFile();

    const key = getArchiveIndexKey(step.platform, step.type, step.region);
    const cached = archiveProductCodes.get(key);
    const filename = await findZipFilename(
        step.platform,
        step.type,
        step.region
    );
    if (!filename) {
        missingMediaArchives.add(key);
        return null;
    }

    if (cached?.zipFilename === filename) {
        logger.log(
            'gametdb',
            `using cached index for ${formatStepArchiveLabel(step)} (${formatFileCount(cached.productCodes.size)})`
        );
        return cached;
    }

    const existing = remoteArchiveIndexes.get(key);
    if (existing) {
        return existing;
    }

    const pending = (async () => {
        logger.log('gametdb', `probing ${formatStepArchiveLabel(step)}`);
        const productCodes = await readRemoteArchiveProductCodes(
            step.platform,
            filename
        );
        logger.log(
            'gametdb',
            `${formatStepArchiveLabel(step)} contains ${formatFileCount(productCodes.size)}`
        );
        const index = {
            zipFilename: filename,
            productCodes,
        };
        archiveProductCodes.set(key, index);
        await writeCacheFile();
        return index;
    })().catch((error: unknown) => {
        remoteArchiveIndexes.delete(key);
        throw error;
    });

    remoteArchiveIndexes.set(key, pending);
    return pending;
}

async function readDownloadedArchive(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion,
    force = false
): Promise<GameTdbDownloadedArchive> {
    await readCacheFile();

    const key = getArchiveIndexKey(platform, type, region);
    const existing = mediaArchives.get(key);
    if (existing && !force) {
        return existing;
    }

    const pending = (async () => {
        const archivePath = await downloadArchive(
            platform,
            type,
            region,
            force
        );
        let productCodes;
        try {
            productCodes = await readLocalArchiveProductCodes(
                platform,
                archivePath
            );
        } catch (error) {
            await fs.unlink(archivePath).catch((unlinkError: unknown) => {
                if (!isFileNotFoundError(unlinkError)) {
                    logger.warn(
                        'gametdb',
                        `failed to remove invalid GameTDB archive ${archivePath}: ${formatLogError(unlinkError)}`
                    );
                }
            });
            throw error;
        }
        archiveProductCodes.set(key, {
            zipFilename: path.basename(archivePath),
            productCodes,
        });
        await writeCacheFile();
        return { archivePath, productCodes };
    })().catch((error: unknown) => {
        mediaArchives.delete(key);
        throw error;
    });

    mediaArchives.set(key, pending);
    return pending;
}

async function writeMediaFile(
    filePath: string,
    body: Buffer,
    overwrite = false
): Promise<void> {
    if (overwrite) {
        await fs.writeFile(filePath, body);
        return;
    }

    try {
        await fs.writeFile(filePath, body, { flag: 'wx' });
    } catch (error) {
        if (isFileExistsError(error)) {
            return;
        }

        throw error;
    }
}

async function extractArchive(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion,
    archivePath: string,
    mediaKeys: ReadonlySet<string> | null = null,
    mediaItems: WantedMediaItems | null = null,
    overwrite = false
): Promise<Set<string>> {
    const outputDir = getMediaCacheDir(type, platform);
    await fs.mkdir(outputDir, { recursive: true });
    let extracted = 0;
    const productCodes = new Set<string>();

    const directory = await readLocalZipCentralDirectory(archivePath);
    for (const entry of readZipCentralDirectoryEntries(directory)) {
        const filename = getMediaCacheFilename(platform, entry.filename);
        if (!filename) {
            continue;
        }

        productCodes.add(filename.mediaKey);

        if (mediaKeys && !mediaKeys.has(filename.mediaKey)) {
            continue;
        }

        await writeMediaFile(
            path.join(outputDir, filename.filename),
            await readLocalZipEntryData(archivePath, entry),
            overwrite
        );
        extracted += 1;
    }

    if (mediaItems?.size) {
        logWantedMediaItems(
            `${formatArchiveLabel(platform, type, region)} extracted title(s)`,
            mediaItems
        );
    } else {
        logger.log(
            'gametdb',
            `extracted ${formatArchiveLabel(
                platform,
                type,
                region
            )} (${extracted.toString()} file(s))`
        );
    }
    return productCodes;
}

async function getExtractedMediaKeys(
    platform: TitlePlatform,
    type: GameTdbMediaType
): Promise<Set<string>> {
    const mediaKeys = new Set<string>();

    try {
        for (const entry of await fs.readdir(getMediaCacheDir(type, platform), {
            withFileTypes: true,
        })) {
            if (!entry.isFile()) {
                continue;
            }

            const filename = getMediaCacheFilename(platform, entry.name);
            if (filename) {
                mediaKeys.add(filename.mediaKey);
            }
        }
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            throw error;
        }
    }

    return mediaKeys;
}

async function getExistingArchiveAgeMs(
    step: GameTdbMediaStep
): Promise<number | null> {
    try {
        const info = await fs.stat(
            getMediaArchivePath(step.platform, step.type, step.region)
        );
        return info.isFile() ? Date.now() - info.mtimeMs : null;
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return null;
        }

        throw error;
    }
}

async function isArchiveRefreshDue(step: GameTdbMediaStep): Promise<boolean> {
    const ageMs = await getExistingArchiveAgeMs(step);
    return ageMs !== null && ageMs >= ZIP_CACHE_TIMEOUT_MS;
}

async function waitForExtractionBatch(): Promise<void> {
    await Promise.resolve();
}

async function cacheMediaArchive(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion,
    mediaKeys: ReadonlySet<string> | null = null,
    wantedItems: WantedMediaItems | null = null
): Promise<void> {
    const key = getArchiveIndexKey(platform, type, region);
    const existing = mediaExtractions.get(key);
    if (existing) {
        for (const mediaKey of mediaKeys ?? []) {
            existing.mediaKeys.add(mediaKey);
        }
        mergeWantedMediaItems(existing.mediaItems, wantedItems);
        return existing.pending;
    }

    const extraction: GameTdbArchiveExtraction = {
        mediaKeys: new Set(mediaKeys ?? []),
        mediaItems: new Map(),
        pending: Promise.resolve(),
    };
    mergeWantedMediaItems(extraction.mediaItems, wantedItems);
    mediaExtractions.set(key, extraction);

    extraction.pending = (async () => {
        await waitForExtractionBatch();

        const archive = await readDownloadedArchive(platform, type, region);
        await extractArchive(
            platform,
            type,
            region,
            archive.archivePath,
            extraction.mediaKeys.size > 0 ? extraction.mediaKeys : null,
            extraction.mediaItems.size > 0 ? extraction.mediaItems : null
        );
    })().catch((error: unknown) => {
        mediaExtractions.delete(key);
        logger.warn(
            'gametdb',
            `failed to cache ${platform} ${type} ${region}: ${formatLogError(error)}`
        );
        throw error;
    });

    try {
        await extraction.pending;
    } finally {
        if (mediaExtractions.get(key) === extraction) {
            mediaExtractions.delete(key);
        }
    }
}

function getMediaRegions(
    platform: TitlePlatform,
    type: GameTdbMediaType
): readonly GameTdbRegion[] {
    return platforms[platform].media[type]?.regions ?? [];
}

function getMediaStep(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    index: number
): GameTdbMediaStep | null {
    const region = getMediaRegions(platform, type)[index];
    return region ? { platform, type, region } : null;
}

function getMediaSteps(): GameTdbMediaStep[] {
    const maxRegionCount = Math.max(
        ...TITLE_PLATFORM_IDS.flatMap((platform) =>
            GAME_TDB_MEDIA_TYPES.map(
                (type) => getMediaRegions(platform, type).length
            )
        )
    );
    const steps: GameTdbMediaStep[] = [];

    for (let index = 0; index < maxRegionCount; index += 1) {
        steps.push(
            ...[
                getMediaStep('wiiu', 'icons', index),
                getMediaStep('wii', 'icons', index),
                getMediaStep('3ds', 'icons', index),
                getMediaStep('wiiu', 'covers', index),
                getMediaStep('wii', 'covers', index),
                getMediaStep('3ds', 'covers', index),
            ].filter((step): step is GameTdbMediaStep => step !== null)
        );
    }

    return steps;
}

async function findCachedMediaPath(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    productCode: string
): Promise<string | null> {
    const mediaKey = getMediaKey(platform, productCode);

    for (const extension of GAME_TDB_MEDIA_EXTENSIONS) {
        const mediaPath = getMediaCachePath(
            type,
            platform,
            mediaKey,
            extension
        );

        try {
            const stats = await fs.stat(mediaPath);
            if (stats.isFile()) {
                return mediaPath;
            }
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                throw error;
            }
        }
    }

    return null;
}

function addWantedMedia(
    wanted: WantedMedia,
    platform: TitlePlatform,
    type: GameTdbMediaType,
    productCode: string,
    item: Omit<WantedMediaItem, 'productCode'> = {
        region: null,
        name: productCode,
    }
): void {
    let platformMedia = wanted.get(platform);
    if (!platformMedia) {
        platformMedia = new Map();
        wanted.set(platform, platformMedia);
    }

    let productCodes = platformMedia.get(type);
    if (!productCodes) {
        productCodes = new Map();
        platformMedia.set(type, productCodes);
    }

    const mediaKey = getMediaKey(platform, productCode);
    const items = productCodes.get(mediaKey);
    const wantedItem = { ...item, productCode };
    if (items) {
        items.push(wantedItem);
    } else {
        productCodes.set(mediaKey, [wantedItem]);
    }
}

function getMissingMedia(
    wanted: WantedMedia,
    step: GameTdbMediaStep
): WantedMediaItems | null {
    return wanted.get(step.platform)?.get(step.type) ?? null;
}

function isWantedMediaComplete(wanted: WantedMedia): boolean {
    return [...wanted.values()].every((types) =>
        [...types.values()].every((productCodes) => productCodes.size === 0)
    );
}

async function removeCachedMedia(
    wanted: WantedMedia,
    step: GameTdbMediaStep
): Promise<WantedMediaItems | null> {
    const missing = getMissingMedia(wanted, step);
    if (!missing?.size) {
        return null;
    }

    for (const mediaKey of [...missing.keys()]) {
        const mediaPath = await findCachedMediaPath(
            step.platform,
            step.type,
            mediaKey
        );
        if (mediaPath) {
            missing.delete(mediaKey);
        }
    }

    return missing.size ? missing : null;
}

async function getKnownArchiveMatches(
    step: GameTdbMediaStep,
    missing: WantedMediaItems
): Promise<WantedMediaItems | null> {
    await readCacheFile();

    const key = getArchiveIndexKey(step.platform, step.type, step.region);
    let index = archiveProductCodes.get(key);
    if (!index) {
        try {
            const archivePath = getMediaArchivePath(
                step.platform,
                step.type,
                step.region
            );
            const info = await fs.stat(archivePath);
            if (info.isFile() && info.size > 0) {
                await readDownloadedArchive(
                    step.platform,
                    step.type,
                    step.region
                );
                index = archiveProductCodes.get(key);
            }
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                throw error;
            }
        }
    }
    if (!index) {
        index = (await readRemoteArchiveIndex(step)) ?? undefined;
    }

    if (!index) {
        return new Map();
    }

    const matches = new Map(
        [...missing].filter(([productCode]) =>
            index.productCodes.has(productCode)
        )
    );
    return matches.size > 0 ? matches : new Map();
}

async function cacheMissingMedia(wanted: WantedMedia): Promise<void> {
    for (const step of getMediaSteps()) {
        if (
            missingMediaArchives.has(
                getArchiveIndexKey(step.platform, step.type, step.region)
            )
        ) {
            continue;
        }

        const missing = await removeCachedMedia(wanted, step);
        if (!missing) {
            continue;
        }

        const knownMatches = await getKnownArchiveMatches(step, missing);
        if (knownMatches?.size === 0) {
            continue;
        }

        const mediaToCache = knownMatches ?? missing;
        await cacheMediaArchive(
            step.platform,
            step.type,
            step.region,
            new Set(mediaToCache.keys()),
            mediaToCache
        ).catch(() => undefined);

        await removeCachedMedia(wanted, step);

        if (isWantedMediaComplete(wanted)) {
            return;
        }
    }
}

async function refreshStaleMediaArchive(
    step: GameTdbMediaStep,
    mediaKeys: ReadonlySet<string>
): Promise<void> {
    if (
        mediaKeys.size === 0 ||
        missingMediaArchives.has(
            getArchiveIndexKey(step.platform, step.type, step.region)
        ) ||
        !(await isArchiveRefreshDue(step))
    ) {
        return;
    }

    logger.log(
        'gametdb',
        `refreshing stale ${formatStepArchiveLabel(step)} archive`
    );

    const archive = await readDownloadedArchive(
        step.platform,
        step.type,
        step.region,
        true
    );
    await extractArchive(
        step.platform,
        step.type,
        step.region,
        archive.archivePath,
        mediaKeys,
        null,
        true
    );
}

async function refreshStaleExtractedMedia(): Promise<void> {
    const mediaKeys = new Map<string, Set<string>>();

    for (const platform of TITLE_PLATFORM_IDS) {
        for (const type of GAME_TDB_MEDIA_TYPES) {
            mediaKeys.set(
                `${platform}:${type}`,
                await getExtractedMediaKeys(platform, type)
            );
        }
    }

    for (const step of getMediaSteps()) {
        const stepMediaKeys =
            mediaKeys.get(`${step.platform}:${step.type}`) ?? new Set();
        await refreshStaleMediaArchive(step, stepMediaKeys).catch(
            (error: unknown) => {
                logger.warn(
                    'gametdb',
                    `failed to refresh GameTDB ${step.platform} ${step.type} ${step.region}: ${formatLogError(error)}`
                );
            }
        );
    }
}

async function findOrCacheMediaPath(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    productCode: string,
    item?: Omit<WantedMediaItem, 'productCode'>
): Promise<string | null> {
    const cachedPath = await findCachedMediaPath(platform, type, productCode);
    if (cachedPath) {
        return cachedPath;
    }

    const wanted: WantedMedia = new Map();
    addWantedMedia(wanted, platform, type, productCode, item);
    await cacheMissingMedia(wanted);

    return findCachedMediaPath(platform, type, productCode);
}

function isMediaPlatform(value: string): value is TitlePlatform {
    return TITLE_PLATFORM_IDS.includes(value as TitlePlatform);
}

function isMediaType(value: string): value is GameTdbMediaType {
    return GAME_TDB_MEDIA_TYPES.includes(value as GameTdbMediaType);
}

export function cacheAllGameTdbMedia(): void {
    if (startupUpdateStarted) {
        return;
    }

    startupUpdateStarted = true;
    void refreshStaleExtractedMedia().catch((error: unknown) => {
        logger.warn(
            'gametdb',
            `failed to refresh stale GameTDB media: ${formatLogError(error)}`
        );
    });
}

export function cacheGameTdbMediaForGroups(groups: TitleGroup[]): void {
    void groups;
}

export async function readCachedGameTdbMedia(
    type: string,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    if (!isMediaType(type) || !isMediaPlatform(platform)) {
        return null;
    }

    const mediaPath = await findCachedMediaPath(platform, type, productCode);
    if (!mediaPath) {
        return null;
    }

    return {
        body: await fs.readFile(mediaPath),
        contentType: getImageContentType(mediaPath),
    };
}

export async function readGameTdbMedia(
    type: string,
    platform: TitlePlatform,
    productCode: string,
    item?: Omit<WantedMediaItem, 'productCode'>
): Promise<CachedImage | null> {
    if (!isMediaType(type) || !isMediaPlatform(platform)) {
        return null;
    }

    const mediaPath = await findOrCacheMediaPath(
        platform,
        type,
        productCode,
        item
    );
    if (!mediaPath) {
        return null;
    }

    return {
        body: await fs.readFile(mediaPath),
        contentType: getImageContentType(mediaPath),
    };
}
