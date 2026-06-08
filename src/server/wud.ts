import { createDecipheriv } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { decryptTitleKey } from './decryption.js';
import {
    decryptHashedContent,
    extractHashedContentSlice,
    getContentInstallFiles,
    getEncryptedContentFileSize,
    isHashedContent,
    verifyContentInstallFiles,
    type ContentTreeVerification,
} from './nus/content.js';
import {
    findFstEntry,
    getRootDirectoryChildren,
    looksLikeFst,
    readFstContentInfos,
    parseTitleFstEntries,
} from './nus/fst.js';
import { findXmlStartByte, readMetaXml } from './nus/meta.js';
import {
    getTitleIdHex,
    readTmdFromBuffer,
    TMD_TITLE_FILE,
    type Tmd,
} from './nus/tmd.js';
import {
    type GeneratedTitleInstallFiles,
    TIK_TITLE_FILE,
    CERT_TITLE_FILE,
    createGeneratedCert,
    formatInstallDirectoryKind,
    normalizeDownloadableTitleId,
    readCommonKey,
    readTikFromBuffer,
} from './title.js';
import { normalizeTitleId, normalizeTitleName } from '../shared/titles.js';
import { getImmediatePathSizeBytes, readOptionalFile } from '../shared/file.js';
import { findReadablePath } from '../shared/os.js';
import { safeDirectoryName } from '../shared/string.js';
import logger from '../shared/logger.js';

type WuxInfo = {
    sectorSize: number;
    uncompressedSize: bigint;
    offsetSectorArray: bigint;
    indexTable: number[];
};

type WudImage = {
    filePath: string;
    file: FileHandle;
    compressed: WuxInfo | null;
};

type WudPartitionReference = {
    name: string;
    offset: bigint;
};

type WudGamePartition = {
    name: string;
    partitionOffset: bigint;
    header: Buffer;
    contentKey: Uint8Array;
    contentKeyPassword: string | null;
    rawTmd: Uint8Array;
    rawTicket: Uint8Array;
    rawCert: Uint8Array;
    tmd: Tmd;
    fst: Buffer;
    contentOffsets: Map<number, bigint>;
};

export type WudConvertProgress = {
    currentFileName: string | null;
    currentFileSizeBytes: number;
    completedFiles: number;
    totalFiles: number;
};

export type ConvertedWudImage = {
    sourcePath: string;
    titles: GeneratedTitleInstallFiles[];
};

export type LibraryWudConvertResult = {
    converted: ConvertedWudImage[];
};

const WUD_FILE_EXTENSIONS = new Set(['.wud', '.wux']);
const DISC_KEY_SIZE = 0x10;

const WUD_DECRYPTED_AREA_OFFSET = 0x18000n;
const WUD_SECTOR_SIZE = 0x8000;
const WUD_CLUSTER_SIZE = 0x10000;
const WUX_HEADER_SIZE = 0x20;
const WUX_MAGIC_0 = 0x30585557;
const WUX_MAGIC_1 = 0x1099d02e;
const WUX_SECTOR_SIZE_OFFSET = 0x08;
const WUX_UNCOMPRESSED_SIZE_OFFSET = 0x10;
const WUX_INDEX_TABLE_ENTRY_SIZE = 0x04;

const PARTITION_TOC_ENTRY_SIZE = 0x80;
const PARTITION_TOC_OFFSET = 0x800;
const PARTITION_TOC_COUNT_OFFSET = 0x1c;
const PARTITION_TOC_NAME_SIZE = 0x19;
const PARTITION_TOC_SECTOR_OFFSET = 0x20;
const PARTITION_HEADER_META_SIZE = 0x20;
const PARTITION_HEADER_SIZE_OFFSET = 0x04;
const PARTITION_HEADER_FST_SIZE_OFFSET = 0x14;
const PARTITION_HEADER_HASH_COUNT_OFFSET = 0x10;
const PARTITION_HEADER_HASH_TABLE_OFFSET = 0x40;
const PARTITION_HEADER_HASH_POINTER_SIZE = 0x04;
const PARTITION_START_SIGNATURE = 0xcc93a4f5;
const DECRYPTED_AREA_SIGNATURE = 0xcca6e67b;

const DOWNLOADABLE_TITLE_PREFIXES = new Set([
    '00050000',
    '0005000c',
    '0005000e',
]);
const H3_HASH_ENTRY_SIZE = 0x14;
const H3_HASH_CLUSTER_SPAN = 0x1000;
const AES_BLOCK_SIZE = 0x10;
const IV_FILE_OFFSET_SHIFT = 16n;

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

export async function convertWudImagesInRoots(
    roots: string[],
    titleId: string,
    options: {
        onProgress?: (progress: WudConvertProgress) => void;
        signal?: AbortSignal;
    } = {}
): Promise<LibraryWudConvertResult> {
    const imagePaths = await findWudImagePaths(roots);
    const requestedTitleId = normalizeTitleId(titleId);
    if (requestedTitleId.length !== 16) {
        throw new Error(`Invalid titleId: ${titleId}`);
    }
    const requestedFamily = requestedTitleId.slice(8);
    const commonKey = await readCommonKey();
    const converted: ConvertedWudImage[] = [];
    logger.log(
        'wud',
        `converting WUD/WUX title ${requestedTitleId}; found ${imagePaths.length} image(s)`
    );

    for (const imagePath of imagePaths) {
        throwIfAborted(options.signal);
        try {
            logger.log('wud', `reading ${imagePath}`);
            const discKey = await readWudDiscKey(imagePath);
            if (!discKey) {
                logger.warn('wud', `skipping ${imagePath}: no usable disc key`);
                continue;
            }
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
                const titles: GeneratedTitleInstallFiles[] = [];

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
                            `skipping ${partition.name}: ${error instanceof Error ? error.message : String(error)}`
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
                await image.file.close();
            }
        } catch (error) {
            throwIfAborted(options.signal);
            const message =
                error instanceof Error ? error.message : String(error);
            logger.warn('wud', `skipping ${imagePath}: ${message}`);
        }
    }

    return { converted };
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
            continue;
        }

        if (
            entry.isFile() &&
            WUD_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
            found.push(entryPath);
        }
    }

    return found;
}

async function openWudImage(filePath: string): Promise<WudImage> {
    const file = await open(filePath, 'r');

    try {
        const header = await readFileRange(file, 0n, WUX_HEADER_SIZE);
        const compressed = parseWuxInfo(header);

        return {
            filePath,
            file,
            compressed: compressed
                ? await readWuxIndexTable(file, compressed)
                : null,
        };
    } catch (error) {
        await file.close();
        throw error;
    }
}

async function readWudDiscKey(imagePath: string): Promise<Uint8Array | null> {
    const parsed = path.parse(imagePath);
    const candidates = [
        path.join(parsed.dir, `${parsed.name}.key`),
        path.join(parsed.dir, 'game.key'),
    ];

    for (const candidate of candidates) {
        const raw = await readOptionalFile(candidate);
        if (!raw) {
            continue;
        }
        const result = parseDiscKeyBytes(raw, candidate);
        if (result) {
            return result;
        }
    }

    logger.warn(
        'wud',
        `no usable disc key for ${imagePath}; checked ${candidates.join(' and ')}`
    );
    return null;
}

function parseDiscKeyBytes(
    raw: Uint8Array,
    filePath: string
): Uint8Array | null {
    if (raw.length === DISC_KEY_SIZE) {
        return new Uint8Array(raw);
    }

    const text = Buffer.from(raw).toString('utf8');
    const compact = text.trim().replace(/\s+/g, '');
    const hex = /^[0-9a-f]{32}$/i.test(compact)
        ? compact
        : (text.match(/[0-9a-f]{32}/i)?.[0] ?? null);

    if (!hex) {
        logger.log(
            'wud',
            `Disc key at ${filePath} must be 16 bytes or 32 hexadecimal characters`
        );

        return null;
    }

    return new Uint8Array(Buffer.from(hex, 'hex'));
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
    const indexTableEntryCount =
        (uncompressedSize + BigInt(sectorSize) - 1n) / BigInt(sectorSize);
    let offsetSectorArray =
        BigInt(WUX_HEADER_SIZE) +
        indexTableEntryCount * BigInt(WUX_INDEX_TABLE_ENTRY_SIZE);
    offsetSectorArray += BigInt(sectorSize - 1);
    offsetSectorArray -= offsetSectorArray % BigInt(sectorSize);

    return {
        sectorSize,
        uncompressedSize,
        offsetSectorArray,
    };
}

async function readWuxIndexTable(
    file: FileHandle,
    info: Omit<WuxInfo, 'indexTable'>
): Promise<WuxInfo> {
    const entryCount =
        (info.uncompressedSize + BigInt(info.sectorSize) - 1n) /
        BigInt(info.sectorSize);
    const table = await readFileRange(
        file,
        BigInt(WUX_HEADER_SIZE),
        Number(entryCount * BigInt(WUX_INDEX_TABLE_ENTRY_SIZE))
    );
    const indexTable: number[] = [];

    for (let offset = 0; offset < table.length; offset += 4) {
        indexTable.push(table.readUInt32LE(offset));
    }

    return {
        ...info,
        indexTable,
    };
}

async function readWudGamePartitions(
    image: WudImage,
    discKey: Uint8Array,
    commonKey: Uint8Array,
    requestedFamily: string | null
): Promise<WudGamePartition[]> {
    const partitionTocBlock = await readDecryptedRange(
        image,
        WUD_DECRYPTED_AREA_OFFSET,
        0n,
        WUD_SECTOR_SIZE,
        discKey,
        null,
        true
    );

    if (partitionTocBlock.readUInt32BE(0) !== DECRYPTED_AREA_SIGNATURE) {
        logger.warn(
            'wud',
            `failed to decrypt partition table for ${image.filePath}`
        );
        return [];
    }

    const partitions = readPartitionReferences(partitionTocBlock);
    const siPartition = partitions.find((partition) =>
        partition.name.startsWith('SI')
    );

    if (!siPartition) {
        logger.warn('wud', `no SI partition found in ${image.filePath}`);
        return [];
    }

    const si = await readDataPartition(image, siPartition, discKey);
    if (!si) {
        logger.warn('wud', `failed to read SI partition in ${image.filePath}`);
        return [];
    }
    const gamePartitions: WudGamePartition[] = [];
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
    discKey: Uint8Array,
    commonKey: Uint8Array,
    requestedFamily: string | null
): Promise<WudGamePartition | null> {
    try {
        logger.log('wud', `reading WUD title metadata from ${child}`);
        const rawTicket = await readFstFile(
            image,
            si,
            `${child}/title.tik`,
            discKey
        );
        if (!rawTicket) {
            logger.warn('wud', `skipping ${child}: missing title.tik`);
            return null;
        }

        const ticket = readTikFromBuffer(Buffer.from(rawTicket));
        if (!ticket) {
            logger.warn('wud', `skipping ${child}: invalid title.tik`);
            return null;
        }

        const titleId = getTitleIdHex(ticket.titleId);
        if (
            !DOWNLOADABLE_TITLE_PREFIXES.has(titleId.slice(0, 8)) ||
            (requestedFamily !== null && titleId.slice(8) !== requestedFamily)
        ) {
            return null;
        }

        const rawTmd = await readFstFile(
            image,
            si,
            `${child}/title.tmd`,
            discKey
        );
        if (!rawTmd) {
            logger.warn('wud', `skipping ${child}: missing title.tmd`);
            return null;
        }

        const tmd = readTmdFromBuffer(Buffer.from(rawTmd));
        if (!tmd) {
            logger.warn('wud', `skipping ${child}: invalid title.tmd`);
            return null;
        }
        const rawCert =
            (await readFstFile(image, si, `${child}/title.cert`, discKey)) ??
            new Uint8Array();
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
        return await readGamePartition(
            image,
            partitionReference,
            contentKey,
            null,
            rawTmd,
            rawCert,
            rawTicket,
            tmd
        );
    } catch (error) {
        logger.warn(
            'wud',
            `skipping ${child}: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

function readPartitionReferences(buffer: Buffer): WudPartitionReference[] {
    const count = buffer.readUInt32BE(PARTITION_TOC_COUNT_OFFSET);
    const partitions: WudPartitionReference[] = [];

    for (let index = 0; index < count; index += 1) {
        const offset = PARTITION_TOC_OFFSET + index * PARTITION_TOC_ENTRY_SIZE;
        const name = buffer
            .toString('ascii', offset, offset + PARTITION_TOC_NAME_SIZE)
            .replace(/\0.*$/, '');
        const sector = buffer.readUInt32BE(
            offset + PARTITION_TOC_SECTOR_OFFSET
        );

        partitions.push({
            name,
            offset: BigInt(sector) * BigInt(WUD_SECTOR_SIZE),
        });
    }

    return partitions;
}

type WudDataPartition = {
    partitionOffset: bigint;
    headerSize: bigint;
    fst: Buffer;
};

async function readDataPartition(
    image: WudImage,
    partition: WudPartitionReference,
    discKey: Uint8Array
): Promise<WudDataPartition | null> {
    const headerMeta = await readEncryptedRange(
        image,
        partition.offset,
        PARTITION_HEADER_META_SIZE
    );

    if (headerMeta.readUInt32BE(0) !== PARTITION_START_SIGNATURE) {
        return null;
    }

    const headerSize = BigInt(
        headerMeta.readUInt32BE(PARTITION_HEADER_SIZE_OFFSET)
    );
    const fstSize = headerMeta.readUInt32BE(PARTITION_HEADER_FST_SIZE_OFFSET);
    const fst = await readDecryptedRange(
        image,
        partition.offset + headerSize,
        0n,
        fstSize,
        discKey,
        null,
        true
    );

    if (!looksLikeFst(fst)) {
        return null;
    }

    return {
        partitionOffset: partition.offset,
        headerSize,
        fst,
    };
}

async function readGamePartition(
    image: WudImage,
    partition: WudPartitionReference,
    contentKey: Uint8Array,
    contentKeyPassword: string | null,
    rawTmd: Uint8Array,
    rawCert: Uint8Array,
    rawTicket: Uint8Array,
    tmd: Tmd
): Promise<WudGamePartition | null> {
    const headerMeta = await readEncryptedRange(
        image,
        partition.offset,
        PARTITION_HEADER_META_SIZE
    );

    if (headerMeta.readUInt32BE(0) !== PARTITION_START_SIGNATURE) {
        return null;
    }

    const headerSize = BigInt(
        headerMeta.readUInt32BE(PARTITION_HEADER_SIZE_OFFSET)
    );
    const header = await readEncryptedRange(
        image,
        partition.offset,
        Number(headerSize)
    );
    const partitionOffset = partition.offset + headerSize;
    const fstContentSize = Number(getEncryptedContentFileSize(tmd.contents[0]));
    const fst = await readDecryptedRange(
        image,
        partitionOffset,
        0n,
        fstContentSize,
        contentKey,
        null,
        true
    );

    if (!looksLikeFst(fst)) {
        return null;
    }

    return {
        name: partition.name,
        partitionOffset,
        header,
        contentKey,
        contentKeyPassword,
        rawTmd,
        rawCert,
        rawTicket,
        tmd,
        fst,
        contentOffsets: readFstByteOffsets(fst),
    };
}

async function convertWudGamePartition({
    image,
    partition,
    outputRoot,
    onProgress,
    signal,
}: {
    image: WudImage;
    partition: WudGamePartition;
    outputRoot: string;
    onProgress?: (progress: WudConvertProgress) => void;
    signal?: AbortSignal;
}): Promise<GeneratedTitleInstallFiles> {
    const titleId = getTitleIdHex(partition.tmd.header.titleId);
    const { kind } = normalizeDownloadableTitleId(titleId);
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
    const verification: ContentTreeVerification[] = [];

    await mkdir(outputDir, { recursive: true });
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
    const totalFiles = partition.tmd.contents.reduce(
        (total, content) => total + (isHashedContent(content) ? 2 : 1),
        0
    );
    for (const content of partition.tmd.contents) {
        throwIfAborted(signal);
        const installFiles = getContentInstallFiles(outputDir, content);
        logger.log(
            'wud',
            `extracting ${titleId} content ${installFiles.contentId} to ${installFiles.appName}`
        );
        onProgress?.({
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
            const h3 = readPartitionH3(partition, content.index, content.size);
            onProgress?.({
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
        const result = await verifyContentInstallFiles({
            files: installFiles,
            content,
            titleKey,
            signal,
        });
        if (result.status !== 'ok') {
            logger.warn(
                'wud',
                `verification failed for ${titleId} content ${installFiles.contentId}: ${result.error ?? result.status}`
            );
        }
        files.app.push(installFiles.appName);
        verification.push(result);

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
        titleKeyPassword: partition.contentKeyPassword,
        outputDir,
        sizeBytes: await getImmediatePathSizeBytes(outputDir),
        files,
        verification,
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
        createWriteStream(targetFile)
    );
}

async function extractMetaXmlFromPartition(
    image: WudImage,
    partition: WudGamePartition
): Promise<Uint8Array | null> {
    const entries = parseTitleFstEntries(partition.fst, partition.tmd);
    const entry =
        entries.find((candidate) => candidate.fullPath === 'meta/meta.xml') ??
        entries.find((candidate) => candidate.name === 'meta.xml') ??
        null;
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
    const encryptedContent = await readEncryptedRange(
        image,
        contentOffset,
        Number(getEncryptedContentFileSize(content))
    );
    const iv = createContentIv(content.index);
    const decryptedContent = isHashedContent(content)
        ? decryptHashedContent(encryptedContent, partition.contentKey, iv)
        : decryptContent(encryptedContent, partition.contentKey, iv);
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

function readPartitionH3(
    partition: WudGamePartition,
    contentIndex: number,
    encryptedSize: number
): Uint8Array {
    const hashedContents = partition.tmd.contents.filter(
        (content) => isHashedContent(content) && (content.type & 1) === 1
    );
    let hashOffset = 0;

    for (const content of hashedContents) {
        const h3Size =
            (Math.floor(
                Number(getEncryptedContentFileSize(content)) /
                    WUD_CLUSTER_SIZE /
                    H3_HASH_CLUSTER_SPAN
            ) +
                1) *
            H3_HASH_ENTRY_SIZE;

        if (content.index === contentIndex) {
            return partition.header.subarray(
                readPartitionHeaderHashStart(partition.header) + hashOffset,
                readPartitionHeaderHashStart(partition.header) +
                    hashOffset +
                    h3Size
            );
        }

        hashOffset += h3Size;
    }

    throw new Error(
        `Missing H3 data for content ${contentIndex} (${encryptedSize.toString()} bytes)`
    );
}

function readPartitionHeaderHashStart(header: Buffer): number {
    const count = header.readUInt32BE(PARTITION_HEADER_HASH_COUNT_OFFSET);
    return (
        PARTITION_HEADER_HASH_TABLE_OFFSET +
        count * PARTITION_HEADER_HASH_POINTER_SIZE
    );
}

function readFstByteOffsets(fst: Buffer): Map<number, bigint> {
    return new Map(
        [...readFstContentInfos(fst)].map(([index, info]) => [
            index,
            info.offset,
        ])
    );
}

async function readFstFile(
    image: WudImage,
    partition: WudDataPartition,
    fullPath: string,
    discKey: Uint8Array
): Promise<Uint8Array | null> {
    const entry = findFstEntry(partition.fst, fullPath);

    if (!entry) {
        return null;
    }

    const contentOffset =
        partition.headerSize +
        partition.partitionOffset +
        (readFstContentInfos(partition.fst).get(entry.contentId)?.offset ?? 0n);
    const iv = createFileOffsetIv(BigInt(entry.shiftedFileOffset));

    return readDecryptedRange(
        image,
        contentOffset,
        BigInt(entry.shiftedFileOffset),
        entry.fileLength,
        discKey,
        iv,
        false
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
                const chunk = await readEncryptedRange(
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

async function readEncryptedRange(
    image: WudImage,
    offset: bigint,
    size: number | bigint
): Promise<Buffer> {
    const length = typeof size === 'bigint' ? Number(size) : size;

    if (!image.compressed) {
        return readFileRange(image.file, offset, length);
    }

    const output = Buffer.alloc(length);
    let outputOffset = 0;
    let usedOffset = offset;
    let remaining = length;

    while (remaining > 0) {
        const sectorSize = BigInt(image.compressed.sectorSize);
        const sectorOffset = usedOffset % sectorSize;
        const sectorIndex = Number(usedOffset / sectorSize);
        const realSectorIndex = image.compressed.indexTable[sectorIndex];
        const bytesToRead = Math.min(
            Number(sectorSize - sectorOffset),
            remaining
        );

        if (realSectorIndex === undefined) {
            throw new Error(`Missing WUX sector ${sectorIndex}`);
        }

        const chunk = await readFileRange(
            image.file,
            image.compressed.offsetSectorArray +
                BigInt(realSectorIndex) * sectorSize +
                sectorOffset,
            bytesToRead
        );
        chunk.copy(output, outputOffset);
        outputOffset += chunk.length;
        usedOffset += BigInt(chunk.length);
        remaining -= chunk.length;
    }

    return output;
}

async function readDecryptedRange(
    image: WudImage,
    clusterOffset: bigint,
    fileOffset: bigint,
    size: number,
    key: Uint8Array,
    iv: Uint8Array | null,
    useFixedIv: boolean
): Promise<Buffer> {
    const output = Buffer.alloc(size);
    let written = 0;
    let usedFileOffset = fileOffset;

    while (written < size) {
        const blockNumber = usedFileOffset / BigInt(WUD_CLUSTER_SIZE);
        const blockOffset = Number(usedFileOffset % BigInt(WUD_CLUSTER_SIZE));
        const readOffset =
            clusterOffset + blockNumber * BigInt(WUD_CLUSTER_SIZE);
        const usedIv = useFixedIv
            ? (iv ?? new Uint8Array(16))
            : createFileOffsetIv(usedFileOffset);
        const decrypted = decryptContent(
            await readEncryptedRange(image, readOffset, WUD_CLUSTER_SIZE),
            key,
            usedIv
        );
        const copySize = Math.min(
            size - written,
            WUD_CLUSTER_SIZE - blockOffset
        );

        decrypted.copy(output, written, blockOffset, blockOffset + copySize);
        written += copySize;
        usedFileOffset += BigInt(copySize);
    }

    return output;
}

async function readFileRange(
    file: FileHandle,
    offset: bigint,
    size: number
): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, offset);
    if (bytesRead !== size) {
        throw new Error(
            `Unexpected end of WUD/WUX at offset ${offset.toString()}: expected ${size} bytes, read ${bytesRead}`
        );
    }

    return buffer;
}

function decryptContent(
    encrypted: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array
): Buffer {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([
        decipher.update(Buffer.from(encrypted)),
        decipher.final(),
    ]);
}

function createContentIv(contentIndex: number): Uint8Array {
    const iv = new Uint8Array(AES_BLOCK_SIZE);
    new DataView(iv.buffer).setUint16(0, contentIndex, false);
    return iv;
}

function createFileOffsetIv(fileOffset: bigint): Uint8Array {
    const iv = new Uint8Array(AES_BLOCK_SIZE);
    new DataView(iv.buffer).setBigUint64(
        AES_BLOCK_SIZE / 2,
        fileOffset >> IV_FILE_OFFSET_SHIFT,
        false
    );
    return iv;
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
