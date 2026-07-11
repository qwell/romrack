import { createDecipheriv, createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { scheduler } from 'node:timers/promises';

import { type DiscHeaderLocation } from './disc.js';

type WbfsHeaderInfo = {
    hdSectorShift: number;
    wbfsSectorShift: number;
    discHeaderOffset: number;
};

type WbfsPart = {
    path: string;
    sizeBytes: number;
};

type DiscPart = { file: FileHandle; size: number; start: number };

type DiscReader = {
    sparse: boolean;
    read(position: number, length: number): Promise<Buffer>;
    close(): Promise<void>;
};

export type WiiPartitionVerification = {
    index: number;
    type: number;
    offset: number;
    clusters: number;
    skippedClusters: number;
    failedClusters: number;
    status: 'ok' | 'failed';
    error: string | null;
};

export type WiiDiscVerification = {
    status: 'ok' | 'failed';
    error: string | null;
    verification: Array<
        WiiPartitionVerification | { status: 'skipped'; reason: string }
    >;
};

const WBFS_MAGIC = 'WBFS';
const WBFS_MAGIC_OFFSET = 0x00;
const WBFS_MAGIC_LENGTH = 0x04;
const WBFS_HEADER_LENGTH = 0x0c;
const WBFS_HD_SECTOR_SHIFT_OFFSET = 0x08;
const WBFS_WBFS_SECTOR_SHIFT_OFFSET = 0x09;
const WBFS_SPLIT_PART_PATTERN = /^\.wbf([1-9][0-9]*)$/i;

const WII_COMMON_KEYS = [
    Buffer.from('6+QqIl6Fk+RI2cVFc4Gq9w==', 'base64'),
    Buffer.from('Y7grtPRhTi4T8v77ukybfg==', 'base64'),
];
const WII_PARTITION_TABLE_OFFSET = 0x40000;
const WII_PARTITION_TABLE_GROUPS = 4;
const WII_PARTITION_HEADER_SIZE = 0x2c0;
const WII_DISABLE_HASH_VERIFICATION_OFFSET = 0x60;
const WII_DISABLE_ENCRYPTION_OFFSET = 0x61;
const WII_CLUSTER_SIZE = 0x8000;
const WII_CLUSTER_HASH_SIZE = 0x400;
const WII_CLUSTER_DATA_SIZE = 0x7c00;
const WII_VERIFY_YIELD_CLUSTER_INTERVAL = 32;
const WII_H3_TABLE_SIZE = 0x18000;
const WII_MAX_DISC_SIZE = 0x230480000;

function getWbfsSplitPartPath(filePath: string, index: number): string {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}.wbf${index}`);
}

function getWbfsSplitPartIndex(filePath: string): number | null {
    const match = path.extname(filePath).match(WBFS_SPLIT_PART_PATTERN);
    return match ? Number.parseInt(match[1] ?? '', 10) : null;
}

export function isWbfsSplitPart(filePath: string): boolean {
    return getWbfsSplitPartIndex(filePath) !== null;
}

export async function getWbfsDiscFilePaths(
    filePath: string
): Promise<string[]> {
    const partIndex = getWbfsSplitPartIndex(filePath);
    if (partIndex !== null) {
        return [filePath];
    }

    const files = [filePath];
    for (let index = 1; ; index += 1) {
        const partPath = getWbfsSplitPartPath(filePath, index);
        try {
            const info = await stat(partPath);
            if (!info.isFile()) {
                break;
            }
            files.push(partPath);
        } catch {
            break;
        }
    }

    return files;
}

export async function readWbfsDiscHeader(
    filePath: string,
    location: DiscHeaderLocation
): Promise<Buffer | null> {
    const parts = await getWbfsParts(filePath);
    const wbfsHeader = await readExactFromWbfsParts(
        parts,
        WBFS_HEADER_LENGTH,
        0
    );
    if (wbfsHeader === null) {
        return null;
    }

    const wbfsInfo = parseWbfsHeader(wbfsHeader);
    if (wbfsInfo === null) {
        return null;
    }

    return readExactFromWbfsParts(
        parts,
        location.length,
        wbfsInfo.discHeaderOffset + location.position
    );
}

async function getWbfsParts(filePath: string): Promise<WbfsPart[]> {
    return Promise.all(
        (await getWbfsDiscFilePaths(filePath)).map(async (partPath) => ({
            path: partPath,
            sizeBytes: (await stat(partPath)).size,
        }))
    );
}

async function readExactFromWbfsParts(
    parts: WbfsPart[],
    length: number,
    position: number
): Promise<Buffer | null> {
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    let partOffset = 0;

    for (const part of parts) {
        const partEnd = partOffset + part.sizeBytes;
        if (position >= partEnd) {
            partOffset = partEnd;
            continue;
        }

        const readPosition = Math.max(0, position - partOffset);
        const remainingPartBytes = part.sizeBytes - readPosition;
        const remainingBytes = length - bytesRead;
        const readLength = Math.min(remainingPartBytes, remainingBytes);
        if (readLength <= 0) {
            break;
        }

        const file = await open(part.path, 'r');
        try {
            const result = await file.read(
                buffer,
                bytesRead,
                readLength,
                readPosition
            );
            bytesRead += result.bytesRead;
        } finally {
            await file.close();
        }

        if (bytesRead === length) {
            return buffer;
        }

        partOffset = partEnd;
    }

    return null;
}

function parseWbfsHeader(buffer: Buffer): WbfsHeaderInfo | null {
    if (buffer.length < WBFS_HEADER_LENGTH) {
        return null;
    }

    const magic = buffer
        .subarray(WBFS_MAGIC_OFFSET, WBFS_MAGIC_OFFSET + WBFS_MAGIC_LENGTH)
        .toString('ascii');

    if (magic !== WBFS_MAGIC) {
        return null;
    }

    const hdSectorShift = buffer[WBFS_HD_SECTOR_SHIFT_OFFSET];
    if (hdSectorShift < 9 || hdSectorShift > 12) {
        return null;
    }

    const wbfsSectorShift = buffer[WBFS_WBFS_SECTOR_SHIFT_OFFSET];
    if (wbfsSectorShift < hdSectorShift || wbfsSectorShift > 30) {
        return null;
    }

    return {
        hdSectorShift,
        wbfsSectorShift,
        discHeaderOffset: 1 << hdSectorShift,
    };
}

export async function verifyWiiDisc(
    filePath: string,
    signal?: AbortSignal
): Promise<WiiDiscVerification> {
    const reader = await openDiscReader(filePath);
    try {
        const discFlags = await reader.read(
            WII_DISABLE_HASH_VERIFICATION_OFFSET,
            WII_DISABLE_ENCRYPTION_OFFSET -
                WII_DISABLE_HASH_VERIFICATION_OFFSET +
                1
        );
        if (discFlags[0] !== 0 || discFlags[1] !== 0) {
            return {
                status: 'ok',
                error: null,
                verification: [
                    {
                        status: 'skipped',
                        reason: 'Internal content verification is unavailable because Wii disc encryption or hash verification is disabled',
                    },
                ],
            };
        }

        const partitions = await readPartitions(reader);
        if (partitions.length === 0) {
            return {
                status: 'failed',
                error: 'Wii disc contains no partitions',
                verification: [],
            };
        }

        const verification: WiiPartitionVerification[] = [];
        for (const [index, partition] of partitions.entries()) {
            signal?.throwIfAborted();
            verification.push(
                await verifyPartition(reader, index, partition, signal)
            );
        }

        const failed = verification.filter(
            (partition) => partition.status === 'failed'
        );
        return {
            status: failed.length === 0 ? 'ok' : 'failed',
            error:
                failed.length === 0
                    ? null
                    : `${failed.length} of ${verification.length} Wii disc partition(s) failed verification`,
            verification,
        };
    } finally {
        await reader.close();
    }
}

async function readPartitions(
    reader: DiscReader
): Promise<Array<{ offset: number; type: number }>> {
    const groups = await reader.read(
        WII_PARTITION_TABLE_OFFSET,
        WII_PARTITION_TABLE_GROUPS * 8
    );
    const partitions: Array<{ offset: number; type: number }> = [];

    for (let group = 0; group < WII_PARTITION_TABLE_GROUPS; group += 1) {
        const count = groups.readUInt32BE(group * 8);
        const tableOffset = groups.readUInt32BE(group * 8 + 4) * 4;
        if (count === 0) continue;
        if (count > 64 || tableOffset < WII_PARTITION_TABLE_OFFSET) {
            throw new Error(`Invalid Wii partition table ${group}`);
        }
        const table = await reader.read(tableOffset, count * 8);
        for (let index = 0; index < count; index += 1) {
            partitions.push({
                offset: table.readUInt32BE(index * 8) * 4,
                type: table.readUInt32BE(index * 8 + 4),
            });
        }
    }

    return partitions;
}

async function verifyPartition(
    reader: DiscReader,
    index: number,
    partition: { offset: number; type: number },
    signal?: AbortSignal
): Promise<WiiPartitionVerification> {
    try {
        const header = await reader.read(
            partition.offset,
            WII_PARTITION_HEADER_SIZE
        );
        const dataOffset = header.readUInt32BE(0x2b8) * 4;
        const dataSize = header.readUInt32BE(0x2bc) * 4;
        const h3Offset = header.readUInt32BE(0x2b4) * 4;
        if (
            dataOffset < WII_PARTITION_HEADER_SIZE ||
            dataSize === 0 ||
            dataSize % WII_CLUSTER_SIZE !== 0
        ) {
            throw new Error('Invalid Wii partition data range');
        }

        const titleKey = decryptPartitionTitleKey(header);
        const h3 = await reader.read(
            partition.offset + h3Offset,
            WII_H3_TABLE_SIZE
        );
        await verifyH3Table(reader, partition.offset, header, h3);

        const clusters = dataSize / WII_CLUSTER_SIZE;
        let failedClusters = 0;
        let skippedClusters = 0;
        let firstFailure: string | null = null;
        for (let cluster = 0; cluster < clusters; cluster += 1) {
            signal?.throwIfAborted();
            if (cluster % WII_VERIFY_YIELD_CLUSTER_INTERVAL === 0) {
                await scheduler.yield();
            }
            const raw = await reader.read(
                partition.offset + dataOffset + cluster * WII_CLUSTER_SIZE,
                WII_CLUSTER_SIZE
            );
            if (reader.sparse && raw.every((value) => value === 0)) {
                skippedClusters += 1;
                continue;
            }
            const error = verifyCluster(raw, titleKey, h3, cluster);
            if (error) {
                failedClusters += 1;
                firstFailure ??= error;
            }
        }

        return {
            index,
            type: partition.type,
            offset: partition.offset,
            clusters,
            skippedClusters,
            failedClusters,
            status: failedClusters === 0 ? 'ok' : 'failed',
            error:
                failedClusters === 0
                    ? null
                    : `${failedClusters} cluster(s) failed; ${firstFailure}`,
        };
    } catch (error) {
        if (signal?.aborted) throw error;
        return {
            index,
            type: partition.type,
            offset: partition.offset,
            clusters: 0,
            skippedClusters: 0,
            failedClusters: 0,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function decryptPartitionTitleKey(header: Buffer): Buffer {
    const commonKeyIndex = header[0x1f1];
    const commonKey = WII_COMMON_KEYS[commonKeyIndex];
    if (!commonKey) {
        throw new Error(`Unsupported Wii common key index ${commonKeyIndex}`);
    }
    const iv = Buffer.alloc(16);
    header.copy(iv, 0, 0x1dc, 0x1e4);
    return decryptAesCbc(header.subarray(0x1bf, 0x1cf), commonKey, iv);
}

async function verifyH3Table(
    reader: DiscReader,
    partitionOffset: number,
    header: Buffer,
    h3: Buffer
): Promise<void> {
    const tmdSize = header.readUInt32BE(0x2a4);
    const tmdOffset = header.readUInt32BE(0x2a8) * 4;
    if (tmdSize === 0 || tmdSize > 0x100000) {
        throw new Error('Invalid Wii partition TMD size');
    }
    const tmd = await reader.read(partitionOffset + tmdOffset, tmdSize);
    const payloadOffset = getSignedPayloadOffset(tmd);
    const contentCount = tmd.readUInt16BE(payloadOffset + 0x9e);
    if (contentCount === 0) throw new Error('Wii partition TMD has no content');
    const expected = tmd.subarray(payloadOffset + 0xb4, payloadOffset + 0xc8);
    if (!sha1(h3).equals(expected)) {
        throw new Error('Wii partition H3 table hash does not match its TMD');
    }
}

function getSignedPayloadOffset(buffer: Buffer): number {
    const signatureType = buffer.readUInt32BE(0);
    switch (signatureType) {
        case 0x00010000:
            return 0x240;
        case 0x00010001:
            return 0x140;
        case 0x00010002:
            return 0x80;
        default:
            throw new Error(
                `Unsupported Wii signature type 0x${signatureType.toString(16)}`
            );
    }
}

function verifyCluster(
    raw: Buffer,
    titleKey: Buffer,
    h3: Buffer,
    cluster: number
): string | null {
    const hashes = decryptAesCbc(
        raw.subarray(0, WII_CLUSTER_HASH_SIZE),
        titleKey,
        Buffer.alloc(16)
    );
    const data = decryptAesCbc(
        raw.subarray(WII_CLUSTER_HASH_SIZE),
        titleKey,
        raw.subarray(0x3d0, 0x3e0)
    );

    for (let block = 0; block < WII_CLUSTER_DATA_SIZE / 0x400; block += 1) {
        const expected = hashes.subarray(block * 20, block * 20 + 20);
        if (
            !sha1(data.subarray(block * 0x400, (block + 1) * 0x400)).equals(
                expected
            )
        ) {
            return `cluster ${cluster} H0 mismatch at block ${block}`;
        }
    }

    const h1 = sha1(hashes.subarray(0, 0x26c));
    const h1Offset = 0x280 + (cluster % 8) * 20;
    if (!h1.equals(hashes.subarray(h1Offset, h1Offset + 20))) {
        return `cluster ${cluster} H1 mismatch`;
    }
    const h2 = sha1(hashes.subarray(0x280, 0x320));
    const h2Offset = 0x340 + (Math.floor(cluster / 8) % 8) * 20;
    if (!h2.equals(hashes.subarray(h2Offset, h2Offset + 20))) {
        return `cluster ${cluster} H2 mismatch`;
    }
    const h3Expected = h3.subarray(
        Math.floor(cluster / 64) * 20,
        Math.floor(cluster / 64) * 20 + 20
    );
    if (!sha1(hashes.subarray(0x340, 0x3e0)).equals(h3Expected)) {
        return `cluster ${cluster} H3 mismatch`;
    }
    return null;
}

function sha1(buffer: Buffer): Buffer {
    return createHash('sha1').update(buffer).digest();
}

function decryptAesCbc(data: Buffer, key: Buffer, iv: Buffer): Buffer {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

async function openDiscReader(filePath: string): Promise<DiscReader> {
    return path.extname(filePath).toLowerCase() === '.iso'
        ? openIsoReader(filePath)
        : openWbfsReader(filePath);
}

async function openIsoReader(filePath: string): Promise<DiscReader> {
    const file = await open(filePath, 'r');
    return {
        sparse: false,
        read: (position, length) => readExact(file, position, length),
        close: () => file.close(),
    };
}

async function openWbfsReader(filePath: string): Promise<DiscReader> {
    const paths = await getWbfsDiscFilePaths(filePath);
    const parts: DiscPart[] = [];
    let start = 0;
    for (const partPath of paths) {
        const size = (await stat(partPath)).size;
        parts.push({ file: await open(partPath, 'r'), size, start });
        start += size;
    }

    try {
        const physicalRead = (position: number, length: number) =>
            readSplit(parts, position, length);
        const header = await physicalRead(0, 0x100);
        if (header.subarray(0, 4).toString('ascii') !== WBFS_MAGIC) {
            throw new Error('Invalid WBFS header');
        }
        const hdSectorSize = 2 ** header[8];
        const wbfsSectorSize = 2 ** header[9];
        const discTable = await physicalRead(0x0c, hdSectorSize - 0x0c);
        const discIndex = discTable.findIndex((value) => value !== 0);
        if (discIndex === -1) throw new Error('WBFS contains no disc');
        const logicalSectorCount = Math.ceil(
            WII_MAX_DISC_SIZE / wbfsSectorSize
        );
        const discInfoSize =
            Math.ceil((0x100 + logicalSectorCount * 2) / hdSectorSize) *
            hdSectorSize;
        const discOffset = hdSectorSize + discIndex * discInfoSize;
        const wlba = await physicalRead(
            discOffset + 0x100,
            logicalSectorCount * 2
        );

        return {
            sparse: true,
            read: async (position, length) => {
                const output = Buffer.alloc(length);
                let outputOffset = 0;
                while (outputOffset < length) {
                    const logicalPosition = position + outputOffset;
                    const sector = Math.floor(logicalPosition / wbfsSectorSize);
                    const sectorOffset = logicalPosition % wbfsSectorSize;
                    const chunk = Math.min(
                        length - outputOffset,
                        wbfsSectorSize - sectorOffset
                    );
                    const physicalSector = wlba.readUInt16BE(sector * 2);
                    if (physicalSector !== 0) {
                        const data = await physicalRead(
                            physicalSector * wbfsSectorSize + sectorOffset,
                            chunk
                        );
                        data.copy(output, outputOffset);
                    }
                    outputOffset += chunk;
                }
                return output;
            },
            close: () => closeParts(parts),
        };
    } catch (error) {
        await closeParts(parts);
        throw error;
    }
}

async function readSplit(
    parts: DiscPart[],
    position: number,
    length: number
): Promise<Buffer> {
    const output = Buffer.alloc(length);
    let outputOffset = 0;
    while (outputOffset < length) {
        const absolute = position + outputOffset;
        const part = parts.find(
            (candidate) =>
                absolute >= candidate.start &&
                absolute < candidate.start + candidate.size
        );
        if (!part) throw new Error('Unexpected end of split WBFS image');
        const partOffset = absolute - part.start;
        const chunk = Math.min(length - outputOffset, part.size - partOffset);
        const result = await part.file.read(
            output,
            outputOffset,
            chunk,
            partOffset
        );
        if (result.bytesRead !== chunk) {
            throw new Error('Unexpected end of split WBFS image');
        }
        outputOffset += chunk;
    }
    return output;
}

async function readExact(
    file: FileHandle,
    position: number,
    length: number
): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, position);
    if (result.bytesRead !== length)
        throw new Error('Unexpected end of Wii ISO');
    return buffer;
}

async function closeParts(parts: DiscPart[]): Promise<void> {
    await Promise.all(parts.map((part) => part.file.close()));
}
