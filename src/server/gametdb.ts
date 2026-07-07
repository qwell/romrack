import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';

import logger from '../shared/logger.js';
import { isFileNotFoundError } from '../shared/file.js';
import {
    TITLE_PLATFORMS,
    type TitleGroup,
    type TitlePlatform,
} from '../shared/titles.js';
import { formatLogError } from '../shared/utils.js';
import { getImageContentType, type CachedImage } from './image-cache.js';
import { getUserAppRoot } from './paths.js';

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

type WantedMedia = Map<TitlePlatform, Map<GameTdbMediaType, Set<string>>>;

type GameTdbArchiveProductCodes = {
    productCodes: Set<string>;
};

type GameTdbArchiveProductCodesJson = {
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
    'AU',
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
    'RU',
] as const;
const THREE_DS_DISC_MEDIA_REGIONS = THREE_DS_MEDIA_REGIONS;
const THREE_DS_COVER_MEDIA_REGIONS = THREE_DS_MEDIA_REGIONS;

const WII_DISC_MEDIA_REGIONS = [
    'US',
    'JA',
    'EN',
    'AU',
    'FR',
    'DE',
    'ES',
    'IT',
    'NL',
    'SE',
    'DK',
    'NO',
    'FI',
    'KO',
    'ZH',
    'RU',
] as const;
const WII_COVER_MEDIA_REGIONS = [
    'US',
    'JA',
    'EN',
    'AU',
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
    'TR',
    'KO',
    'ZH',
    'RU',
] as const;

const WII_U_DISC_MEDIA_REGIONS = ['US', 'JA', 'EN', 'AU', 'RU'] as const;
const WII_U_COVER_MEDIA_REGIONS = [
    'US',
    'JA',
    'EN',
    'AU',
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
    'RU',
] as const;

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
const ZIP_CACHE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_KEY_LENGTH = 4;
const mediaArchives = new Map<string, Promise<GameTdbDownloadedArchive>>();
const mediaExtractions = new Map<string, GameTdbArchiveExtraction>();
const downloadsPageCache = new Map<TitlePlatform, Promise<string>>();
const archiveProductCodes = new Map<string, GameTdbArchiveProductCodes>();
const missingMediaArchives = new Set<string>();
let cacheFileLoaded = false;
let startupUpdateStarted = false;

async function readDownloadsPage(platform: TitlePlatform): Promise<string> {
    let pending = downloadsPageCache.get(platform);
    if (!pending) {
        logger.log(
            'assets',
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

function getMediaCacheFilename(filename: string): {
    mediaKey: string;
    filename: string;
} | null {
    const parsed = path.parse(path.basename(filename));
    const key = parsed.name.slice(0, MEDIA_KEY_LENGTH).toUpperCase();
    const extension = parsed.ext.toLowerCase();

    return key.length === MEDIA_KEY_LENGTH && extension
        ? {
              mediaKey: key,
              filename: `${key}${extension}`,
          }
        : null;
}

function getMediaKey(id: string): string {
    return id.slice(0, MEDIA_KEY_LENGTH).toUpperCase();
}

function formatWantedTitleCount(wantedCount: number | null): string {
    if (wantedCount === null) {
        return '';
    }

    return ` (looking for ${wantedCount.toString()} title${
        wantedCount === 1 ? '' : 's'
    })`;
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
                productCodes: new Set(archive.productCodes),
            });
        }
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return;
        }

        logger.warn(
            'assets',
            `failed to read GameTDB cache: ${formatLogError(error)}`
        );
    }
}

async function writeCacheFile(): Promise<void> {
    const archives: Record<string, GameTdbArchiveProductCodesJson> = {};

    for (const [key, archive] of archiveProductCodes) {
        archives[key] = {
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

    return Buffer.from(await response.arrayBuffer());
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

async function downloadFile(url: string, filePath: string): Promise<void> {
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

    if (!response.body) {
        throw new Error(`GameTDB download failed: empty response body: ${url}`);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(filePath)
    );
}

async function downloadArchive(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion,
    wantedCount: number | null = null,
    force = false
): Promise<string> {
    const archivePath = getMediaArchivePath(platform, type, region);
    if (!force) {
        try {
            const info = await fs.stat(archivePath);
            if (info.isFile()) {
                return archivePath;
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
        'assets',
        `downloading ${filename} for ${platform} ${type} ${region}${formatWantedTitleCount(
            wantedCount
        )}`
    );

    const temporaryPath = `${archivePath}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
    try {
        await downloadFile(getZipUrl(filename), temporaryPath);
        await fs.rename(temporaryPath, archivePath);
    } catch (error) {
        await fs.unlink(temporaryPath).catch((unlinkError: unknown) => {
            if (!isFileNotFoundError(unlinkError)) {
                logger.warn(
                    'assets',
                    `failed to remove temporary GameTDB archive ${temporaryPath}: ${formatLogError(unlinkError)}`
                );
            }
        });
        throw error;
    }
    return archivePath;
}

function readArchiveProductCodes(archivePath: string): Set<string> {
    const productCodes = new Set<string>();
    const zip = new AdmZip(archivePath);

    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }

        const filename = getMediaCacheFilename(entry.entryName);
        if (filename) {
            productCodes.add(filename.mediaKey);
        }
    }

    return productCodes;
}

async function readDownloadedArchive(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    region: GameTdbRegion,
    wantedCount: number | null = null,
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
            wantedCount,
            force
        );
        const productCodes = readArchiveProductCodes(archivePath);
        archiveProductCodes.set(key, {
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
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
        ) {
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
    overwrite = false
): Promise<Set<string>> {
    const outputDir = getMediaCacheDir(type, platform);
    await fs.mkdir(outputDir, { recursive: true });
    let extracted = 0;
    const productCodes = new Set<string>();

    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }

        const filename = getMediaCacheFilename(entry.entryName);
        if (!filename) {
            continue;
        }

        productCodes.add(filename.mediaKey);

        if (mediaKeys && !mediaKeys.has(filename.mediaKey)) {
            continue;
        }

        await writeMediaFile(
            path.join(outputDir, filename.filename),
            entry.getData(),
            overwrite
        );
        extracted += 1;
    }

    logger.log(
        'assets',
        `extracted ${platform} ${type} ${region} (${extracted.toString()} file(s))`
    );
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

            const filename = getMediaCacheFilename(entry.name);
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
    mediaKeys: ReadonlySet<string> | null = null
): Promise<void> {
    const key = getArchiveIndexKey(platform, type, region);
    const existing = mediaExtractions.get(key);
    if (existing) {
        for (const mediaKey of mediaKeys ?? []) {
            existing.mediaKeys.add(mediaKey);
        }
        return existing.pending;
    }

    const extraction: GameTdbArchiveExtraction = {
        mediaKeys: new Set(mediaKeys ?? []),
        pending: Promise.resolve(),
    };
    mediaExtractions.set(key, extraction);

    extraction.pending = (async () => {
        await waitForExtractionBatch();

        const archive = await readDownloadedArchive(
            platform,
            type,
            region,
            extraction.mediaKeys.size > 0 ? extraction.mediaKeys.size : null
        );
        await extractArchive(
            platform,
            type,
            region,
            archive.archivePath,
            extraction.mediaKeys.size > 0 ? extraction.mediaKeys : null
        );
    })().catch((error: unknown) => {
        mediaExtractions.delete(key);
        logger.warn(
            'assets',
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
        ...TITLE_PLATFORMS.flatMap((platform) =>
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
    const mediaKey = getMediaKey(productCode);

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
    productCode: string
): void {
    let platformMedia = wanted.get(platform);
    if (!platformMedia) {
        platformMedia = new Map();
        wanted.set(platform, platformMedia);
    }

    let productCodes = platformMedia.get(type);
    if (!productCodes) {
        productCodes = new Set();
        platformMedia.set(type, productCodes);
    }

    productCodes.add(getMediaKey(productCode));
}

function getMissingMedia(
    wanted: WantedMedia,
    step: GameTdbMediaStep
): Set<string> | null {
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
): Promise<Set<string> | null> {
    const missing = getMissingMedia(wanted, step);
    if (!missing?.size) {
        return null;
    }

    for (const productCode of [...missing]) {
        const mediaPath = await findCachedMediaPath(
            step.platform,
            step.type,
            productCode
        );
        if (mediaPath) {
            missing.delete(productCode);
        }
    }

    return missing.size ? missing : null;
}

async function getKnownArchiveMatches(
    step: GameTdbMediaStep,
    missing: ReadonlySet<string>
): Promise<Set<string> | null> {
    await readCacheFile();

    const index = archiveProductCodes.get(
        getArchiveIndexKey(step.platform, step.type, step.region)
    );
    if (!index) {
        return null;
    }

    const matches = new Set(
        [...missing].filter((productCode) =>
            index.productCodes.has(productCode)
        )
    );
    return matches.size > 0 ? matches : new Set();
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

        await cacheMediaArchive(
            step.platform,
            step.type,
            step.region,
            knownMatches ?? missing
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
        'assets',
        `refreshing stale GameTDB ${step.platform} ${step.type} ${step.region} archive`
    );

    const archive = await readDownloadedArchive(
        step.platform,
        step.type,
        step.region,
        mediaKeys.size,
        true
    );
    await extractArchive(
        step.platform,
        step.type,
        step.region,
        archive.archivePath,
        mediaKeys,
        true
    );
}

async function refreshStaleExtractedMedia(): Promise<void> {
    const mediaKeys = new Map<string, Set<string>>();

    for (const platform of TITLE_PLATFORMS) {
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
                    'assets',
                    `failed to refresh GameTDB ${step.platform} ${step.type} ${step.region}: ${formatLogError(error)}`
                );
            }
        );
    }
}

async function findOrCacheMediaPath(
    platform: TitlePlatform,
    type: GameTdbMediaType,
    productCode: string
): Promise<string | null> {
    const cachedPath = await findCachedMediaPath(platform, type, productCode);
    if (cachedPath) {
        return cachedPath;
    }

    const wanted: WantedMedia = new Map();
    addWantedMedia(wanted, platform, type, productCode);
    await cacheMissingMedia(wanted);

    return findCachedMediaPath(platform, type, productCode);
}

function isMediaPlatform(value: string): value is TitlePlatform {
    return TITLE_PLATFORMS.includes(value as TitlePlatform);
}

function isMediaType(value: string): value is GameTdbMediaType {
    return GAME_TDB_MEDIA_TYPES.includes(value as GameTdbMediaType);
}

function hasGameTdbMediaUrl(
    group: TitleGroup,
    type: GameTdbMediaType
): boolean {
    const url = type === 'icons' ? group.iconUrl : group.bannerUrl;
    return url?.startsWith(`/api/media/${type}/${group.platform}/`) === true;
}

function shouldCacheGameTdbMediaForGroup(
    group: TitleGroup,
    type: GameTdbMediaType
): boolean {
    switch (group.platform) {
        case '3ds':
            return false;

        case 'wii':
            return type === 'icons' && hasGameTdbMediaUrl(group, type);

        case 'wiiu':
            return false;
    }
}

export function cacheAllGameTdbMedia(): void {
    if (startupUpdateStarted) {
        return;
    }

    startupUpdateStarted = true;
    void refreshStaleExtractedMedia().catch((error: unknown) => {
        logger.warn(
            'assets',
            `failed to refresh stale GameTDB media: ${formatLogError(error)}`
        );
    });
}

export function cacheGameTdbMediaForGroups(groups: TitleGroup[]): void {
    const wanted: WantedMedia = new Map();

    for (const group of groups) {
        if (!group.productCode) {
            continue;
        }

        for (const type of GAME_TDB_MEDIA_TYPES) {
            if (shouldCacheGameTdbMediaForGroup(group, type)) {
                addWantedMedia(wanted, group.platform, type, group.productCode);
            }
        }
    }

    if (isWantedMediaComplete(wanted)) {
        return;
    }

    void cacheMissingMedia(wanted).catch(() => undefined);
}

export async function readGameTdbMedia(
    type: string,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    if (!isMediaType(type) || !isMediaPlatform(platform)) {
        return null;
    }

    const mediaPath = await findOrCacheMediaPath(platform, type, productCode);
    if (!mediaPath) {
        return null;
    }

    return {
        body: await fs.readFile(mediaPath),
        contentType: getImageContentType(mediaPath),
    };
}
