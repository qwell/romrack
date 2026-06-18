import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import Zip from 'adm-zip';
import { parse as CsvParse } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

import { normalizeRegion } from '../src/shared/regions.js';
import {
    normalizeWiiUTitle,
    normalizeTitleName,
    RawTitleDatabaseEntry,
} from '../src/shared/titles.js';
import { toArray } from '../src/shared/shared.js';
import { requestJson } from '../src/shared/api.js';
import { isHttpErrorStatus } from '../src/shared/download.js';

type Icon = {
    titleId: string;
    iconUrl: string;
};

type TitleLookupWiiUResponse = {
    titleId?: string;
    name?: string;
    region?: string | null;
    iconUrl?: string | null;
    productCode?: string | null;
    companyCode?: string | null;
    baseVersions?: number[];
    updateVersions?: number[];
    dlcVersions?: number[];
    availableOnCdn?: boolean;
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

type WiiUTdbDatafile = {
    datafile?: {
        game?: unknown;
    };
};

const ranges = [
    '0005000010100000:0005000010220000',
    '000500001f600000:000500001f601f00',
    '000500001f700000:000500001f702f00',
    '000500001f800000:000500001f80ff00',
    '000500001f940e00:000500001f940f00',
    '000500001f943100:000500001f943100',
    '000500001fbf1000:000500001fbf1000',
];

const titleUrl = 'http://localhost:3000/api/title-lookup-wiiu?titleId=%s';
const samuraiContentsUrl =
    'https://samurai.wup.shop.nintendo.net/samurai/ws/US/contents/?shop_id=2&limit=10000';
const wiiUTdbZipUrl = 'https://www.gametdb.com/wiiutdb.zip';

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
});

const root = process.cwd();
const titlesDir = path.join(root, 'titles');

const titlesFile = path.join(titlesDir, 'titles.json');
const iconsFile = path.join(titlesDir, 'icons.json');
const excludeFile = path.join(titlesDir, 'exclude.json');
const titledbFile = path.join(titlesDir, 'titledb.csv');
const wiiUTdbInputFile = path.join(titlesDir, 'wiiutdb.xml');
const wiiUTdbOutputFile = path.join(titlesDir, 'wiiutdb.json');

function formatUrl(template: string, titleId: string): string {
    return template.replace('%s', titleId);
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
            const title = normalizeWiiUTitle(entry.titleId);
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
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return [];
        }

        throw error;
    }
}

async function writeJson(file: string, value: unknown): Promise<void> {
    await fs.writeFile(file, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
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

function generateTitleIds(excluded: Set<string>): string[] {
    const titleIds: string[] = [];

    for (const range of ranges) {
        const [startHex, endHex] = range.split(':');
        let current = BigInt(`0x${startHex}`);
        const end = BigInt(`0x${endHex}`);

        while (current <= end) {
            const title = normalizeWiiUTitle(
                current.toString(16).padStart(16, '0')
            );
            const titleId = title?.titleId ?? '';

            if (!excluded.has(titleId)) {
                titleIds.push(titleId);
            }

            current += 0x100n;
        }
    }

    return titleIds;
}

function isSkippableCdnError(error: unknown): boolean {
    return isHttpErrorStatus(error, 404) || isHttpErrorStatus(error, 504);
}

function formatTitleLogStatus(index: number, status: string): string {
    return `[${index + 1}] ${status.padEnd(4)} `;
}

function logTitleResult(
    index: number,
    status: 'HIT' | 'MISS' | 'CSV',
    titleId: string,
    title?: RawTitleDatabaseEntry
): void {
    const statusPrefix = formatTitleLogStatus(index, status);
    const titleName = title?.name ?? 'Unknown';
    const lines = [`${statusPrefix}${titleId} ${titleName}`];

    if (title) {
        lines.push(
            `${''.padEnd(statusPrefix.length)}base=${versionsText(title.baseVersions)} update=${versionsText(title.updateVersions)} dlc=${versionsText(title.dlcVersions)}`
        );
    }

    console.log(lines.join('\n'));
}

function hasBaseMetadata(metadata: TitleLookupWiiUResponse | null): boolean {
    return (
        metadata !== null &&
        metadata.titleId !== undefined &&
        (metadata.baseVersions?.length ?? 0) > 0
    );
}

async function processTitle(
    titleId: string,
    index: number,
    fallbackTitle?: RawTitleDatabaseEntry
): Promise<RawTitleDatabaseEntry | null> {
    let metadata: TitleLookupWiiUResponse | null;

    try {
        metadata = await requestJson<TitleLookupWiiUResponse>(
            formatUrl(titleUrl, titleId)
        );
    } catch (error) {
        if (isSkippableCdnError(error)) {
            metadata = null;
        } else {
            throw error;
        }
    }

    const updateVersions = metadata?.updateVersions ?? [];
    const dlcVersions = metadata?.dlcVersions ?? [];

    if (!hasBaseMetadata(metadata)) {
        if (fallbackTitle) {
            const title: RawTitleDatabaseEntry = {
                ...fallbackTitle,
                updateVersions,
                dlcVersions,
                availableOnCdn: false,
            };

            logTitleResult(index, 'CSV', title.titleId, title);

            return title;
        }

        logTitleResult(index, 'MISS', titleId);
        return null;
    }

    if (!metadata) {
        return null;
    }

    const title: RawTitleDatabaseEntry = {
        titleId,
        name: normalizeTitleName(metadata.name),
        region: normalizeRegion(metadata.region, metadata.productCode),
        productCode: metadata.productCode ?? null,
        companyCode: metadata.companyCode ?? null,
        iconUrl: null,
        baseVersions: metadata.baseVersions ?? [],
        updateVersions,
        dlcVersions,
        availableOnCdn: true,
    };

    logTitleResult(index, 'HIT', title.titleId, title);

    return title;
}

function versionsText(versions: number[]): string {
    return versions.length === 0 ? 'none' : versions.join(',');
}

async function loadTitles(
    excluded: Set<string>
): Promise<RawTitleDatabaseEntry[]> {
    const fallbackTitles = await loadTitledbTitles();
    const fallbackByTitleId = new Map(
        fallbackTitles.map((title) => [title.titleId, title])
    );
    const titleIds = uniqueTitleIds([
        ...generateTitleIds(excluded),
        ...fallbackTitles.map((title) => title.titleId),
    ]).filter((titleId) => !excluded.has(titleId));
    const titles = await mapPool(titleIds, parallel, (titleId, index) =>
        processTitle(titleId, index, fallbackByTitleId.get(titleId))
    );

    return sortByTitleId(titles.filter((title) => title !== null));
}

function uniqueTitleIds(titleIds: string[]): string[] {
    return [...new Set(titleIds.filter((titleId) => titleId !== ''))];
}

async function loadTitledbTitles(): Promise<RawTitleDatabaseEntry[]> {
    if (!(await fileExists(titledbFile))) {
        return [];
    }

    const rows = parseCsvRows(await fs.readFile(titledbFile, 'utf8'));
    return rows
        .map((row): RawTitleDatabaseEntry | null => {
            const title = normalizeWiiUTitle(row['Title ID']);
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
                normalizeWiiUTitle(title?.['@id'] ?? '')?.titleId ?? '';
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

async function ensureWiiUTdbXml(): Promise<void> {
    if (await fileExists(wiiUTdbInputFile)) {
        return;
    }

    console.log(`Downloading ${wiiUTdbZipUrl}`);
    const zip = new Zip(await fetchBinary(wiiUTdbZipUrl));
    const entry = zip.getEntry('wiiutdb.xml');
    if (!entry) {
        throw new Error(`Missing wiiutdb.xml in ${wiiUTdbZipUrl}`);
    }

    await fs.writeFile(wiiUTdbInputFile, entry.getData());
    console.log(`Extracted ${wiiUTdbInputFile}`);
}

async function convertWiiUTdb(): Promise<void> {
    await ensureWiiUTdbXml();

    const xml = await fs.readFile(wiiUTdbInputFile, 'utf8');
    const json = parser.parse(xml) as WiiUTdbDatafile;

    const games = toArray(json?.datafile?.game);

    await writeJson(wiiUTdbOutputFile, { games });

    console.log(`Converted ${wiiUTdbInputFile} -> ${wiiUTdbOutputFile}`);
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
    await convertWiiUTdb();

    const excluded = titleIdSet(await readJsonArray(excludeFile));
    const titles = await loadTitles(excluded);

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
