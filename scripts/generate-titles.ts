import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import Zip from 'adm-zip';
import { parse as CsvParse } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

import { normalizeRegion } from '../src/shared/regions.js';
import {
    getWiiProductCode,
    identifyTitle,
    identifyThreeDSTitle,
    identifyWiiUTitle,
    normalizeTitleName,
    replaceTitleKind,
    RawTitleDatabaseEntry,
    TitleKinds,
} from '../src/shared/titles.js';
import { toArray } from '../src/shared/utils.js';
import { requestJson, type TitleLookupResponse } from '../src/shared/api.js';
import { HttpError, isHttpErrorStatus } from '../src/shared/download.js';
import { isFileNotFoundError } from '../src/shared/file.js';
import {
    getGameTdbLocales,
    getGameTdbTitle,
    getPreferredGameTdbLocale,
    isGameTdbGame,
    isSkippedGameTdbTitle,
    type GameTdbXmlFile,
} from '../src/server/gametdb.js';

type Icon = {
    titleId: string;
    iconUrl: string;
};

type CsvRow = Record<string, string>;

type SamuraiTitle = {
    '@id'?: string;
    icon_url?: string;
};

type SamuraiContent = {
    title?: SamuraiTitle;
};

type SamuraiResponse = {
    eshop?: {
        contents?: {
            content?: SamuraiContent | SamuraiContent[];
        };
    };
};

type ThreeDSHShopRow = {
    hshopId: string;
    titleId: string;
    productCode: string;
    name: string;
    version: string;
};

type TitleLookupPlatform = '3ds' | 'wiiu';

type TitleRange = {
    platform: TitleLookupPlatform;
    range: string;
};

type GeneratedTitleId = {
    platform: TitleLookupPlatform;
    titleId: string;
};

type GenerateOptions = {
    refreshNus: boolean;
};

const ranges: TitleRange[] = [
    { platform: '3ds', range: '0004000000000000:00040000001fff00' },
    { platform: '3ds', range: '000400000b000000:000400000b000f00' },
    { platform: '3ds', range: '000400000f700000:000400000f70ff00' },

    { platform: 'wiiu', range: '0005000010100000:0005000010220000' },
    { platform: 'wiiu', range: '000500001f600000:000500001f601f00' },
    { platform: 'wiiu', range: '000500001f700000:000500001f702f00' },
    { platform: 'wiiu', range: '000500001f800000:000500001f80ff00' },
    { platform: 'wiiu', range: '000500001f940e00:000500001f940f00' },
    { platform: 'wiiu', range: '000500001f943100:000500001f943100' },
    { platform: 'wiiu', range: '000500001fbf1000:000500001fbf1000' },
];

const titleUrl = 'http://localhost:3000/api/title/%s?titleId=%s';
const samuraiContentsUrl =
    'https://samurai.wup.shop.nintendo.net/samurai/ws/US/contents/?shop_id=2&limit=10000';
const wiiUTdbZipUrl = 'https://www.gametdb.com/wiiutdb.zip';
const threeDSTdbZipUrl = 'https://www.gametdb.com/3dstdb.zip';
const wiiTdbZipUrl = 'https://www.gametdb.com/wiitdb.zip';

// Maybe useful later?
// https://ninja.ctr.shop.nintendo.net/ninja/ws/titles/id_pair?ns_uid[]=
// https://ninja.ctr.shop.nintendo.net/ninja/ws/titles/id_pair?title_id[]=
// https://ninja.ctr.shop.nintendo.net/ninja/ws/{countryCode}/title/{eShopId}/ec_info
// https://samurai.wup.shop.nintendo.net/samurai/ws/{countryCode}/titles?shop_id=2&limit=10000
// https://samurai.wup.shop.nintendo.net/samurai/ws/{countryCode}/title/{eShopId}
// https://tagaya.wup.shop.nintendo.net/tagaya/versionlist/ZZZ/ZZ/latest_version
// https://tagaya-wup.cdn.nintendo.net/tagaya/versionlist/ZZZ/ZZ/list/{latestVersion}.versionlist

const userAgent = 'WiiU Vault';

const parallel = 16;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
});

const root = process.cwd();
const titlesDir = path.join(root, 'titles');

const titlesFile = path.join(titlesDir, 'titles.json');
const iconsFile = path.join(titlesDir, 'icons.json');
const excludeFile = path.join(titlesDir, 'exclude.json');

const wiiTdbFile = path.join(titlesDir, 'wii/tdb.xml');

const wiiUTdbFile = path.join(titlesDir, 'wiiu/tdb.xml');
const wiiUBrewFile = path.join(titlesDir, 'wiiu/wiiubrew.csv');
const wiiUNusFile = path.join(titlesDir, 'wiiu/nus.json');

const threeDSTdbFile = path.join(titlesDir, '3ds/tdb.xml');
const threeDSHShopFile = path.join(titlesDir, '3ds/hshop.json');
const threeDSNusFile = path.join(titlesDir, '3ds/nus.json');

function formatUrl(
    template: string,
    platform: TitleLookupPlatform,
    titleId: string
): string {
    return template.replace('%s', platform).replace('%s', titleId);
}

function stringFieldRecord<K extends string>(
    value: unknown,
    keys: readonly K[]
): value is Record<K, string> {
    return (
        typeof value === 'object' &&
        value !== null &&
        keys.every(
            (key) => typeof (value as Record<string, unknown>)[key] === 'string'
        )
    );
}

function titleIdSet(entries: unknown[]): Set<string> {
    const titleIds = new Set<string>();

    for (const entry of entries) {
        if (stringFieldRecord(entry, ['titleId'])) {
            const title = identifyTitle(entry.titleId);
            if (title) {
                titleIds.add(title.titleId);
            }
        }
    }

    return titleIds;
}

function sortByTitleId<T extends { titleId: string }>(entries: T[]): T[] {
    return entries.toSorted((a, b) => a.titleId.localeCompare(b.titleId));
}

function parseVersions(value?: string): number[] {
    const matches = [...(value ?? '').matchAll(/v?\s*(\d+)/gi)];
    return matches
        .map((match) => Number.parseInt(match[1], 10))
        .filter((version) => Number.isFinite(version));
}

async function readJsonArray(file: string): Promise<unknown[]> {
    try {
        const text = await fs.readFile(file, 'utf8');
        return toArray(JSON.parse(text) as unknown);
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return [];
        }

        throw error;
    }
}

async function writeJson(file: string, value: unknown): Promise<void> {
    await fs.writeFile(file, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

function parseGenerateOptions(args: string[]): GenerateOptions {
    const options: GenerateOptions = {
        refreshNus: false,
    };

    for (const arg of args) {
        switch (arg) {
            case '--':
                break;
            case '--refresh-nus':
                options.refreshNus = true;
                break;
            default:
                throw new Error(`Unknown generate-titles option: ${arg}`);
        }
    }

    return options;
}

async function fetchBinary(url: string): Promise<Buffer> {
    const response = await fetch(url, {
        headers: {
            'User-Agent': userAgent,
        },
    });
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

async function fetchTextInsecure(url: string): Promise<string> {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
        const request = client.get(
            parsed,
            parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {},
            (response) => {
                if (
                    response.statusCode === undefined ||
                    response.statusCode < 200 ||
                    response.statusCode >= 300
                ) {
                    response.resume();
                    reject(
                        new Error(
                            `Request failed with status ${response.statusCode ?? 'unknown'}`
                        )
                    );
                    return;
                }

                response.setEncoding('utf8');

                let body = '';
                response.on('data', (chunk: string) => {
                    body += chunk;
                });
                response.on('end', () => resolve(body));
            }
        );

        request.on('error', reject);
    });
}

async function mapPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function run() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, run)
    );

    return results;
}

function parseTitleRange(range: string): { start: bigint; end: bigint } {
    const [startHex, endHex] = range.split(':');
    return {
        start: BigInt(`0x${startHex}`),
        end: BigInt(`0x${endHex}`),
    };
}

function getLookupPlatform(titleId: string): TitleLookupPlatform | null {
    const title = identifyTitle(titleId);
    if (!title) {
        return null;
    }

    switch (title.platform) {
        case '3ds':
        case 'wiiu':
            return title.platform;
        case 'wii':
            return null;
    }
}

function getActiveLookupPlatforms(): Set<TitleLookupPlatform> {
    return new Set(ranges.map((range) => range.platform));
}

function generateTitleIds(excluded: Set<string>): GeneratedTitleId[] {
    const titleIds: GeneratedTitleId[] = [];

    for (const range of ranges) {
        const { start, end } = parseTitleRange(range.range);
        let current = start;

        while (current <= end) {
            const title = identifyTitle(
                current.toString(16).padStart(16, '0'),
                range.platform
            );
            if (title && !excluded.has(title.titleId)) {
                titleIds.push({
                    platform: range.platform,
                    titleId: title.titleId,
                });
            }

            current += 0x100n;
        }
    }

    return titleIds;
}

function isSkippableCdnError(
    platform: TitleLookupPlatform,
    error: unknown
): boolean {
    return (
        isHttpErrorStatus(error, 403) ||
        isHttpErrorStatus(error, 404) ||
        isHttpErrorStatus(error, 503) ||
        isHttpErrorStatus(error, 504) ||
        (platform === '3ds' && isFetchFailedTitleLookupError(error))
    );
}

function isFetchFailedTitleLookupError(error: unknown): boolean {
    return (
        error instanceof HttpError &&
        error.status === 500 &&
        error.details === 'fetch failed'
    );
}

function formatTitleLogProgress(index: number, total: number): string {
    return `[${index + 1} / ${total}]`;
}

function getNusLogTitle(
    title: RawTitleDatabaseEntry,
    supplementalTitle: RawTitleDatabaseEntry | undefined
): RawTitleDatabaseEntry {
    return {
        ...title,
        name: title.name || supplementalTitle?.name || '',
        region: title.region || supplementalTitle?.region || '',
        productCode: title.productCode || supplementalTitle?.productCode || '',
    };
}

function logTitleResult(
    index: number,
    total: number,
    titleId: string,
    title?: RawTitleDatabaseEntry
): void {
    const statusPrefix = formatTitleLogProgress(index, total);
    const detailPrefix = ''.padEnd(statusPrefix.length);
    const productCode = title?.productCode;
    const region = title?.region;

    const titleParts = [
        titleId,
        productCode ? `- ${productCode}` : '',
        region ? `[${region}]` : '',
    ].filter((part) => part !== '');

    const lines = [`${statusPrefix} ${titleParts.join(' ')}`];

    if (title) {
        const name = title.name;
        if (name) {
            lines.push(`${detailPrefix} ${name}`);
        }

        lines.push(
            `${detailPrefix} base:   ${versionsText(title.baseVersions)}`,
            `${detailPrefix} update: ${versionsText(title.updateVersions)}`,
            `${detailPrefix} dlc:    ${versionsText(title.dlcVersions)}`
        );
    }

    console.log(lines.join('\n'));
}

function hasTitleLookupMetadata(
    metadata: TitleLookupResponse | null
): metadata is TitleLookupResponse {
    if (metadata === null || metadata.titleId === undefined) {
        return false;
    }

    return (
        metadata.baseVersions.length > 0 ||
        metadata.updateVersions.length > 0 ||
        metadata.dlcVersions.length > 0
    );
}

function getDefaultAvailableOnCdn(platform: TitleLookupPlatform): boolean {
    switch (platform) {
        case '3ds':
            return false;
        case 'wiiu':
            return true;
    }
}

async function processNusCacheTitle(
    platform: TitleLookupPlatform,
    titleId: string,
    index: number,
    total: number,
    supplementalTitleById: Map<string, RawTitleDatabaseEntry>
): Promise<RawTitleDatabaseEntry | null> {
    const metadata = await loadTitleLookupMetadata(platform, titleId);

    if (!hasTitleLookupMetadata(metadata)) {
        return null;
    }

    const title = createNusTitleFromMetadata(platform, metadata);
    const supplementalTitle =
        supplementalTitleById.get(title.titleId) ??
        supplementalTitleById.get(titleId);

    logTitleResult(
        index,
        total,
        titleId,
        getNusLogTitle(title, supplementalTitle)
    );

    return title;
}

async function loadTitleLookupMetadata(
    platform: TitleLookupPlatform,
    titleId: string
): Promise<TitleLookupResponse | null> {
    try {
        return await requestJson<TitleLookupResponse>(
            formatUrl(titleUrl, platform, titleId)
        );
    } catch (error) {
        if (isSkippableCdnError(platform, error)) {
            return null;
        }

        throw error;
    }
}

function createNusTitleFromMetadata(
    platform: TitleLookupPlatform,
    metadata: TitleLookupResponse
): RawTitleDatabaseEntry {
    const productCode = metadata.productCode ?? null;
    const name = metadata.name ? normalizeTitleName(metadata.name) : '';

    return {
        titleId: metadata.titleId,
        name,
        region:
            normalizeRegion(null, productCode) ||
            normalizeRegion(metadata.region ?? null, null),
        productCode,
        companyCode: metadata.companyCode ?? null,
        iconUrl: metadata.iconUrl ?? null,
        baseVersions: metadata.baseVersions,
        updateVersions: metadata.updateVersions,
        dlcVersions: metadata.dlcVersions,
        availableOnCdn:
            metadata.availableOnCdn ?? getDefaultAvailableOnCdn(platform),
    };
}

function versionsText(versions: number[]): string {
    return versions.length === 0 ? 'none' : versions.join(',');
}

async function loadTitles(
    excluded: Set<string>,
    options: GenerateOptions
): Promise<RawTitleDatabaseEntry[]> {
    const supplementalTitles = mergeTitleEntries([
        ...(await loadWiiTitles()),
        ...(await loadWiiUTitles()),
        ...(await loadThreeDSTitles()),
    ]).filter((title) => !excluded.has(title.titleId));

    const supplementalTitleById = new Map(
        supplementalTitles.map((title) => [title.titleId, title])
    );

    const nusTitles = await loadOrRefreshNusTitles(
        excluded,
        options,
        supplementalTitleById
    );

    return sortByTitleId(
        mergeTitleEntries([...nusTitles, ...supplementalTitles])
    );
}

async function loadWiiTitles(): Promise<RawTitleDatabaseEntry[]> {
    return [...(await loadWiiTdbTitles())];
}

async function loadWiiUTitles(): Promise<RawTitleDatabaseEntry[]> {
    return [...(await loadWiiUBrewTitles())];
}

async function loadThreeDSTitles(): Promise<RawTitleDatabaseEntry[]> {
    return [...(await loadThreeDSHShopTitles())];
}

async function loadOrRefreshNusTitles(
    excluded: Set<string>,
    options: GenerateOptions,
    supplementalTitleById: Map<string, RawTitleDatabaseEntry>
): Promise<RawTitleDatabaseEntry[]> {
    const activePlatforms = getActiveLookupPlatforms();
    const cacheFiles = getActiveNusCacheFiles(activePlatforms);
    const titles: RawTitleDatabaseEntry[] = [];

    for (const [platform, file] of cacheFiles) {
        if (!options.refreshNus && (await fileExists(file))) {
            titles.push(
                ...filterExcludedTitles(
                    await readNusCache(platform, file),
                    excluded
                )
            );
            continue;
        }

        if (options.refreshNus) {
            console.log(`[nus] ${platform} refreshing scan data`);
        } else {
            console.log(`[nus] ${platform} cache missing; scanning`);
        }

        const platformTitles = await scrapeNusPlatformTitles(
            platform,
            excluded,
            supplementalTitleById
        );

        await writeJson(file, platformTitles);
        console.log(`[nus] ${platform} cache saved:`, platformTitles.length);

        titles.push(...platformTitles);
    }

    return titles;
}

async function scrapeNusPlatformTitles(
    platform: TitleLookupPlatform,
    excluded: Set<string>,
    supplementalTitleById: Map<string, RawTitleDatabaseEntry>
): Promise<RawTitleDatabaseEntry[]> {
    const titleIds = uniqueGeneratedTitleIds(
        generateTitleIds(excluded).filter(
            (title) => title.platform === platform
        )
    ).filter((title) => !excluded.has(title.titleId));

    const titles = (
        await mapPool(titleIds, parallel, (title, index) =>
            processNusCacheTitle(
                title.platform,
                title.titleId,
                index,
                titleIds.length,
                supplementalTitleById
            )
        )
    ).filter((title): title is RawTitleDatabaseEntry => title !== null);

    return sortByTitleId(mergeTitleEntries(titles));
}

function getActiveNusCacheFiles(
    activePlatforms: Set<TitleLookupPlatform>
): Map<TitleLookupPlatform, string> {
    const files = new Map<TitleLookupPlatform, string>();

    if (activePlatforms.has('3ds')) {
        files.set('3ds', threeDSNusFile);
    }
    if (activePlatforms.has('wiiu')) {
        files.set('wiiu', wiiUNusFile);
    }

    return files;
}

async function readNusCache(
    platform: TitleLookupPlatform,
    file: string
): Promise<RawTitleDatabaseEntry[]> {
    const titles = (await readJsonArray(file))
        .filter(isRawTitleDatabaseEntry)
        .filter((title) => getLookupPlatform(title.titleId) === platform);

    console.log(`[nus] ${platform} cached titles:`, titles.length);

    return titles;
}

function filterExcludedTitles(
    titles: RawTitleDatabaseEntry[],
    excluded: Set<string>
): RawTitleDatabaseEntry[] {
    return titles.filter((title) => !excluded.has(title.titleId));
}

function isRawTitleDatabaseEntry(
    value: unknown
): value is RawTitleDatabaseEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const entry = value as Record<string, unknown>;

    return (
        typeof entry.titleId === 'string' &&
        typeof entry.name === 'string' &&
        Array.isArray(entry.baseVersions) &&
        Array.isArray(entry.updateVersions) &&
        Array.isArray(entry.dlcVersions)
    );
}

function uniqueGeneratedTitleIds(
    titleIds: GeneratedTitleId[]
): GeneratedTitleId[] {
    const byTitleId = new Map<string, GeneratedTitleId>();

    for (const title of titleIds) {
        if (title.titleId !== '' && !byTitleId.has(title.titleId)) {
            byTitleId.set(title.titleId, title);
        }
    }

    return [...byTitleId.values()];
}

function mergeTitleEntries(
    titles: RawTitleDatabaseEntry[]
): RawTitleDatabaseEntry[] {
    const byTitleId = new Map<string, RawTitleDatabaseEntry>();

    for (const title of titles) {
        const existing = byTitleId.get(title.titleId);
        if (!existing) {
            byTitleId.set(title.titleId, title);
            continue;
        }

        byTitleId.set(title.titleId, {
            ...existing,
            ...title,
            name: title.name !== '' ? title.name : existing.name,
            region: title.region || existing.region,
            productCode: title.productCode ?? existing.productCode,
            companyCode: title.companyCode ?? existing.companyCode,
            iconUrl: title.iconUrl ?? existing.iconUrl,
            baseVersions: mergeVersions(
                existing.baseVersions,
                title.baseVersions
            ),
            updateVersions: mergeVersions(
                existing.updateVersions,
                title.updateVersions
            ),
            dlcVersions: mergeVersions(existing.dlcVersions, title.dlcVersions),
            availableOnCdn: existing.availableOnCdn || title.availableOnCdn,
        });
    }

    return [...byTitleId.values()];
}

function mergeVersions(a: number[], b: number[]): number[] {
    return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

async function loadWiiTdbTitles(): Promise<RawTitleDatabaseEntry[]> {
    if (!(await fileExists(wiiTdbFile))) {
        return [];
    }

    const parsed = parser.parse(
        await fs.readFile(wiiTdbFile, 'utf8')
    ) as GameTdbXmlFile;
    const games = toArray(parsed.datafile?.game)
        .filter(isGameTdbGame)
        .filter((game) => !isSkippedGameTdbTitle(game));
    const titles: RawTitleDatabaseEntry[] = [];

    for (const game of games) {
        const productCode = getWiiProductCode(game.id ?? null);
        if (!productCode) {
            continue;
        }

        titles.push({
            titleId: productCode,
            name: normalizeTitleName(
                getGameTdbTitle(
                    getPreferredGameTdbLocale(getGameTdbLocales(game))
                ) ?? productCode
            ),
            region:
                normalizeRegion(null, productCode) ||
                normalizeRegion(game.region ?? null, null),
            productCode,
            companyCode: game.id?.slice(4, 6) || null,
            iconUrl: null,
            baseVersions: [],
            updateVersions: [],
            dlcVersions: [],
            availableOnCdn: false,
        });
    }

    console.log('[wiitdb] titles:', titles.length);

    return titles;
}

async function loadWiiUBrewTitles(): Promise<RawTitleDatabaseEntry[]> {
    if (!(await fileExists(wiiUBrewFile))) {
        return [];
    }

    const rows = parseCsvRows(await fs.readFile(wiiUBrewFile, 'utf8'));
    return rows
        .map((row): RawTitleDatabaseEntry | null => {
            const title = identifyWiiUTitle(row['Title ID']);
            if (!title) {
                return null;
            }
            const { titleId } = title;

            return {
                titleId,
                name: normalizeTitleName(row.Description),
                region: normalizeRegion(row.Region, row['Product Code']),
                productCode: row['Product Code'] ?? null,
                companyCode: row['Company Code'] ?? null,
                iconUrl: null,
                baseVersions: parseVersions(row.Versions),
                updateVersions: [],
                dlcVersions: [],
                availableOnCdn:
                    (row['Available on CDN?'] ?? '').toLowerCase() === 'yes'
                        ? true
                        : false,
            };
        })
        .filter((title): title is RawTitleDatabaseEntry => title !== null);
}

function getThreeDSTitleVersion(
    row: Pick<ThreeDSHShopRow, 'version'>
): number | null {
    if (row.version === 'N/A') {
        return null;
    }

    const version = Number.parseInt(row.version, 10);
    return Number.isFinite(version) ? version : null;
}

function addVersion(versions: number[], version: number | null): void {
    if (version !== null && !versions.includes(version)) {
        versions.push(version);
    }
}

function isThreeDSHShopRow(value: unknown): value is ThreeDSHShopRow {
    return stringFieldRecord(value, [
        'hshopId',
        'titleId',
        'name',
        'version',
        'productCode',
    ]);
}

function isThreeDSHShopIncludedRow(row: ThreeDSHShopRow): boolean {
    return (
        row.titleId !== '0004000001111100' &&
        row.productCode !== 'CTR-N-THEME' &&
        !row.productCode.startsWith('MOD-')
    );
}

async function loadThreeDSHShopTitles(): Promise<RawTitleDatabaseEntry[]> {
    if (!(await fileExists(threeDSHShopFile))) {
        console.log('[hshop] missing file', threeDSHShopFile);
        return [];
    }

    const rows = (await readJsonArray(threeDSHShopFile)).filter(
        isThreeDSHShopRow
    );
    const titles = new Map<string, RawTitleDatabaseEntry>();
    let skipped = 0;

    for (const row of rows) {
        if (!isThreeDSHShopIncludedRow(row)) {
            skipped++;
            continue;
        }

        const title = identifyThreeDSTitle(row.titleId ?? '');
        const productCode = row.productCode;
        if (!title) {
            skipped++;
            continue;
        }

        const baseTitleId = replaceTitleKind(title.titleId, TitleKinds.Base);
        let entry = titles.get(baseTitleId);
        if (!entry) {
            entry = {
                titleId: baseTitleId,
                name: normalizeTitleName(row.name),
                region: normalizeRegion(null, productCode),
                productCode,
                companyCode: null,
                iconUrl: null,
                baseVersions: [],
                updateVersions: [],
                dlcVersions: [],
                availableOnCdn: false,
            };
            titles.set(baseTitleId, entry);
        }

        const version = getThreeDSTitleVersion(row);
        switch (title.kind) {
            case TitleKinds.Base:
            case TitleKinds.Demo:
                entry.name = normalizeTitleName(row.name);
                entry.region = normalizeRegion(null, productCode);
                entry.productCode = productCode;
                addVersion(entry.baseVersions, version);
                break;
            case TitleKinds.Update:
                addVersion(entry.updateVersions, version);
                break;
            case TitleKinds.DLC:
                addVersion(entry.dlcVersions, version);
                break;
            default:
                break;
        }
    }

    const entries = [...titles.values()];
    for (const entry of entries) {
        entry.baseVersions.sort((a, b) => a - b);
        entry.updateVersions.sort((a, b) => a - b);
        entry.dlcVersions.sort((a, b) => a - b);
    }

    console.log('[hshop] rows:', rows.length);
    console.log('[hshop] skipped rows:', skipped);
    console.log('[hshop] usable titles:', entries.length);

    return entries;
}

function parseCsvRows(text: string): CsvRow[] {
    const parsed = CsvParse(text, {
        bom: true,
        columns: true,
        relaxColumnCount: true,
        skipEmptyLines: true,
    });

    const rows: CsvRow[] = [];
    for (const value of toArray(parsed as unknown)) {
        if (typeof value !== 'object' || value === null) {
            continue;
        }
        const row: CsvRow = {};
        for (const [key, item] of Object.entries(value)) {
            row[key] = typeof item === 'string' ? item : '';
        }
        rows.push(row);
    }
    return rows;
}

async function loadSamuraiIcons(): Promise<Icon[] | null> {
    try {
        const xml = await fetchTextInsecure(samuraiContentsUrl);
        const parsed = parser.parse(xml) as SamuraiResponse;
        const contents = parsed.eshop?.contents?.content;
        const contentEntries = toArray(contents);
        const icons: Icon[] = [];

        for (const { title } of contentEntries) {
            const titleId =
                identifyWiiUTitle(title?.['@id'] ?? '')?.titleId ?? '';
            const iconUrl = title?.icon_url ?? '';

            if (titleId !== '' && iconUrl !== '') {
                icons.push({ titleId, iconUrl });
            }
        }

        return sortByTitleId(uniqueByTitleId(icons));
    } catch {
        return null;
    }
}

function uniqueByTitleId<T extends { titleId: string }>(entries: T[]): T[] {
    const byTitleId = new Map<string, T>();

    for (const entry of entries) {
        if (!byTitleId.has(entry.titleId)) {
            byTitleId.set(entry.titleId, entry);
        }
    }

    return [...byTitleId.values()];
}

async function mergeSamuraiIcons(): Promise<void> {
    const samuraiIcons = await loadSamuraiIcons();

    if (samuraiIcons === null) {
        console.log(
            'Skipping Samurai icon supplement: fetch or XML conversion failed'
        );
        return;
    }

    const icons = (await readJsonArray(iconsFile))
        .filter(isIcon)
        .map((icon) => ({
            titleId: icon.titleId,
            iconUrl: icon.iconUrl,
        }))
        .filter((icon) => icon.titleId !== '');
    const existing = new Set(icons.map((icon) => icon.titleId));

    await writeJson(
        iconsFile,
        sortByTitleId([
            ...icons,
            ...samuraiIcons.filter((icon) => !existing.has(icon.titleId)),
        ])
    );

    console.log(`Icon data saved to ${iconsFile}`);
}

async function downloadWiiUTdbXml(): Promise<void> {
    console.log(`Downloading ${wiiUTdbZipUrl}`);
    const zip = new Zip(await fetchBinary(wiiUTdbZipUrl));
    const entry = zip.getEntry('wiiutdb.xml');
    if (!entry) {
        throw new Error(`Missing wiiutdb.xml in ${wiiUTdbZipUrl}`);
    }

    await fs.writeFile(wiiUTdbFile, entry.getData());
    console.log(`Extracted ${wiiUTdbFile}`);
}

async function downloadWiiTdbXml(): Promise<void> {
    console.log(`Downloading ${wiiTdbZipUrl}`);
    const zip = new Zip(await fetchBinary(wiiTdbZipUrl));
    const entry = zip.getEntry('wiitdb.xml');
    if (!entry) {
        throw new Error(`Missing wiitdb.xml in ${wiiTdbZipUrl}`);
    }

    await fs.mkdir(path.dirname(wiiTdbFile), { recursive: true });
    await fs.writeFile(wiiTdbFile, entry.getData());
    console.log(`Extracted ${wiiTdbFile}`);
}

async function downloadThreeDSTdbXml(): Promise<void> {
    console.log(`Downloading ${threeDSTdbZipUrl}`);
    const zip = new Zip(await fetchBinary(threeDSTdbZipUrl));
    const entry = zip.getEntry('3dstdb.xml');
    if (!entry) {
        throw new Error(`Missing 3dstdb.xml in ${threeDSTdbZipUrl}`);
    }

    await fs.writeFile(threeDSTdbFile, entry.getData());
    console.log(`Extracted ${threeDSTdbFile}`);
}

function isIcon(value: unknown): value is Icon {
    return stringFieldRecord(value, ['titleId', 'iconUrl']);
}

async function applyIcons(file: string, icons: Icon[]): Promise<void> {
    if (!(await fileExists(file))) {
        return;
    }

    const iconByTitleId = new Map(
        icons.map((icon) => [icon.titleId, icon.iconUrl])
    );
    const titles = (await readJsonArray(file)).filter((value) =>
        stringFieldRecord(value, ['titleId'])
    );

    await writeJson(
        file,
        titles.map((title) => ({
            ...title,
            iconUrl: iconByTitleId.get(title.titleId) ?? null,
        }))
    );
}

async function fileExists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const options = parseGenerateOptions(process.argv.slice(2));

    await downloadWiiTdbXml();
    await downloadWiiUTdbXml();
    await downloadThreeDSTdbXml();

    const excluded = titleIdSet(await readJsonArray(excludeFile));
    const titles = await loadTitles(excluded, options);

    await writeJson(titlesFile, titles);
    console.log(`Title data saved to ${titlesFile}`);

    await mergeSamuraiIcons();

    const icons = (await readJsonArray(iconsFile)).filter(isIcon);
    await applyIcons(titlesFile, icons);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
