import { open, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { normalizeRegion } from '../../shared/regions.js';
import logger from '../../shared/logger.js';
import {
    CHILD_KINDS,
    ChildKind,
    getThreeDSProductCode,
    identifyThreeDSTitle,
    mergeTitleEntry,
    normalizeTitleName,
    type RawTitleDatabaseEntry,
    type TitleDatabaseEntry,
    type TitleDetails,
    type TitleGroup,
    TitleKinds,
    type TitleMediaType,
    TitlePlatform,
} from '../../shared/titles.js';
import {
    getGameTdbLocales,
    getPreferredGameTdbSynopsis,
    type GameTdbGame,
    readCachedGameTdbMedia,
    readGameTdbMedia,
} from '../gametdb.js';
import {
    cacheTitleMedia,
    readCachedTitleMedia,
    type CachedImage,
} from '../image-cache.js';
import {
    cacheLocalTitleIcon,
    createEmptyTitleGroup,
    createExpectedChildren,
    findFirstReadableTitleRoot,
    findLibraryItems,
    findTitleSourcePathsInRoots,
    getAvailableEntries,
    getGroupStatus,
    getParentByKind,
    getTitleMediaUrl,
    type LibraryCacheTitleEntry,
    mergeLibraryTitleGroups,
    parseGameTdbInputControls,
    parseGameTdbNumber,
    readGameTdb as readLibraryGameTdb,
    readTitleDatabase as readLibraryTitleDatabase,
    readTitleDatabaseByProductCode,
    readTitleMedia,
    scanCachedTitleEntries,
    scanTitleRoots,
    splitGameTdbList,
} from '../library.js';
import {
    decryptAes128Ctr,
    decryptContentWithIv,
    decryptTitleKey,
    deriveThreeDSNormalKey,
} from '../decryption.js';
import {
    CIA_HEADER_MIN_SIZE,
    getCiaContentStorageSize,
    isCiaContentPresent,
    readCiaHeader,
    readCiaTmdContents,
    TICKET_ENCRYPTED_TITLE_KEY_OFFSET,
    TICKET_ENCRYPTED_TITLE_KEY_SIZE,
    TICKET_TITLE_ID_OFFSET,
    TICKET_TITLE_ID_SIZE,
} from '../formats/cia.js';
import { readCciPartitions } from '../formats/cci.js';
import { inspectExeFsFile } from '../formats/exefs.js';
import {
    createNcchRegionCounter,
    isNcchHeader,
    NCCH_HEADER_SIZE,
    readNcchHeader,
} from '../formats/ncch.js';
import { loadKeys, type ThreeDSKeys } from '../keys.js';
import { inspectSmdhMetadata, readSmdhLargeIconPng } from '../formats/smdh.js';

type ThreeDSTdbGame = GameTdbGame & {
    publisher?: string;
};

type ThreeDSHeaderInfo = {
    titleId: string;
    productCode: string | null;
    version: number | null;
    name: string | null;
    publisher: string | null;
    region: string | null;
    iconPng: Buffer | null;
};

async function loadOptionalThreeDSKeys(): Promise<ThreeDSKeys | null> {
    try {
        return await loadKeys('3ds');
    } catch (error) {
        logger.warn(
            '3ds',
            `Continuing without 3DS keys: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

export type ThreeDSTitleFileValidation = {
    titleId: string | null;
    version: number | null;
    kind: TitleKinds | null;
    status: 'ok' | 'failed';
    failedFileCount: number;
    totalFileCount: number;
    error: string | null;
};

const LIBRARY_SCAN_CONCURRENCY = 8;
const THREE_DS_IMAGE_EXTENSIONS = new Set(['.3ds', '.cci', '.cia']);
const availableOnCdnByTitleId = new Map<string, boolean>();

function getTitleMediaUrls(entry: TitleDatabaseEntry | null): {
    iconUrl: string | null;
    bannerUrl: string | null;
} {
    if (!entry?.productCode) {
        return {
            iconUrl: null,
            bannerUrl: null,
        };
    }

    return {
        iconUrl: getTitleMediaUrl('icons', '3ds', entry.productCode),
        bannerUrl: getTitleMediaUrl('covers', '3ds', entry.productCode),
    };
}

function createGroup(
    family: string,
    name = 'Unknown',
    region: string | null = null
): TitleGroup {
    return createEmptyTitleGroup('3ds', family, name, region);
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const database = JSON.parse(jsonText) as Record<string, unknown>;
    const json = database['3ds'] as RawTitleDatabaseEntry[];

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain a 3ds array');
    }

    const entries = json
        .map((entry): TitleDatabaseEntry | null => {
            const title = identifyThreeDSTitle(entry.titleId);
            if (!title) {
                return null;
            }

            const productCode = getThreeDSProductCode(entry.productCode);

            return {
                platform: title.platform,
                titleId: title.titleId,
                name: normalizeTitleName(entry.name),
                region: normalizeRegion(entry.region, productCode),
                companyCode: entry.companyCode?.length
                    ? entry.companyCode
                    : null,
                productCode,
                iconUrl: entry.iconUrl,
                bannerUrl: entry.bannerUrl ?? null,

                baseVersions:
                    entry.baseVersions?.filter((version) =>
                        Number.isFinite(version)
                    ) ?? [],
                updateVersions: entry.updateVersions ?? [],
                dlcVersions: entry.dlcVersions ?? [],

                family: title.family,
                availableOnCdn: entry.availableOnCdn,
            };
        })
        .filter((entry): entry is TitleDatabaseEntry => entry !== null);

    return entries;
}

async function readTitleDatabase(): Promise<Map<string, TitleDatabaseEntry>> {
    return readLibraryTitleDatabase({
        logNamespace: '3ds',
        required: true,
        parseEntries: parseTitleDatabaseEntries,
        onEntry: (entry) => {
            if (entry.availableOnCdn === undefined) {
                return;
            }
            availableOnCdnByTitleId.set(
                entry.titleId,
                entry.availableOnCdn === true
            );
        },
    });
}

async function readGameTdb(): Promise<Map<string, TitleDetails>> {
    return readLibraryGameTdb<ThreeDSTdbGame>({
        fileName: '3ds/tdb.xml',
        logNamespace: '3ds',
        getId: (game) => getThreeDSProductCode(game.id ?? null),
        parseDetails: parseGameTdbDetails,
    });
}

function parseGameTdbDetails(game: ThreeDSTdbGame): TitleDetails {
    return {
        tvFormat: game.region ?? null,
        languages: splitGameTdbList(game.languages),
        synopsis: getPreferredGameTdbSynopsis(getGameTdbLocales(game)),
        developer: (game.developer ?? game.publisher)?.trim() || null,
        genre: splitGameTdbList(game.genre),
        inputPlayers: parseGameTdbNumber(game.input?.['@players']),
        inputControls: parseGameTdbInputControls(game),
        sizeBytes: parseGameTdbNumber(game.rom?.['@size']),
    };
}

async function readChunk(filePath: string, offset: number, length: number) {
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function readChunkFromHandle(
    handle: FileHandle,
    offset: number,
    length: number
): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
}

async function readDecryptedCiaContentRange(
    handle: FileHandle,
    contentOffset: number,
    contentSize: number,
    titleKey: Buffer,
    contentIv: Buffer,
    offset: number,
    length: number
): Promise<Buffer> {
    if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset > contentSize ||
        length > contentSize - offset
    ) {
        return Buffer.alloc(0);
    }
    if (length === 0) {
        return Buffer.alloc(0);
    }

    const blockStart = Math.floor(offset / 16) * 16;
    const blockEnd = Math.ceil((offset + length) / 16) * 16;
    if (blockEnd > getCiaContentStorageSize({ size: contentSize })) {
        return Buffer.alloc(0);
    }

    const iv =
        blockStart === 0
            ? contentIv
            : await readChunkFromHandle(
                  handle,
                  contentOffset + blockStart - 16,
                  16
              );
    const encrypted = await readChunkFromHandle(
        handle,
        contentOffset + blockStart,
        blockEnd - blockStart
    );
    if (iv.length !== 16 || encrypted.length !== blockEnd - blockStart) {
        return Buffer.alloc(0);
    }

    return decryptContentWithIv(encrypted, titleKey, iv).subarray(
        offset - blockStart,
        offset - blockStart + length
    );
}

async function readThreeDSHeader(
    filePath: string
): Promise<ThreeDSHeaderInfo | null> {
    const extension = path.extname(filePath).toLowerCase();
    switch (extension) {
        case '.cia':
            return readCiaMetadata(filePath);
        case '.3ds':
        case '.cci':
            return readCciMetadata(filePath);
        default:
            return null;
    }
}

async function readCciMetadata(
    filePath: string
): Promise<ThreeDSHeaderInfo | null> {
    const cciHeader = await readChunk(filePath, 0, NCCH_HEADER_SIZE);
    const partitions = readCciPartitions(cciHeader);
    if (!partitions) {
        return null;
    }

    const keys = await loadOptionalThreeDSKeys();
    const handle = await open(filePath, 'r');
    try {
        for (const partition of partitions) {
            const ncchHeader = await readChunkFromHandle(
                handle,
                partition.offset,
                NCCH_HEADER_SIZE
            );
            if (!isNcchHeader(ncchHeader)) {
                continue;
            }

            const metadata = await readNcchLocalMetadata({
                header: ncchHeader,
                keys,
                readRange: (offset, length) =>
                    readChunkFromHandle(
                        handle,
                        partition.offset + offset,
                        Math.min(length, partition.size - offset)
                    ),
            });
            if (metadata) {
                return metadata;
            }
        }
    } finally {
        await handle.close();
    }

    return null;
}

async function readCiaMetadata(
    filePath: string
): Promise<ThreeDSHeaderInfo | null> {
    const keys = await loadOptionalThreeDSKeys();
    const header = await readChunk(filePath, 0, CIA_HEADER_MIN_SIZE);
    const ciaHeader = readCiaHeader(header);
    if (!ciaHeader) {
        return null;
    }

    const [ticket, tmd] = await Promise.all([
        readChunk(filePath, ciaHeader.ticketOffset, ciaHeader.ticketSize),
        readChunk(filePath, ciaHeader.tmdOffset, ciaHeader.tmdSize),
    ]);

    if (
        ticket.length < TICKET_TITLE_ID_OFFSET + TICKET_TITLE_ID_SIZE ||
        ticket.length <
            TICKET_ENCRYPTED_TITLE_KEY_OFFSET + TICKET_ENCRYPTED_TITLE_KEY_SIZE
    ) {
        return null;
    }

    const titleIdBytes = ticket.subarray(
        TICKET_TITLE_ID_OFFSET,
        TICKET_TITLE_ID_OFFSET + TICKET_TITLE_ID_SIZE
    );
    const fallbackTitleId = Buffer.from(titleIdBytes).toString('hex');
    const contents = readCiaTmdContents(tmd).filter((content) =>
        isCiaContentPresent(ciaHeader, content.index)
    );
    const fallbackContent = contents[0] ?? null;

    if (!keys || !keys.slot0x3dKeyX || !fallbackContent) {
        return fallbackCiaMetadata(fallbackTitleId);
    }

    const handle = await open(filePath, 'r');
    try {
        let encryptedContentOffset = ciaHeader.contentOffset;
        for (const content of contents) {
            const contentOffset = encryptedContentOffset;
            encryptedContentOffset += getCiaContentStorageSize(content);

            for (const commonKeyY of keys.commonKeyYs) {
                if (!commonKeyY) {
                    continue;
                }
                const commonKey = deriveThreeDSNormalKey(
                    decodeHexKey(keys.slot0x3dKeyX),
                    decodeHexKey(commonKeyY),
                    decodeHexKey(keys.generatorConstant)
                );
                const titleKey = decryptTitleKey(
                    ticket.subarray(
                        TICKET_ENCRYPTED_TITLE_KEY_OFFSET,
                        TICKET_ENCRYPTED_TITLE_KEY_OFFSET +
                            TICKET_ENCRYPTED_TITLE_KEY_SIZE
                    ),
                    commonKey,
                    titleIdBytes
                );
                const contentIv = Buffer.alloc(16);
                contentIv.writeUInt16BE(content.index, 0);
                const readRange = (offset: number, length: number) =>
                    readDecryptedCiaContentRange(
                        handle,
                        contentOffset,
                        content.size,
                        titleKey,
                        contentIv,
                        offset,
                        length
                    );
                const decryptedHeader = await readRange(0, NCCH_HEADER_SIZE);
                if (!isNcchHeader(decryptedHeader)) {
                    continue;
                }

                const metadata = await readNcchLocalMetadata({
                    header: decryptedHeader,
                    keys,
                    readRange,
                });
                if (metadata) {
                    return metadata;
                }
            }
        }
    } finally {
        await handle.close();
    }

    return fallbackCiaMetadata(fallbackTitleId);
}

function fallbackCiaMetadata(titleId: string): ThreeDSHeaderInfo | null {
    const title = identifyThreeDSTitle(titleId);
    if (!title) {
        return null;
    }

    return {
        titleId: title.titleId,
        productCode: null,
        version: null,
        name: null,
        publisher: null,
        region: null,
        iconPng: null,
    };
}

type NcchLocalMetadataOptions = {
    header: Buffer;
    keys: ThreeDSKeys | null;
    readRange: (offset: number, length: number) => Promise<Buffer>;
};

async function readNcchLocalMetadata({
    header,
    keys,
    readRange,
}: NcchLocalMetadataOptions): Promise<ThreeDSHeaderInfo | null> {
    if (!isNcchHeader(header)) {
        return null;
    }

    const ncchHeader = readNcchHeader(header);
    if (!ncchHeader) {
        return null;
    }

    const productCode = getThreeDSProductCode(ncchHeader.productCode);
    const metadata: ThreeDSHeaderInfo = {
        titleId: ncchHeader.titleId,
        productCode,
        version: ncchHeader.version,
        name: null,
        publisher: null,
        region: null,
        iconPng: null,
    };

    const exefs = await readNcchExeFs(header, keys, readRange);
    if (!exefs) {
        return metadata;
    }

    const iconResult = inspectExeFsFile(exefs, 'icon');
    if (!iconResult.ok) {
        return metadata;
    }

    const smdhResult = inspectSmdhMetadata(iconResult.file);
    if (smdhResult.ok) {
        metadata.name = smdhResult.metadata.name;
        metadata.publisher = smdhResult.metadata.publisher;
        metadata.region = smdhResult.metadata.region;
    }
    metadata.iconPng = readSmdhLargeIconPng(iconResult.file);

    return metadata;
}

async function readNcchExeFs(
    header: Buffer,
    keys: ThreeDSKeys | null,
    readRange: (offset: number, length: number) => Promise<Buffer>
): Promise<Buffer | null> {
    const ncchHeader = readNcchHeader(header);
    if (
        !ncchHeader ||
        ncchHeader.exefsOffset <= 0 ||
        ncchHeader.exefsSize <= 0
    ) {
        return null;
    }

    const exefs = await readRange(ncchHeader.exefsOffset, ncchHeader.exefsSize);
    if (ncchHeader.noCrypto) {
        return exefs;
    }
    if (!keys?.slot0x2cKeyX) {
        return null;
    }

    const normalKey = deriveThreeDSNormalKey(
        decodeHexKey(keys.slot0x2cKeyX),
        header.subarray(0, 16),
        decodeHexKey(keys.generatorConstant)
    );
    return decryptAes128Ctr(
        exefs,
        normalKey,
        createNcchRegionCounter(header, ncchHeader.exefsOffset, 2)
    );
}

async function findTitleFiles(root: string): Promise<string[]> {
    return findLibraryItems(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: '3ds',
        platform: '3ds',
        includeFile: (entry) =>
            THREE_DS_IMAGE_EXTENSIONS.has(
                path.extname(entry.name).toLowerCase()
            ),
    });
}

async function readTitleEntry(
    root: string,
    filename: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry | null> {
    const filePath = path.join(root, filename);
    const header = await readThreeDSHeader(filePath);
    if (!header) {
        return null;
    }

    const titleIdentity = identifyThreeDSTitle(header.titleId);
    if (!titleIdentity) {
        return null;
    }

    const family = titleIdentity.family ?? header.titleId;
    const kind =
        titleIdentity.kind === TitleKinds.Unknown
            ? TitleKinds.Base
            : titleIdentity.kind;
    const databaseEntry = titleDatabase.get(family) ?? null;

    const titleUrls = getTitleMediaUrls(databaseEntry);
    const productCode = getThreeDSProductCode(
        databaseEntry?.productCode ?? header.productCode
    );
    const fileInfo = await stat(filePath);
    const localIconUrl = productCode
        ? getTitleMediaUrl('icons', '3ds', productCode)
        : null;

    if (productCode && header.iconPng) {
        await cacheTitleMedia('icons', '3ds', productCode, {
            body: header.iconPng,
            contentType: 'image/png',
        });
    }
    const sidecarIconUrl = await cacheLocalTitleIcon(
        '3ds',
        productCode,
        filePath
    );

    return {
        titleId: titleIdentity.titleId,
        platform: titleIdentity.platform,
        name: getTitleName(
            filename,
            databaseEntry?.name ?? header.name ?? null
        ),
        region: normalizeRegion(
            databaseEntry?.region ?? header.region ?? null,
            productCode
        ),
        version: header.version,

        iconUrl: sidecarIconUrl ?? titleUrls.iconUrl ?? localIconUrl,
        bannerUrl:
            titleUrls.bannerUrl ??
            (databaseEntry && productCode
                ? getTitleMediaUrl('covers', '3ds', productCode)
                : null),

        kind,
        family,

        sizeBytes: fileInfo.size,
        copyCount: 1,
        sourcePath: filePath,
        productCode,
    };
}

async function scanTitleEntries(
    root: string,
    titleDatabase: Map<string, TitleDatabaseEntry>
): Promise<LibraryCacheTitleEntry[]> {
    return scanCachedTitleEntries(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: '3ds',
        findItems: findTitleFiles,
        readEntry: readTitleEntry,
        context: titleDatabase,
    });
}

async function scanThreeDSTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb] = await Promise.all([
        readTitleDatabase(),
        readGameTdb(),
    ]);

    const scanned = await scanTitleEntries(root, titleDatabase);

    const groups = new Map<string, TitleGroup>();

    for (const entry of scanned) {
        let group = groups.get(entry.family);

        if (!group) {
            group = createGroup(entry.family);
            groups.set(entry.family, group);
        }

        mergeTitleEntry(group.entries, entry);
    }

    for (const family of titleDatabase.keys()) {
        if (!groups.has(family)) {
            groups.set(family, createGroup(family));
        }
    }

    for (const group of groups.values()) {
        const databaseEntry = titleDatabase.get(group.family) ?? null;
        const entries = group.entries as LibraryCacheTitleEntry[];
        const parentEntry = getParentByKind(entries);
        const firstLocalChild =
            entries.find((entry) =>
                CHILD_KINDS.includes(entry.kind as ChildKind)
            ) ?? null;
        const fallbackEntry = parentEntry ?? firstLocalChild;
        const productCode: string | null =
            databaseEntry?.productCode ?? fallbackEntry?.productCode ?? null;
        const titleUrls = getTitleMediaUrls(databaseEntry);

        group.productCode = productCode;
        group.titleInDatabase = databaseEntry !== null;
        group.details = databaseEntry
            ? getGameTdbDetails(gameTdb, databaseEntry)
            : productCode
              ? (gameTdb.get(productCode) ?? null)
              : null;
        group.availableEntries = getAvailableEntries(
            databaseEntry,
            getTitleAvailableOnCdn
        );
        group.expectedChildren = createExpectedChildren(databaseEntry);
        group.status = getGroupStatus(group);

        if (parentEntry) {
            group.name = parentEntry.name;
            group.region = parentEntry.region;
            group.iconUrl = titleUrls.iconUrl ?? parentEntry.iconUrl;
            group.bannerUrl = titleUrls.bannerUrl ?? parentEntry.bannerUrl;
        } else if (databaseEntry) {
            group.name = databaseEntry.name;
            group.region = databaseEntry.region;
            group.iconUrl = titleUrls.iconUrl;
            group.bannerUrl = titleUrls.bannerUrl;
        } else {
            group.name = fallbackEntry?.name ?? 'Unknown';
            group.region = fallbackEntry?.region ?? null;
            group.iconUrl = fallbackEntry?.iconUrl ?? null;
            group.bannerUrl = fallbackEntry?.bannerUrl ?? null;
        }

        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getTitleName(filename: string, databaseName: string | null): string {
    if (databaseName && databaseName.length > 0) {
        return normalizeTitleName(databaseName);
    }

    const cleaned = cleanDirectoryName(filename);

    if (cleaned.length > 0) {
        return cleaned;
    }

    return 'Unknown';
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    return mergeLibraryTitleGroups(groups, {
        afterMergeGroup: (group) => {
            group.status = getGroupStatus(group);
        },
    });
}

export async function scanThreeDSTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    return scanTitleRoots(roots, {
        platform: '3ds',
        logNamespace: '3ds',
        scanTitles: scanThreeDSTitles,
        mergeTitleGroups,
        resultLabel: 'title group(s)',
    });
}

function decodeHexKey(key: string): Buffer {
    return Buffer.from(key, 'hex');
}

export async function readThreeDSTitleIdentity(titlePath: string): Promise<{
    titleId: string;
    version: number | null;
    kind: TitleKinds;
} | null> {
    const header = await readThreeDSHeader(titlePath);
    if (!header) {
        return null;
    }

    const title = identifyThreeDSTitle(header.titleId);
    if (!title) {
        return null;
    }

    return {
        titleId: title.titleId,
        version: header.version,
        kind: title.kind === TitleKinds.Unknown ? TitleKinds.Base : title.kind,
    };
}

export async function validateThreeDSTitleFile(
    titlePath: string,
    expectedTitleId: string
): Promise<ThreeDSTitleFileValidation> {
    const identity = await readThreeDSTitleIdentity(titlePath);
    const checks: Array<{ ok: boolean; message: string }> = [
        {
            ok: identity !== null,
            message: 'read 3DS title identity',
        },
    ];

    if (identity) {
        checks.push({
            ok: identity.titleId === expectedTitleId,
            message: `expected ${expectedTitleId}, found ${identity.titleId}`,
        });
    }

    checks.push(...(await validateThreeDSFileStructure(titlePath)));

    const failed = checks.filter((check) => !check.ok);
    return {
        titleId: identity?.titleId ?? null,
        version: identity?.version ?? null,
        kind: identity?.kind ?? null,
        status: failed.length === 0 ? 'ok' : 'failed',
        failedFileCount: failed.length,
        totalFileCount: checks.length,
        error: failed.length > 0 ? (failed[0]?.message ?? null) : null,
    };
}

async function validateThreeDSFileStructure(
    titlePath: string
): Promise<Array<{ ok: boolean; message: string }>> {
    const fileSize = (await stat(titlePath)).size;

    switch (path.extname(titlePath).toLowerCase()) {
        case '.cia':
            return validateCiaFileStructure(titlePath, fileSize);

        case '.3ds':
        case '.cci':
            return validateCciFileStructure(titlePath, fileSize);

        default:
            return [
                {
                    ok: false,
                    message: `Unsupported 3DS file extension: ${path.extname(titlePath)}`,
                },
            ];
    }
}

async function validateCciFileStructure(
    titlePath: string,
    fileSize: number
): Promise<Array<{ ok: boolean; message: string }>> {
    const checks: Array<{ ok: boolean; message: string }> = [];
    const header = await readChunk(titlePath, 0, NCCH_HEADER_SIZE);
    checks.push({
        ok: header.length === NCCH_HEADER_SIZE,
        message: 'read CCI header',
    });

    const partitions = readCciPartitions(header);
    checks.push({
        ok: partitions !== null && partitions.length > 0,
        message: 'read CCI partition table',
    });
    if (!partitions) {
        return checks;
    }

    const handle = await open(titlePath, 'r');
    try {
        for (const [index, partition] of partitions.entries()) {
            const partitionLabel = `CCI partition ${index.toString()}`;
            const inBounds =
                partition.size >= NCCH_HEADER_SIZE &&
                partition.offset >= 0 &&
                partition.offset + partition.size <= fileSize;
            checks.push({
                ok: inBounds,
                message: `${partitionLabel} is within file bounds`,
            });
            if (!inBounds) {
                continue;
            }

            const ncchHeader = await readChunkFromHandle(
                handle,
                partition.offset,
                NCCH_HEADER_SIZE
            );
            checks.push({
                ok: ncchHeader.length === NCCH_HEADER_SIZE,
                message: `read ${partitionLabel} NCCH header`,
            });
            checks.push({
                ok: isNcchHeader(ncchHeader),
                message: `${partitionLabel} has NCCH magic`,
            });
        }
    } finally {
        await handle.close();
    }

    return checks;
}

async function validateCiaFileStructure(
    titlePath: string,
    fileSize: number
): Promise<Array<{ ok: boolean; message: string }>> {
    const checks: Array<{ ok: boolean; message: string }> = [];
    const header = await readChunk(titlePath, 0, CIA_HEADER_MIN_SIZE);
    checks.push({
        ok: header.length === CIA_HEADER_MIN_SIZE,
        message: 'read CIA header',
    });

    const ciaHeader = readCiaHeader(header);
    checks.push({
        ok: ciaHeader !== null,
        message: 'parse CIA header',
    });
    if (!ciaHeader) {
        return checks;
    }

    const ticketEnd = ciaHeader.ticketOffset + ciaHeader.ticketSize;
    const tmdEnd = ciaHeader.tmdOffset + ciaHeader.tmdSize;
    checks.push({
        ok: ticketEnd <= fileSize,
        message: 'CIA ticket is within file bounds',
    });
    checks.push({
        ok: tmdEnd <= fileSize,
        message: 'CIA TMD is within file bounds',
    });
    if (tmdEnd > fileSize) {
        return checks;
    }

    const tmd = await readChunk(
        titlePath,
        ciaHeader.tmdOffset,
        ciaHeader.tmdSize
    );
    const tmdContents = readCiaTmdContents(tmd);
    checks.push({
        ok: tmdContents.length > 0,
        message: 'read CIA TMD content table',
    });
    const contents = tmdContents.filter((content) =>
        isCiaContentPresent(ciaHeader, content.index)
    );
    checks.push({
        ok: contents.length > 0,
        message: 'CIA contains at least one indexed content',
    });

    let contentOffset = ciaHeader.contentOffset;
    let contentSize = 0;
    for (const content of contents) {
        const storageSize = getCiaContentStorageSize(content);
        const contentEnd = contentOffset + storageSize;
        checks.push({
            ok: content.size > 0 && contentEnd <= fileSize,
            message: `CIA content ${content.index.toString()} is within file bounds`,
        });
        contentOffset = contentEnd;
        contentSize += storageSize;
    }
    checks.push({
        ok: contentSize === ciaHeader.contentSize,
        message: `CIA indexed content size matches header (${ciaHeader.contentSize.toString()} bytes)`,
    });

    return checks;
}

export async function readThreeDSTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    const normalizedProductCode = getThreeDSProductCode(productCode);
    if (!normalizedProductCode) {
        return null;
    }

    const cached =
        type === 'icons'
            ? await readCachedTitleMedia(type, platform, normalizedProductCode)
            : null;
    if (cached) {
        return cached;
    }

    const gameTdbMedia = await readCachedGameTdbMedia(
        type,
        platform,
        normalizedProductCode
    );
    if (gameTdbMedia) {
        return gameTdbMedia;
    }

    const titleDatabase =
        await readTitleDatabaseByProductCode(readTitleDatabase);

    return readTitleMedia({
        type,
        platform,
        productCode: normalizedProductCode,
        readEntry: (productCode) => titleDatabase.get(productCode) ?? null,
        getUrl: (type, entry) => {
            switch (type) {
                case 'icons':
                    return entry?.iconUrl ?? null;
                case 'covers':
                    return entry?.bannerUrl ?? null;
            }
        },
        fallback: async (type, platform, productCode, entry) => {
            switch (type) {
                case 'icons':
                    return entry
                        ? readGameTdbMedia('icons', platform, productCode, {
                              region: entry.region,
                              name: entry.name,
                          })
                        : null;
                case 'covers':
                    return entry
                        ? readGameTdbMedia(type, platform, productCode, {
                              region: entry.region,
                              name: entry.name,
                          })
                        : null;
            }
        },
    });
}

export async function findThreeDSTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    const titleDatabase = await readTitleDatabase();

    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        (readableRoot) => scanTitleEntries(readableRoot, titleDatabase),
        '3ds',
        '3ds'
    );
}

export async function findFirstReadableThreeDSRoot(
    roots: string[]
): Promise<string> {
    return findFirstReadableTitleRoot(roots, '3ds');
}

function getTitleAvailableOnCdn(titleId: string): boolean {
    return availableOnCdnByTitleId.get(titleId) ?? false;
}

function getGameTdbDetails(
    gameTdb: Map<string, TitleDetails>,
    entry: TitleDatabaseEntry
): TitleDetails | null {
    const id = entry.productCode;
    return id ? (gameTdb.get(id) ?? null) : null;
}

export function cleanDirectoryName(dirname: string): string {
    // Clear [ and anything after it.
    return path
        .basename(dirname)
        .replace(/\s*\[.*$/, '')
        .trim();
}
