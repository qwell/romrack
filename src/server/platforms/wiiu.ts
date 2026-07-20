import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import {
    mkdir,
    open,
    readFile,
    readdir,
    stat,
    writeFile,
    type FileHandle,
} from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeRegion } from '../../shared/regions.js';
import {
    type TitleGroup,
    type TitleDetails,
    type ChildKind,
    type WudTitleEntry,
    CHILD_KINDS,
    DOWNLOADABLE_KINDS,
    PARENT_KINDS,
    mergeTitleEntry,
    identifyTitle,
    getDiscProductCode,
    getDiscTitleId,
    getWiiUProductCode,
    getProductCodeMediaKey,
    normalizeTitleName,
    TitleKinds,
    type TitleDatabaseEntry,
    type RawTitleDatabaseEntry,
    type TitleMediaType,
    type TitlePlatform,
} from '../../shared/titles.js';
import {
    cacheLocalTitleIcon,
    createEmptyTitleGroup,
    createExpectedChildren,
    findFirstReadableTitleRoot,
    findLibraryItems,
    findTitleSourcePathsInRoots,
    getAvailableEntries,
    getGroupStatus,
    getTitleMediaUrl,
    type LibraryCacheTitleEntry,
    mergeLibraryTitleGroups,
    parseGameTdbInputControls,
    parseGameTdbNumber,
    prepareTitleVerifications,
    type PreparedTitleVerification,
    readGameTdb as readLibraryGameTdb,
    readTitleDatabase as readLibraryTitleDatabase,
    readTitleDatabaseByProductCode,
    readTitleMedia,
    scanCachedTitleEntries,
    scanTitleRoots,
    throwIfLibraryVerifyCancelled,
    verifyTitleRoots,
    splitGameTdbList,
} from '../library.js';
import {
    formatLogError,
    formatSize,
    mapConcurrent,
    safeDirectoryName,
} from '../../shared/utils.js';
import {
    getImmediatePathSizeBytes,
    readOptionalFile,
} from '../../shared/file.js';
import {
    getTitleIdHex,
    readTmdFromBuffer,
    TMD_TITLE_FILE,
    type Tmd,
    type TmdContent,
} from '../formats/tmd.js';
import logger from '../../shared/logger.js';
import {
    type LibraryVerifyProgress,
    type LibraryVerifyTitle,
} from '../../shared/api.js';
import {
    createWudContentIv,
    decryptWudContent,
    readDecryptedWudRange,
    readWudDataPartition,
    readWudFstFile,
    readWudGamePartition,
    readWudImageRange,
    readWudPartitionH3,
    readWudPartitionReferences,
    WUD_CLUSTER_SIZE,
    WUD_DECRYPTED_AREA_OFFSET,
    WUD_DECRYPTED_AREA_SIGNATURE,
    WUD_SECTOR_SIZE,
    type WudDataPartition,
    type WudGamePartition,
    type WudImage,
    type WudPartitionReference,
    type WuxInfo,
} from '../formats/wud.js';
import { loadKeys } from '../keys.js';
import { findReadablePath } from '../../shared/os.js';
import {
    getGameTdbLocales,
    getPreferredGameTdbSynopsis,
    type GameTdbGame,
    readCachedGameTdbMedia,
    readGameTdbMedia,
} from '../gametdb.js';
import { readCachedTitleMedia, type CachedImage } from '../image-cache.js';
import {
    findXmlStartByte,
    readMetaXml,
    type MetaXmlInformation,
} from '../formats/meta.js';
import { readWiiGameTdb, readWiiTitleDatabase } from './wii.js';
import { decryptTitleKey } from '../decryption.js';
import {
    downloadContent,
    downloadContentH3ToFile,
    downloadContentToFile,
    downloadOptionalTicket,
    downloadTmd,
    WII_U_NUS_BASE_URL,
    WIIU_META_XML_PATHS,
    CERT_TITLE_FILE,
    createGeneratedCert,
    createGeneratedTik,
    extractMetaXmlFromContentReader,
    extractMetaXmlFromTitle,
    formatInstallDirectoryKind,
    getDownloadableTitle,
    resolveTitleKey,
    TitleMetadataError,
    type DownloadableTitleKind,
} from '../nus.js';
import {
    assertContentSize,
    decryptHashedContent,
    extractHashedContentSlice,
    type ContentTreeVerification,
    getContentInstallNames,
    getContentH3FileSize,
    getEncryptedContentFileSize,
    isHashedContent,
    verifyContent,
} from '../formats/content.js';
import { readTik, TIK_TITLE_FILE, type Tik } from '../formats/tik.js';
import {
    getRootDirectoryChildren,
    parseTitleFstEntries,
} from '../formats/wiiu-fst.js';

const LIBRARY_SCAN_CONCURRENCY = 8;
const WUX_HEADER_SIZE = 0x20;
const WUX_MAGIC_0 = 0x30585557;
const WUX_MAGIC_1 = 0x1099d02e;
const WUX_SECTOR_SIZE_OFFSET = 0x08;
const WUX_UNCOMPRESSED_SIZE_OFFSET = 0x10;
const WUX_INDEX_TABLE_ENTRY_SIZE = 0x04;
const WUD_FILE_EXTENSIONS = new Set(['.wud', '.wux']);
type NUSTitleInformation = MetaXmlInformation;
type PreparedWudGamePartition = WudGamePartition & {
    rawTmd: Buffer;
    rawTicket: Buffer;
    rawCert: Buffer;
};

const PARENT_KIND_SET: ReadonlySet<TitleKinds> = new Set(PARENT_KINDS);
const availableOnCdnByTitleId = new Map<string, boolean>();
type WiiUTitleScanContext = {
    titleDatabase: Map<string, TitleDatabaseEntry>;
    wiiTitleDatabaseByTitleId: Map<string, TitleDatabaseEntry>;
};

type ContentInstallFiles = {
    contentId: string;
    appName: string;
    appFile: string;
    h3Name: string | null;
    h3File: string | null;
};

function getContentInstallFiles(
    dirPath: string,
    content: TmdContent
): ContentInstallFiles {
    const { contentId, appName, h3Name } = getContentInstallNames(content);
    return {
        contentId,
        appName,
        appFile: path.join(dirPath, appName),
        h3Name,
        h3File: h3Name ? path.join(dirPath, h3Name) : null,
    };
}

async function assertExistingContentFileSize(
    filePath: string,
    expectedSize: number,
    contentId: string
): Promise<void> {
    assertContentSize((await stat(filePath)).size, expectedSize, contentId);
}

function readFileChunks(
    filePath: string,
    signal?: AbortSignal
): AsyncIterable<Buffer> {
    const stream = createReadStream(filePath);
    const abort = () =>
        stream.destroy(
            signal?.reason instanceof Error ? signal.reason : undefined
        );
    signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => signal?.removeEventListener('abort', abort));
    return stream;
}

async function verifyContentInstallFiles({
    files,
    content,
    titleKey,
    signal,
}: {
    files: ContentInstallFiles;
    content: TmdContent;
    titleKey: Buffer;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    try {
        const appSize = (await stat(files.appFile)).size;
        const h3 = files.h3File ? await readFile(files.h3File) : null;
        return await verifyContent({
            contentId: files.contentId,
            appSize,
            appChunks: readFileChunks(files.appFile, signal),
            h3,
            content,
            titleKey,
            signal,
        });
    } catch (error) {
        throwIfAborted(signal);
        return {
            contentId: files.contentId,
            status: 'failed',
            error: formatLogError(error),
        };
    }
}

function isWudImagePath(filePath: string): boolean {
    return WUD_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

type OpenedWudImage = WudImage & {
    filePath: string;
    close: () => Promise<void>;
};

async function openWudImage(filePath: string): Promise<OpenedWudImage> {
    const file = await open(filePath, 'r');
    try {
        const header = await readWudFileRange(file, 0n, WUX_HEADER_SIZE);
        const compressedInfo = parseWuxInfo(header);
        return {
            filePath,
            compressed: compressedInfo
                ? await readWuxIndexTable(file, compressedInfo)
                : null,
            read: (offset, size) => readWudFileRange(file, offset, size),
            close: () => file.close(),
        };
    } catch (error) {
        await file.close();
        throw error;
    }
}

async function readWudFileRange(
    file: FileHandle,
    offset: bigint,
    size: number
): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, offset);
    if (bytesRead !== size) {
        throw new Error(
            `Unexpected end of WUD/WUX at offset ${offset.toString()}: expected ${size.toString()} bytes, read ${bytesRead.toString()}`
        );
    }
    return buffer;
}

function parseWuxInfo(header: Buffer): Omit<WuxInfo, 'indexTable'> | null {
    if (
        header.length < WUX_HEADER_SIZE ||
        header.readUInt32LE(0) !== WUX_MAGIC_0 ||
        header.readUInt32LE(4) !== WUX_MAGIC_1
    ) {
        return null;
    }
    const sectorSize = header.readUInt32LE(WUX_SECTOR_SIZE_OFFSET);
    const uncompressedSize = header.readBigUInt64LE(
        WUX_UNCOMPRESSED_SIZE_OFFSET
    );
    const entryCount =
        (uncompressedSize + BigInt(sectorSize) - 1n) / BigInt(sectorSize);
    let offsetSectorArray =
        BigInt(WUX_HEADER_SIZE) +
        entryCount * BigInt(WUX_INDEX_TABLE_ENTRY_SIZE);
    offsetSectorArray += BigInt(sectorSize - 1);
    offsetSectorArray -= offsetSectorArray % BigInt(sectorSize);
    return { sectorSize, uncompressedSize, offsetSectorArray };
}

async function readWuxIndexTable(
    file: FileHandle,
    info: Omit<WuxInfo, 'indexTable'>
): Promise<WuxInfo> {
    const entryCount =
        (info.uncompressedSize + BigInt(info.sectorSize) - 1n) /
        BigInt(info.sectorSize);
    const table = await readWudFileRange(
        file,
        BigInt(WUX_HEADER_SIZE),
        Number(entryCount * BigInt(WUX_INDEX_TABLE_ENTRY_SIZE))
    );
    const indexTable: number[] = [];
    for (let offset = 0; offset < table.length; offset += 4) {
        indexTable.push(table.readUInt32LE(offset));
    }
    return { ...info, indexTable };
}

export async function findWudImagePaths(roots: string[]): Promise<string[]> {
    const found = new Set<string>();
    for (const root of roots) {
        const readableRoot = await findReadablePath(root);
        if (!readableRoot) {
            logger.warn('wud', `skipping inaccessible Wii U root ${root}`);
            continue;
        }
        for (const imagePath of await findWudImagePathsInRoot(readableRoot)) {
            found.add(imagePath);
        }
    }
    return [...found].sort((a, b) => a.localeCompare(b));
}

async function findWudImagePathsInRoot(root: string): Promise<string[]> {
    const found: string[] = [];
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            found.push(...(await findWudImagePathsInRoot(entryPath)));
        } else if (entry.isFile() && isWudImagePath(entry.name)) {
            found.push(entryPath);
        }
    }
    return found;
}

async function scanWudTitleEntries(roots: string[]): Promise<WudTitleEntry[]> {
    const imagePaths = await findWudImagePaths(roots);
    if (imagePaths.length === 0) {
        return [];
    }

    const commonKey = Buffer.from(await loadKeys('wiiu'), 'hex');
    const entries: WudTitleEntry[] = [];
    for (const imagePath of imagePaths) {
        try {
            const discKeyHex = await loadKeys('wud', imagePath);
            if (!discKeyHex) {
                continue;
            }
            const titlesByFamily = new Map<string, WudTitleEntry['titles']>();
            for (const title of await readWudTitles(
                imagePath,
                Buffer.from(discKeyHex, 'hex'),
                commonKey
            )) {
                const family = identifyTitle(title.titleId)?.family;
                if (!family) {
                    continue;
                }
                const titles = titlesByFamily.get(family) ?? [];
                titles.push(title);
                titlesByFamily.set(family, titles);
            }

            const sizeBytes = await getImmediatePathSizeBytes(imagePath);
            for (const titles of titlesByFamily.values()) {
                entries.push({
                    titles,
                    imageName: path.basename(imagePath),
                    sizeBytes,
                    copyCount: 1,
                });
            }
        } catch (error) {
            logger.warn(
                'wud',
                `skipping ${imagePath}: ${formatLogError(error)}`
            );
        }
    }
    return entries;
}

async function scanWiiUTitles(root: string): Promise<TitleGroup[]> {
    const [titleDatabase, gameTdb, wiiTitleDatabaseByTitleId, wiiGameTdb] =
        await Promise.all([
            readTitleDatabase(),
            readGameTdb(),
            readWiiTitleDatabase(),
            readWiiGameTdb(),
        ]);

    const scanned = await scanTitleEntries(root, {
        titleDatabase,
        wiiTitleDatabaseByTitleId,
    });

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
        const databaseEntry =
            titleDatabase.get(group.family) ??
            getWiiTitleDatabaseEntry(group, wiiTitleDatabaseByTitleId);
        const parentEntry = getParentEntry(group);
        group.productCode =
            databaseEntry?.productCode ?? getParentProductCode(group);
        group.titleInDatabase = databaseEntry !== null;
        group.details = databaseEntry
            ? getGameTdbDetails(
                  databaseEntry.platform === 'wii' ? wiiGameTdb : gameTdb,
                  databaseEntry
              )
            : null;
        const titleUrls = getTitleMediaUrls(databaseEntry);
        group.availableEntries = getAvailableEntries(
            databaseEntry?.platform === 'wiiu' ? databaseEntry : null,
            getTitleAvailableOnCdn
        );
        group.expectedChildren = createExpectedChildren(
            databaseEntry?.platform === 'wiiu' ? databaseEntry : null
        );
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
            const firstLocalChild = group.entries.find((entry) =>
                CHILD_KINDS.includes(entry.kind as ChildKind)
            );

            group.name = firstLocalChild?.name ?? 'Unknown';
            group.region = firstLocalChild?.region ?? null;
            group.iconUrl = firstLocalChild?.iconUrl ?? null;
            group.bannerUrl = firstLocalChild?.bannerUrl ?? null;
        }

        group.entries.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanWiiUTitleRoots(
    roots: string[]
): Promise<TitleGroup[]> {
    const groups = await scanTitleRoots(roots, {
        platform: 'wiiu',
        logNamespace: 'wiiu',
        scanTitles: scanWiiUTitles,
        mergeTitleGroups,
        resultLabel: 'title group(s)',
    });

    try {
        for (const entry of await scanWudTitleEntries(roots)) {
            const family = identifyTitle(entry.titles[0]?.titleId)?.family;
            if (!family) {
                continue;
            }
            let group = groups.find((candidate) => candidate.family === family);
            if (!group) {
                group = createGroup(family);
                groups.push(group);
            }
            mergeWudTitleEntry(group.wudEntries, entry);
        }
    } catch (error) {
        logger.warn(
            'wud',
            `failed to scan WUD/WUX library entries: ${formatLogError(error)}`
        );
    }

    return groups.sort((a, b) => a.name.localeCompare(b.name));
}

async function verifyWiiUTitles(
    root: string,
    onProgress?: (progress: LibraryVerifyProgress) => void,
    options: {
        directories?: string[];
        offset?: number;
        total?: number;
        signal?: AbortSignal;
    } = {}
): Promise<LibraryVerifyTitle[]> {
    const directories = options.directories ?? (await findTitleDirs(root));
    const verifications: LibraryVerifyTitle[] = [];
    const titleDatabase = await readTitleDatabase();
    const offset = options.offset ?? 0;
    const total = options.total ?? directories.length;

    const cachedEntries = await scanTitleEntries(root, {
        titleDatabase,
        wiiTitleDatabaseByTitleId: new Map(),
    });
    const entriesByDirectory = new Map(
        cachedEntries.map((entry) => [
            normalizeRelativeTitleDir(path.relative(root, entry.sourcePath)),
            entry,
        ])
    );

    for (const [index, directory] of directories.entries()) {
        throwIfLibraryVerifyCancelled(options.signal);

        const dirPath = path.join(root, directory);

        const titleEntry =
            entriesByDirectory.get(normalizeRelativeTitleDir(directory)) ??
            null;

        const sizeBytes =
            titleEntry?.sizeBytes ?? (await getImmediatePathSizeBytes(dirPath));
        const titleId = titleEntry?.titleId ?? 'unknown';
        const titleName = titleEntry?.name ?? directory;
        const titleKind = titleEntry?.kind ?? TitleKinds.Unknown;
        const titleVersion = titleEntry?.version ?? null;
        const sizeText = formatSize(sizeBytes);

        onProgress?.({
            platform: 'wiiu',
            titleId,
            name: titleName,
            kind: titleKind,
            version: titleVersion,
            current: offset + index,
            total,
        });

        const verification = await verifyWupTitleFiles(
            dirPath,
            (progress) => {
                onProgress?.({
                    platform: 'wiiu',
                    titleId,
                    name: titleName,
                    kind: titleKind,
                    version: titleVersion,
                    currentFileName: progress.currentFileName,
                    currentFileSizeBytes: progress.currentFileSizeBytes,
                    current: offset + index,
                    total,
                });
            },
            options.signal
        );
        throwIfLibraryVerifyCancelled(options.signal);
        const result = verification.status === 'ok' ? 'ok' : 'failed';
        onProgress?.({
            platform: 'wiiu',
            titleId,
            name: titleName,
            kind: titleKind,
            version: verification.titleVersion,
            result,
            error: verification.error,
            current: offset + index + 1,
            total,
        });

        verifications.push({
            platform: 'wiiu',
            root,
            directory,
            name: titleName,
            titleId: verification.titleId,
            version: verification.titleVersion,
            kind: titleKind,
            sizeText,
            status: verification.status,
            error: verification.error,
            verification: verification.verification,
        });
    }

    return verifications;
}

export async function verifyWiiUTitleRoots(
    roots: string[],
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyTitleRoots({
        roots,
        onProgress,
        signal,
        platform: 'wiiu',
        logNamespace: 'wiiu',
        findItems: findTitleDirs,
        verifyTitles: verifyWiiUTitles,
        afterVerify: async (verifications) =>
            createMissingExpectedChildVerifications(
                await scanWiiUTitleRoots(roots),
                verifications
            ),
    });
}

export function prepareWiiUTitleVerifications(
    roots: string[],
    signal?: AbortSignal
): Promise<PreparedTitleVerification[]> {
    return prepareTitleVerifications({
        roots,
        signal,
        platform: 'wiiu',
        logNamespace: 'wiiu',
        findItems: findTitleDirs,
    });
}

export function verifyPreparedWiiUTitle(
    item: PreparedTitleVerification,
    index: number,
    total: number,
    onProgress?: (progress: LibraryVerifyProgress) => void,
    signal?: AbortSignal
): Promise<LibraryVerifyTitle[]> {
    return verifyWiiUTitles(item.root, onProgress, {
        directories: [item.directory],
        offset: index,
        total,
        signal,
    });
}

export async function findMissingExpectedWiiUVerifications(
    roots: string[],
    existing: LibraryVerifyTitle[]
): Promise<LibraryVerifyTitle[]> {
    return createMissingExpectedChildVerifications(
        await scanWiiUTitleRoots(roots),
        existing
    );
}

export async function readWiiUTitleIdentity(
    titlePath: string
): Promise<{ titleId: string; version: number; kind: TitleKinds } | null> {
    const tmd = await readWupTmd(titlePath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const title = identifyTitle(titleId);
    if (!title) {
        return null;
    }

    return {
        titleId,
        version: tmd.header.titleVersion,
        kind: title.kind ?? TitleKinds.Unknown,
    };
}

export async function readWiiUTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    const normalizedProductCode = getWiiUProductCode(productCode);
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

export async function findWiiUTitleSourcePaths(
    roots: string[],
    titleId: string
): Promise<string[]> {
    const titleDatabase = await readTitleDatabase();
    return findTitleSourcePathsInRoots(
        roots,
        titleId,
        (readableRoot) =>
            scanTitleEntries(readableRoot, {
                titleDatabase,
                wiiTitleDatabaseByTitleId: new Map(),
            }),
        'wiiu',
        'wiiu'
    );
}

export async function findFirstReadableWiiURoot(
    roots: string[]
): Promise<string> {
    return findFirstReadableTitleRoot(roots, 'wiiu');
}

function createGroup(
    family: string,
    name = 'Unknown',
    region: string | null = null
): TitleGroup {
    return createEmptyTitleGroup('wiiu', family, name, region);
}

function getTitleAvailableOnCdn(titleId: string): boolean {
    return availableOnCdnByTitleId.get(titleId) ?? true;
}

function mergeTitleGroups(groups: TitleGroup[]): TitleGroup[] {
    return mergeLibraryTitleGroups(groups, {
        afterMergeEntry: (existing, group) => {
            for (const entry of group.wudEntries) {
                mergeWudTitleEntry(existing.wudEntries, entry);
            }
        },
        afterMergeGroup: (group) => {
            group.status = getGroupStatus(group);
        },
    });
}

async function findTitleDirs(root: string): Promise<string[]> {
    return findLibraryItems(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'wiiu',
        platform: 'wiiu',
        includeDirectory: (entries) =>
            entries.some(
                (entry) => entry.isFile() && entry.name === TMD_TITLE_FILE
            ),
    });
}

async function readTitleEntry(
    root: string,
    dirname: string,
    context: WiiUTitleScanContext
): Promise<LibraryCacheTitleEntry | null> {
    const dirPath = path.join(root, dirname);
    const tmd = await readWupTmd(dirPath);
    if (!tmd) {
        return null;
    }

    const titleId = Buffer.from(tmd.header.titleId).toString('hex');
    const titleIdentity = identifyTitle(titleId);
    if (!titleIdentity) {
        return null;
    }

    const family = titleIdentity.family ?? titleId;
    const kind = titleIdentity.kind ?? TitleKinds.Unknown;
    const meta = await readLocalMetaXml(dirPath, tmd);
    const wiiFallbackTitleId = getWiiFallbackTitleId(meta?.productCode, family);

    const databaseEntry =
        context.titleDatabase.get(family) ??
        (wiiFallbackTitleId
            ? (context.wiiTitleDatabaseByTitleId.get(wiiFallbackTitleId) ??
              null)
            : null);
    const titleUrls = getTitleMediaUrls(databaseEntry);
    const productCode = databaseEntry?.productCode ?? wiiFallbackTitleId;
    const sidecarIconUrl = await cacheLocalTitleIcon(
        'wiiu',
        productCode,
        dirPath
    );

    return {
        titleId,
        platform: titleIdentity.platform,
        name: getTitleName(databaseEntry?.name ?? meta?.name ?? null),
        region: normalizeRegion(
            databaseEntry?.region ?? meta?.region ?? tmd.header.region,
            databaseEntry?.productCode ?? productCode
        ),
        version: tmd.header.titleVersion,

        iconUrl: sidecarIconUrl ?? titleUrls.iconUrl,
        bannerUrl: titleUrls.bannerUrl,

        kind,
        family,
        productCode,

        sizeBytes: await getImmediatePathSizeBytes(dirPath),
        copyCount: 1,
        sourcePath: dirPath,
    };
}

async function scanTitleEntries(
    root: string,
    context: WiiUTitleScanContext
): Promise<LibraryCacheTitleEntry[]> {
    return scanCachedTitleEntries(root, {
        concurrency: LIBRARY_SCAN_CONCURRENCY,
        logNamespace: 'wiiu',
        findItems: findTitleDirs,
        readEntry: readTitleEntry,
        context,
    });
}

function normalizeRelativeTitleDir(value: string): string {
    return value === '' ? '.' : value;
}

function getTitleName(databaseName: string | null): string {
    if (databaseName && databaseName.length > 0) {
        return normalizeTitleName(databaseName);
    }

    return 'Unknown';
}

function getWiiFallbackTitleId(
    value: string | null | undefined,
    family?: string
): string | null {
    return (
        getProductCodeMediaKey('wiiu', value) ??
        getDiscTitleId(value) ??
        getWiiProductCodeFromFamily(family)
    );
}

function getWiiProductCodeFromFamily(
    family: string | undefined
): string | null {
    if (!family || !/^[a-f0-9]{8}$/i.test(family)) {
        return null;
    }

    return getDiscTitleId(Buffer.from(family, 'hex').toString('ascii'));
}

async function readLocalMetaXml(
    dirPath: string,
    tmd: Tmd
): Promise<ReturnType<typeof readMetaXml>> {
    for (const relativePath of WIIU_META_XML_PATHS) {
        const metaXml = await readOptionalFile(
            path.join(dirPath, relativePath)
        );
        const meta = metaXml ? readMetaXml(metaXml) : null;
        if (meta) {
            return meta;
        }
    }

    try {
        return await readWupMeta(dirPath, tmd);
    } catch (error) {
        logger.warn(
            'wiiu',
            `failed to read local Wii U metadata from ${dirPath}: ${formatLogError(error)}`
        );
        return null;
    }
}

function getWiiTitleDatabaseEntry(
    group: TitleGroup,
    entriesByTitleId: Map<string, TitleDatabaseEntry>
): TitleDatabaseEntry | null {
    const titleId = getWiiFallbackTitleId(
        getParentProductCode(group),
        group.family
    );
    return titleId ? (entriesByTitleId.get(titleId) ?? null) : null;
}

function getParentEntry(
    group: TitleGroup
): TitleGroup['entries'][number] | null {
    return (
        group.entries.find((entry) => PARENT_KIND_SET.has(entry.kind)) ?? null
    );
}

function getParentProductCode(group: TitleGroup): string | null {
    const parentEntry = getParentEntry(group);
    if (!parentEntry || !('productCode' in parentEntry)) {
        return null;
    }
    return typeof parentEntry.productCode === 'string'
        ? parentEntry.productCode
        : null;
}

function parseTitleDatabaseEntries(jsonText: string): TitleDatabaseEntry[] {
    const database = JSON.parse(jsonText) as Record<string, unknown>;
    const json = database.wiiu as Array<
        RawTitleDatabaseEntry & { titleId: string }
    >;

    if (!Array.isArray(json)) {
        throw new Error('titles.json must contain a wiiu array');
    }

    const entries = json
        .map((entry): TitleDatabaseEntry | null => {
            const title = identifyTitle(entry.titleId);
            if (!title) {
                throw new Error(
                    `invalid titleId in titles.json: ${JSON.stringify(entry)}`
                );
            }

            if (title.platform !== 'wiiu') {
                return null;
            }

            const { titleId, family } = title;

            return {
                platform: title.platform,
                titleId,
                name: normalizeTitleName(entry.name),
                region: normalizeRegion(
                    entry.region,
                    entry.productCode ?? null
                ),
                companyCode: entry.companyCode?.length
                    ? entry.companyCode
                    : null,
                productCode: getWiiUProductCode(entry.productCode ?? null),
                iconUrl: entry.iconUrl,
                bannerUrl: entry.bannerUrl ?? null,

                baseVersions:
                    entry.baseVersions?.filter((version) =>
                        Number.isFinite(version)
                    ) ?? [],
                updateVersions: entry.updateVersions ?? [],
                dlcVersions: entry.dlcVersions ?? [],

                family,
                availableOnCdn: entry.availableOnCdn,
            };
        })
        .filter((entry): entry is TitleDatabaseEntry => entry !== null);

    return entries;
}

function getGameTdbDetails(
    gameTdb: Map<string, TitleDetails>,
    entry: TitleDatabaseEntry
): TitleDetails | null {
    const id = entry.productCode
        ? getProductCodeMediaKey('wiiu', entry.productCode)
        : null;
    return id ? (gameTdb.get(id) ?? null) : null;
}

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

    const platform = entry.platform;

    return {
        iconUrl: getTitleMediaUrl('icons', platform, entry.productCode),
        bannerUrl: getTitleMediaUrl('covers', platform, entry.productCode),
    };
}

function parseGameTdbDetails(game: GameTdbGame): TitleDetails {
    return {
        tvFormat: game.region ?? null,
        languages: splitGameTdbList(game.languages),
        synopsis: getPreferredGameTdbSynopsis(getGameTdbLocales(game)),
        developer: game.developer?.trim() || null,
        genre: splitGameTdbList(game.genre),
        inputPlayers: parseGameTdbNumber(game.input?.['@players']),
        inputControls: parseGameTdbInputControls(game),
        sizeBytes: parseGameTdbNumber(game.rom?.['@size']),
    };
}

async function readGameTdb(): Promise<Map<string, TitleDetails>> {
    return readLibraryGameTdb<GameTdbGame>({
        fileName: 'wiiu/tdb.xml',
        logNamespace: 'wiiu',
        getId: (game) => (game.id ?? '').slice(0, 4).toUpperCase() || null,
        parseDetails: parseGameTdbDetails,
    });
}

async function readTitleDatabase(): Promise<Map<string, TitleDatabaseEntry>> {
    return readLibraryTitleDatabase({
        logNamespace: 'wiiu',
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

function mergeWudTitleEntry(
    entries: WudTitleEntry[],
    entry: WudTitleEntry
): void {
    const existing = entries.find(
        (candidate) => candidate.imageName === entry.imageName
    );

    if (existing) {
        for (const title of entry.titles) {
            const existingTitle = existing.titles.find(
                (candidate) => candidate.titleId === title.titleId
            );
            if (!existingTitle) {
                existing.titles.push({ ...title });
            } else if (title.version > existingTitle.version) {
                existingTitle.version = title.version;
            }
        }
        existing.copyCount += entry.copyCount;
        return;
    }

    entries.push({
        ...entry,
        titles: entry.titles.map((title) => ({ ...title })),
    });
}

function createMissingExpectedChildVerifications(
    groups: TitleGroup[],
    existingVerifications: LibraryVerifyTitle[]
): LibraryVerifyTitle[] {
    const installedTitleIds = new Set(
        existingVerifications
            .map((verification) => verification.titleId)
            .filter((titleId): titleId is string => titleId !== null)
    );
    const missing: LibraryVerifyTitle[] = [];

    for (const group of groups) {
        if (group.entries.length === 0) {
            continue;
        }

        for (const expectedKind of group.expectedChildren) {
            const expectedEntry = group.availableEntries.find(
                (entry) => entry.kind === expectedKind
            );

            if (
                !expectedEntry ||
                installedTitleIds.has(expectedEntry.titleId)
            ) {
                continue;
            }

            missing.push({
                platform: 'wiiu',
                root: null,
                directory: null,
                name: group.name,
                titleId: expectedEntry.titleId,
                version: expectedEntry.versions[0] ?? null,
                kind: expectedKind,
                sizeText: null,
                status: 'failed',
                error: `Missing expected ${expectedKind}`,
                verification: [],
            });
        }
    }

    return missing;
}
const TITLE_DOWNLOAD_CONCURRENCY = 8;

export type GeneratedWupTitleFiles = {
    titleId: string;
    kind: DownloadableTitleKind;
    name: string;
    titleVersion: number;
    titleKey: string;
    titleKeyPassword: string | null;
    outputDir: string;
    sizeBytes: number;
    files: {
        tmd: string;
        tik: string;
        cert: string;
        app: string[];
        h3: string[];
    };
};

export type WupGenerationProgress = {
    outputDir: string;
    completedFiles: number;
    totalFiles: number;
    currentFileName: string | null;
    currentFileSizeBytes: number;
};

type WupCheckResult = {
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    error: string | null;
    failedFileCount: number;
    totalFileCount: number;
};

export type WupVerification = WupCheckResult & {
    verification: ContentTreeVerification[];
};

export type WupValidation = WupCheckResult;

export type WupVerificationProgress = {
    currentFileName: string;
    currentFileSizeBytes: number;
};

type TitleContentDownload = {
    content: TmdContent;
    files: ContentInstallFiles;
    appSizeBytes: number;
    appCached: boolean;
    h3SizeBytes: number | null;
    h3Available: boolean;
    h3Cached: boolean;
};

export async function readWupTmd(dirPath: string): Promise<Tmd | null> {
    const buffer = await readOptionalFile(path.join(dirPath, TMD_TITLE_FILE));
    return buffer ? readTmdFromBuffer(buffer) : null;
}

export async function readWupTik(dirPath: string): Promise<Tik | null> {
    const buffer = await readOptionalFile(path.join(dirPath, TIK_TITLE_FILE));
    return buffer ? readTik(buffer) : null;
}

export async function readWupMeta(
    dirPath: string,
    tmd: Tmd
): Promise<NUSTitleInformation | null> {
    const fstContent = tmd.contents[0];
    if (!fstContent) {
        return null;
    }

    const encryptedFst = await readOptionalFile(
        getContentInstallFiles(dirPath, fstContent).appFile
    );
    if (!encryptedFst) {
        return null;
    }

    const ticket = await readWupTik(dirPath);
    const titleId = getTitleIdHex(tmd.header.titleId);
    const { titleKey, decryptedFst } = resolveTitleKey({
        commonKey: Buffer.from(await loadKeys('wiiu'), 'hex'),
        encryptedFst,
        normalizedTitleId: titleId,
        ticket,
        tmd,
    });
    const metaXml = await extractMetaXmlFromContentReader(
        decryptedFst,
        tmd,
        titleKey,
        titleId,
        async (content) =>
            readOptionalFile(getContentInstallFiles(dirPath, content).appFile)
    );

    return metaXml ? readMetaXml(metaXml) : null;
}

export async function generateWupTitleFiles(
    titleId: string,
    romRoot: string,
    options: {
        onProgress?: (progress: WupGenerationProgress) => void;
        signal?: AbortSignal;
    } = {}
): Promise<GeneratedWupTitleFiles> {
    const baseUrl = WII_U_NUS_BASE_URL;
    const { titleId: downloadableTitleId, kind } =
        getDownloadableTitle(titleId);
    const commonKey = Buffer.from(await loadKeys('wiiu'), 'hex');
    throwIfAborted(options.signal);
    const tmdBytes = await downloadTmd(baseUrl, downloadableTitleId, {
        signal: options.signal,
    });
    throwIfAborted(options.signal);
    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));

    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${downloadableTitleId}`
        );
    }

    const fstContent = tmd.contents[0];
    if (!fstContent) {
        throw new TitleMetadataError(
            'missing_fst_content',
            `TMD has no first content entry for ${downloadableTitleId}`
        );
    }

    const encryptedFst = await downloadContent(
        baseUrl,
        downloadableTitleId,
        fstContent.id,
        { signal: options.signal }
    );
    throwIfAborted(options.signal);
    const ticketBytes = await downloadOptionalTicket(
        baseUrl,
        downloadableTitleId,
        { signal: options.signal }
    );
    const ticket = ticketBytes ? readTik(ticketBytes) : null;
    const { encryptedTitleKey, titleKey, decryptedFst, titleKeyPassword } =
        resolveTitleKey({
            commonKey,
            encryptedFst,
            normalizedTitleId: downloadableTitleId,
            ticket,
            tmd,
        });

    if (
        encryptedTitleKey === null ||
        titleKey === null ||
        decryptedFst === null
    ) {
        throw new TitleMetadataError(
            'resolve_title_key',
            `Failed to produce an encrypted title key for ${downloadableTitleId}`
        );
    }

    const metaXml = await extractMetaXmlFromTitle(
        decryptedFst,
        tmd,
        titleKey,
        baseUrl,
        downloadableTitleId,
        { signal: options.signal }
    );
    const meta = metaXml ? readMetaXml(metaXml) : null;
    const directoryKind = formatInstallDirectoryKind(kind);
    const outputDir = path.join(
        romRoot,
        `${safeDirectoryName(meta?.name ?? downloadableTitleId)} [${directoryKind}] [${downloadableTitleId}]`
    );
    const tmdFile = path.join(outputDir, TMD_TITLE_FILE);
    const certFile = path.join(outputDir, CERT_TITLE_FILE);
    const files = {
        tmd: TMD_TITLE_FILE,
        tik: TIK_TITLE_FILE,
        cert: CERT_TITLE_FILE,
        app: [] as string[],
        h3: [] as string[],
    };
    await mkdir(outputDir, { recursive: true });

    options.onProgress?.({
        outputDir,
        completedFiles: 0,
        totalFiles: tmd.contents.reduce(
            (total, content) => total + (isHashedContent(content) ? 2 : 1),
            0
        ),
        currentFileName: null,
        currentFileSizeBytes: 0,
    });

    await Promise.all([
        writeFile(tmdFile, tmdBytes),
        writeFile(
            path.join(outputDir, TIK_TITLE_FILE),
            createGeneratedTik({
                titleId: tmd.header.titleId,
                encryptedTitleKey,
                titleVersion: tmd.header.titleVersion,
            })
        ),
        writeFile(
            certFile,
            await createGeneratedCert(tmd, {
                ticketBytes: ticketBytes ?? undefined,
            })
        ),
    ]);

    const totalFiles = tmd.contents.reduce(
        (total, content) => total + (isHashedContent(content) ? 2 : 1),
        0
    );
    const contentDownloads: TitleContentDownload[] = await mapConcurrent(
        tmd.contents,
        TITLE_DOWNLOAD_CONCURRENCY,
        async (content) => {
            throwIfAborted(options.signal);
            const contentFiles = getContentInstallFiles(outputDir, content);
            const appSizeBytes = Number(getEncryptedContentFileSize(content));
            const appCached = await hasExpectedFileSize(
                contentFiles.appFile,
                appSizeBytes
            );
            const h3SizeBytes = isHashedContent(content)
                ? getContentH3FileSize(content)
                : null;
            const h3Cached =
                h3SizeBytes !== null &&
                contentFiles.h3File !== null &&
                (await hasExpectedFileSize(contentFiles.h3File, h3SizeBytes));

            return {
                content,
                files: contentFiles,
                appSizeBytes,
                appCached,
                h3SizeBytes,
                h3Available: !isHashedContent(content) || h3Cached,
                h3Cached,
            };
        }
    );

    let completedFiles = contentDownloads.reduce(
        (total, download) =>
            total + Number(download.appCached) + Number(download.h3Cached),
        0
    );
    const reportProgress = (
        currentFileName: string,
        currentFileSizeBytes: number,
        complete = false
    ): void => {
        if (complete) {
            completedFiles += 1;
        }
        options.onProgress?.({
            outputDir,
            completedFiles,
            totalFiles,
            currentFileName,
            currentFileSizeBytes,
        });
    };

    await mapConcurrent(
        contentDownloads.filter(
            (download) => download.h3SizeBytes !== null && !download.h3Cached
        ),
        TITLE_DOWNLOAD_CONCURRENCY,
        async (download) => {
            throwIfAborted(options.signal);
            const h3File = download.files.h3File;
            const h3Name = download.files.h3Name;
            const h3SizeBytes = download.h3SizeBytes;
            if (!h3File || !h3Name || h3SizeBytes === null) {
                return;
            }

            reportProgress(h3Name, h3SizeBytes);
            await downloadContentH3ToFile(
                baseUrl,
                downloadableTitleId,
                download.content.id,
                h3File,
                { signal: options.signal }
            );
            download.h3Available = true;
            reportProgress(h3Name, h3SizeBytes, true);
        }
    );

    await mapConcurrent(
        contentDownloads.filter(
            (download) => download.h3Available && !download.appCached
        ),
        TITLE_DOWNLOAD_CONCURRENCY,
        async (download) => {
            throwIfAborted(options.signal);
            reportProgress(download.files.appName, download.appSizeBytes);
            await downloadContentToFile(
                baseUrl,
                downloadableTitleId,
                download.content.id,
                download.files.appFile,
                { signal: options.signal }
            );
            reportProgress(download.files.appName, download.appSizeBytes, true);
        }
    );

    for (const download of contentDownloads) {
        if (!download.h3Available) {
            continue;
        }
        files.app.push(download.files.appName);
        if (download.files.h3Name) {
            files.h3.push(download.files.h3Name);
        }
    }

    const name = normalizeTitleName(meta?.name ?? downloadableTitleId);
    const sizeBytes = await getImmediatePathSizeBytes(outputDir);

    logger.log(
        'metadata',
        `finished downloading: [${downloadableTitleId}] ${name} ${kind}`
    );

    return {
        titleId: downloadableTitleId,
        kind,
        name,
        titleVersion: tmd.header.titleVersion,
        titleKey: Buffer.from(titleKey).toString('hex'),
        titleKeyPassword,
        outputDir,
        sizeBytes,
        files,
    };
}

async function hasExpectedFileSize(
    filePath: string,
    expectedSize: number
): Promise<boolean> {
    try {
        return (await stat(filePath)).size === expectedSize;
    } catch {
        return false;
    }
}

export async function verifyWupTitleFiles(
    dirPath: string,
    onProgress?: (progress: WupVerificationProgress) => void,
    signal?: AbortSignal
): Promise<WupVerification> {
    throwIfAborted(signal);
    const tmd = await readWupTmd(dirPath);
    throwIfAborted(signal);
    if (!tmd) {
        return createFailedInstalledVerification(
            null,
            null,
            `Missing or invalid ${TMD_TITLE_FILE}`
        );
    }

    const titleId = getTitleIdHex(tmd.header.titleId);
    const titleVersion = tmd.header.titleVersion;
    const ticket = await readWupTik(dirPath);
    throwIfAborted(signal);
    if (!ticket) {
        return createFailedInstalledVerification(
            titleId,
            titleVersion,
            `Missing or invalid ${TIK_TITLE_FILE}`
        );
    }

    let titleKey: Buffer;
    try {
        titleKey = decryptTitleKey(
            ticket.encryptedKey,
            Buffer.from(await loadKeys('wiiu'), 'hex'),
            ticket.titleId
        );
        throwIfAborted(signal);
    } catch (error) {
        throwIfAborted(signal);
        return createFailedInstalledVerification(
            titleId,
            titleVersion,
            formatLogError(error)
        );
    }

    const verification: ContentTreeVerification[] = [];
    let failedFileCount = 0;
    let totalFileCount = 0;
    for (const content of tmd.contents) {
        throwIfAborted(signal);
        const files = getContentInstallFiles(dirPath, content);
        onProgress?.({
            currentFileName: files.appName,
            currentFileSizeBytes: getEncryptedContentFileSize(content),
        });
        const result = await verifyInstalledContent({
            dirPath,
            content,
            files,
            titleKey,
            signal,
        });
        throwIfAborted(signal);
        const fileSizes = await validateInstalledContentFileSizes(
            dirPath,
            content
        );
        throwIfAborted(signal);
        verification.push(result);
        failedFileCount +=
            fileSizes.failedFileCount === 0 && result.status !== 'ok'
                ? 1
                : fileSizes.failedFileCount;
        totalFileCount += fileSizes.totalFileCount;
    }

    return {
        titleId,
        titleVersion,
        status: verification.every((result) => result.status === 'ok')
            ? 'ok'
            : 'failed',
        error: null,
        verification,
        failedFileCount,
        totalFileCount,
    };
}

export async function validateWupTitleFileSizes(
    dirPath: string,
    signal?: AbortSignal
): Promise<WupValidation> {
    throwIfAborted(signal);
    const tmd = await readWupTmd(dirPath);
    throwIfAborted(signal);
    if (!tmd) {
        return createFailedInstalledValidation(
            null,
            null,
            `Missing or invalid ${TMD_TITLE_FILE}`
        );
    }

    const titleId = getTitleIdHex(tmd.header.titleId);
    const titleVersion = tmd.header.titleVersion;
    let failedFileCount = 0;
    let totalFileCount = 0;

    for (const content of tmd.contents) {
        throwIfAborted(signal);
        const result = await validateInstalledContentFileSizes(
            dirPath,
            content
        );
        failedFileCount += result.failedFileCount;
        totalFileCount += result.totalFileCount;
    }

    return {
        titleId,
        titleVersion,
        status: failedFileCount === 0 ? 'ok' : 'failed',
        error: null,
        failedFileCount,
        totalFileCount,
    };
}

async function validateInstalledContentFileSizes(
    dirPath: string,
    content: TmdContent
): Promise<{
    failedFileCount: number;
    totalFileCount: number;
}> {
    const files = getContentInstallFiles(dirPath, content);
    const expectedSize = getEncryptedContentFileSize(content);
    let failedFileCount = 0;
    const totalFileCount = isHashedContent(content) ? 2 : 1;

    try {
        await assertExistingContentFileSize(
            files.appFile,
            expectedSize,
            files.contentId
        );
    } catch {
        failedFileCount += 1;
    }

    if (isHashedContent(content)) {
        try {
            if (!files.h3File) {
                throw new Error('Missing H3 file path for hashed content');
            }
            await assertExistingContentFileSize(
                files.h3File,
                getContentH3FileSize(content),
                files.contentId
            );
        } catch {
            failedFileCount += 1;
        }
    }

    return {
        failedFileCount,
        totalFileCount,
    };
}

function createFailedInstalledValidation(
    titleId: string | null,
    titleVersion: number | null,
    error: string
): WupValidation {
    return {
        titleId,
        titleVersion,
        status: 'failed',
        error,
        failedFileCount: 0,
        totalFileCount: 0,
    };
}

function createFailedInstalledVerification(
    titleId: string | null,
    titleVersion: number | null,
    error: string
): WupVerification {
    return {
        ...createFailedInstalledValidation(titleId, titleVersion, error),
        verification: [],
    };
}

function verifyInstalledContent({
    dirPath,
    content,
    files,
    titleKey,
    signal,
}: {
    dirPath: string;
    content: TmdContent;
    files?: ContentInstallFiles;
    titleKey: Buffer;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    return verifyContentInstallFiles({
        files: files ?? getContentInstallFiles(dirPath, content),
        content,
        titleKey,
        signal,
    });
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
export type WudConvertProgress = {
    titleId: string;
    outputDir: string;
    currentFileName: string | null;
    currentFileSizeBytes: number;
    completedFiles: number;
    totalFiles: number;
};

export type ConvertedWudImage = {
    sourcePath: string;
    titles: ConvertedWudTitleFiles[];
};

export type ConvertedWudTitleFiles = {
    titleId: string;
    kind: DownloadableTitleKind;
    name: string;
    titleVersion: number;
    titleKey: string;
    titleKeyPassword: string | null;
    outputDir: string;
    sizeBytes: number;
    files: {
        tmd: string;
        tik: string;
        cert: string;
        app: string[];
        h3: string[];
    };
};

export type LibraryWudConvertResult = {
    converted: ConvertedWudImage[];
};

export type WudTitle = {
    titleId: string;
    version: number;
};

export async function readWudTitles(
    imagePath: string,
    discKey: Buffer,
    commonKey: Buffer
): Promise<WudTitle[]> {
    const image = await openWudImage(imagePath);
    try {
        const partitions = await readWudGamePartitions(
            image,
            discKey,
            commonKey,
            null
        );
        return partitions.map((partition) => ({
            titleId: getTitleIdHex(partition.tmd.header.titleId),
            version: partition.tmd.header.titleVersion,
        }));
    } finally {
        await image.close();
    }
}

export async function convertWudImages(
    imagePaths: string[],
    titleId: string,
    options: {
        onProgress?: (progress: WudConvertProgress) => void;
        signal?: AbortSignal;
    } = {}
): Promise<LibraryWudConvertResult> {
    const requestedTitleId = titleId;
    const requestedFamily = identifyTitle(requestedTitleId)?.family ?? null;
    const commonKey = Buffer.from(await loadKeys('wiiu'), 'hex');
    const converted: ConvertedWudImage[] = [];
    logger.log(
        'wud',
        `converting WUD/WUX title ${requestedTitleId}; found ${imagePaths.length} image(s)`
    );

    for (const imagePath of imagePaths) {
        throwIfAborted(options.signal);
        try {
            logger.log('wud', `reading ${imagePath}`);
            const discKeyHex = await loadKeys('wud', imagePath);
            if (!discKeyHex) {
                logger.warn('wud', `skipping ${imagePath}: no usable disc key`);
                continue;
            }
            const discKey = Buffer.from(discKeyHex, 'hex');
            const image = await openWudImage(imagePath);
            try {
                logger.log('wud', `opened ${imagePath}; reading partitions`);
                const partitions = await readWudGamePartitions(
                    image,
                    discKey,
                    commonKey,
                    requestedFamily
                );
                logger.log(
                    'wud',
                    `matched ${partitions.length} partition(s) in ${imagePath}`
                );
                const outputRoot = path.dirname(imagePath);
                const titles: ConvertedWudTitleFiles[] = [];

                for (const partition of partitions) {
                    throwIfAborted(options.signal);
                    try {
                        titles.push(
                            await convertWudGamePartition({
                                image,
                                partition,
                                outputRoot,
                                onProgress: options.onProgress,
                                signal: options.signal,
                            })
                        );
                    } catch (error) {
                        throwIfAborted(options.signal);
                        logger.warn(
                            'wud',
                            `skipping ${partition.name}: ${formatLogError(error)}`
                        );
                    }
                }

                if (titles.length > 0) {
                    converted.push({
                        sourcePath: imagePath,
                        titles,
                    });
                }
            } finally {
                await image.close();
            }
        } catch (error) {
            throwIfAborted(options.signal);
            const message = formatLogError(error);
            logger.warn('wud', `skipping ${imagePath}: ${message}`);
        }
    }

    return { converted };
}

async function readWudGamePartitions(
    image: OpenedWudImage,
    discKey: Buffer,
    commonKey: Buffer,
    requestedFamily: string | null
): Promise<PreparedWudGamePartition[]> {
    const partitionTocBlock = await readDecryptedWudRange(
        image,
        WUD_DECRYPTED_AREA_OFFSET,
        0n,
        WUD_SECTOR_SIZE,
        discKey,
        null,
        true
    );

    if (partitionTocBlock.readUInt32BE(0) !== WUD_DECRYPTED_AREA_SIGNATURE) {
        logger.warn(
            'wud',
            `failed to decrypt partition table for ${image.filePath}`
        );
        return [];
    }

    const partitions = readWudPartitionReferences(partitionTocBlock);
    const siPartition = partitions.find((partition) =>
        partition.name.startsWith('SI')
    );

    if (!siPartition) {
        logger.warn('wud', `no SI partition found in ${image.filePath}`);
        return [];
    }

    const si = await readWudDataPartition(image, siPartition, discKey);
    if (!si) {
        logger.warn('wud', `failed to read SI partition in ${image.filePath}`);
        return [];
    }
    const gamePartitions: PreparedWudGamePartition[] = [];
    logger.log(
        'wud',
        `read partition table for ${image.filePath}; found ${partitions.length} partition(s)`
    );

    for (const child of getRootDirectoryChildren(si.fst)) {
        const gamePartition = await readWudGamePartitionChild(
            image,
            si,
            partitions,
            child,
            discKey,
            commonKey,
            requestedFamily
        );
        if (gamePartition) {
            gamePartitions.push(gamePartition);
        }
    }

    return gamePartitions;
}

async function readWudGamePartitionChild(
    image: WudImage,
    si: WudDataPartition,
    partitions: WudPartitionReference[],
    child: string,
    discKey: Buffer,
    commonKey: Buffer,
    requestedFamily: string | null
): Promise<PreparedWudGamePartition | null> {
    try {
        logger.log('wud', `reading WUD title metadata from ${child}`);
        const rawTicket = await readWudFstFile(
            image,
            si,
            `${child}/${TIK_TITLE_FILE}`,
            discKey
        );
        if (!rawTicket) {
            logger.warn('wud', `skipping ${child}: missing ${TIK_TITLE_FILE}`);
            return null;
        }

        const ticket = readTik(rawTicket);
        if (!ticket) {
            logger.warn('wud', `skipping ${child}: invalid ${TIK_TITLE_FILE}`);
            return null;
        }

        const titleId = getTitleIdHex(ticket.titleId);
        const title = identifyTitle(titleId);
        const titleKind = title?.kind ?? TitleKinds.Unknown;
        if (
            !DOWNLOADABLE_KINDS.includes(
                titleKind as (typeof DOWNLOADABLE_KINDS)[number]
            ) ||
            (requestedFamily !== null && title?.family !== requestedFamily)
        ) {
            return null;
        }

        const rawTmd = await readWudFstFile(
            image,
            si,
            `${child}/${TMD_TITLE_FILE}`,
            discKey
        );
        if (!rawTmd) {
            logger.warn('wud', `skipping ${child}: missing ${TMD_TITLE_FILE}`);
            return null;
        }

        const tmd = readTmdFromBuffer(Buffer.from(rawTmd));
        if (!tmd) {
            logger.warn('wud', `skipping ${child}: invalid ${TMD_TITLE_FILE}`);
            return null;
        }
        const rawCert =
            (await readWudFstFile(
                image,
                si,
                `${child}/${CERT_TITLE_FILE}`,
                discKey
            )) ?? Buffer.alloc(0);
        const partitionName = `GM${titleId}`.toLowerCase();
        const partitionReference = partitions.find((partition) =>
            partition.name.toLowerCase().startsWith(partitionName)
        );
        if (!partitionReference) {
            logger.warn(
                'wud',
                `skipping ${child}: no ${partitionName} partition`
            );
            return null;
        }

        const contentKey = decryptTitleKey(
            ticket.encryptedKey,
            commonKey,
            ticket.titleId
        );
        logger.log(
            'wud',
            `resolved content key for ${titleId} from existing title.tik`
        );
        logger.log(
            'wud',
            `reading game partition ${partitionReference.name} for ${titleId}`
        );
        const gamePartition = await readWudGamePartition(
            image,
            partitionReference,
            contentKey,
            tmd
        );
        return gamePartition
            ? { ...gamePartition, rawTmd, rawCert, rawTicket }
            : null;
    } catch (error) {
        logger.warn('wud', `skipping ${child}: ${formatLogError(error)}`);
        return null;
    }
}

async function convertWudGamePartition({
    image,
    partition,
    outputRoot,
    onProgress,
    signal,
}: {
    image: WudImage;
    partition: PreparedWudGamePartition;
    outputRoot: string;
    onProgress?: (progress: WudConvertProgress) => void;
    signal?: AbortSignal;
}): Promise<ConvertedWudTitleFiles> {
    const titleId = getTitleIdHex(partition.tmd.header.titleId);
    const { kind } = getDownloadableTitle(titleId);
    const metaXml = await extractMetaXmlFromPartition(image, partition);
    const meta = metaXml ? readMetaXml(metaXml) : null;
    const name = normalizeTitleName(meta?.name ?? titleId);
    const outputDir = path.join(
        outputRoot,
        `${safeDirectoryName(name)} [${formatInstallDirectoryKind(kind)}] [${titleId}]`
    );
    const titleKey = partition.contentKey;
    const files = {
        tmd: TMD_TITLE_FILE,
        tik: TIK_TITLE_FILE,
        cert: CERT_TITLE_FILE,
        app: [] as string[],
        h3: [] as string[],
    };
    const totalFiles = partition.tmd.contents.reduce(
        (total, content) => total + (isHashedContent(content) ? 2 : 1),
        0
    );

    await mkdir(outputDir, { recursive: true });
    onProgress?.({
        titleId,
        outputDir,
        completedFiles: 0,
        totalFiles,
        currentFileSizeBytes: 0,
        currentFileName: null,
    });
    logger.log(
        'wud',
        `writing ${titleId} ${kind} to ${outputDir}; preserving title.tik from WUD`
    );
    await Promise.all([
        writeFile(path.join(outputDir, TMD_TITLE_FILE), partition.rawTmd),
        writeFile(path.join(outputDir, TIK_TITLE_FILE), partition.rawTicket),
        writeFile(
            path.join(outputDir, CERT_TITLE_FILE),
            partition.rawCert.length > 0
                ? partition.rawCert
                : await createGeneratedCert(partition.tmd, {
                      ticketBytes: partition.rawTicket,
                  })
        ),
    ]);

    let completedFiles = 0;
    for (const content of partition.tmd.contents) {
        throwIfAborted(signal);
        const installFiles = getContentInstallFiles(outputDir, content);
        logger.log(
            'wud',
            `extracting ${titleId} content ${installFiles.contentId} to ${installFiles.appName}`
        );
        onProgress?.({
            titleId,
            outputDir,
            completedFiles,
            totalFiles,
            currentFileSizeBytes: Number(getEncryptedContentFileSize(content)),
            currentFileName: installFiles.appName,
        });

        await writePartitionContent(
            image,
            partition,
            content.index,
            installFiles.appFile,
            signal
        );
        logger.log(
            'wud',
            `wrote ${titleId} content ${installFiles.contentId} app`
        );
        completedFiles += 1;

        if (
            isHashedContent(content) &&
            installFiles.h3File &&
            installFiles.h3Name
        ) {
            const h3 = readWudPartitionH3(
                partition,
                content.index,
                content.size
            );
            onProgress?.({
                titleId,
                outputDir,
                completedFiles,
                totalFiles,
                currentFileSizeBytes: h3.byteLength,
                currentFileName: installFiles.h3Name,
            });
            await writeFile(installFiles.h3File, h3);
            logger.log(
                'wud',
                `wrote ${titleId} content ${installFiles.contentId} h3`
            );
            files.h3.push(installFiles.h3Name);
            completedFiles += 1;
        }
        files.app.push(installFiles.appName);
        logger.log(
            'wud',
            `progress ${titleId}: ${completedFiles}/${totalFiles} install file(s)`
        );
    }

    logger.log(
        'wud',
        `converted ${titleId} from ${partition.name}; wrote ${files.app.length} app file(s) and ${files.h3.length} h3 file(s)`
    );

    return {
        titleId,
        kind,
        name,
        titleVersion: partition.tmd.header.titleVersion,
        titleKey: Buffer.from(titleKey).toString('hex'),
        titleKeyPassword: null,
        outputDir,
        sizeBytes: await getImmediatePathSizeBytes(outputDir),
        files,
    };
}

async function writePartitionContent(
    image: WudImage,
    partition: WudGamePartition,
    contentIndex: number,
    targetFile: string,
    signal?: AbortSignal
): Promise<void> {
    const content = partition.tmd.contents.find(
        (candidate) => candidate.index === contentIndex
    );

    if (!content) {
        throw new Error(`Missing content ${contentIndex}`);
    }

    const contentOffset =
        contentIndex === 0
            ? partition.partitionOffset
            : partition.partitionOffset +
              (partition.contentOffsets.get(contentIndex) ??
                  (() => {
                      throw new Error(
                          `Missing FST content offset for ${contentIndex}`
                      );
                  })());

    await pipeline(
        createWudReadStream(
            image,
            contentOffset,
            BigInt(getEncryptedContentFileSize(content)),
            signal
        ),
        createWriteStream(targetFile),
        { signal }
    );
}

async function extractMetaXmlFromPartition(
    image: WudImage,
    partition: WudGamePartition
): Promise<Buffer | null> {
    const entries = parseTitleFstEntries(partition.fst, partition.tmd);
    const entry =
        entries.find((candidate) =>
            WIIU_META_XML_PATHS.some((file) => file === candidate.fullPath)
        ) ?? null;
    if (!entry) {
        return null;
    }
    const content = findTmdContentByIndex(partition.tmd, entry.contentId);
    if (!content) {
        return null;
    }

    const contentOffset =
        content.index === 0
            ? partition.partitionOffset
            : partition.partitionOffset +
              (partition.contentOffsets.get(content.index) ?? 0n);
    const encryptedContent = await readWudImageRange(
        image,
        contentOffset,
        Number(getEncryptedContentFileSize(content))
    );
    const iv = createWudContentIv(content.index);
    const decryptedContent = isHashedContent(content)
        ? decryptHashedContent(encryptedContent, partition.contentKey, iv)
        : decryptWudContent(encryptedContent, partition.contentKey, iv);
    const extracted = isHashedContent(content)
        ? extractHashedContentSlice(
              decryptedContent,
              entry.shiftedFileOffset,
              entry.fileLength
          )
        : decryptedContent.slice(
              entry.shiftedFileOffset,
              entry.shiftedFileOffset + entry.fileLength
          );
    if (!extracted) {
        return null;
    }

    const xmlIndex = findXmlStartByte(extracted);
    return xmlIndex >= 0 ? extracted.slice(xmlIndex) : null;
}

function findTmdContentByIndex(tmd: Tmd, contentIndex: number) {
    return (
        tmd.contents.find((content) => content.index === contentIndex) ??
        tmd.contents[contentIndex] ??
        null
    );
}

function createWudReadStream(
    image: WudImage,
    offset: bigint,
    size: bigint,
    signal?: AbortSignal
): Readable {
    return Readable.from(
        (async function* () {
            let cursor = 0n;

            while (cursor < size) {
                throwIfAborted(signal);
                const nextSize = Number(
                    size - cursor > BigInt(WUD_CLUSTER_SIZE)
                        ? BigInt(WUD_CLUSTER_SIZE)
                        : size - cursor
                );
                const chunk = await readWudImageRange(
                    image,
                    offset + cursor,
                    nextSize
                );
                cursor += BigInt(chunk.length);
                yield chunk;
            }
        })()
    );
}
