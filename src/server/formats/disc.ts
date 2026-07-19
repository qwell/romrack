import { createDecipheriv, createHash } from 'node:crypto';
import { scheduler } from 'node:timers/promises';
import { formatLogError } from '../../shared/utils.js';

export type DiscReader = {
    sparse: boolean;
    read(position: number, length: number): Promise<Buffer>;
    close(): Promise<void>;
};

export type WiiDiscPartition = {
    offset: number;
    type: number;
};

export type WiiPartitionHeader = {
    tmdOffset: number;
    tmdSize: number;
    certificateOffset: number;
    certificateSize: number;
    h3Offset: number;
    dataOffset: number;
    dataSize: number;
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

export async function readWiiDiscPartitions(
    reader: DiscReader
): Promise<WiiDiscPartition[]> {
    const groups = await reader.read(
        WII_PARTITION_TABLE_OFFSET,
        WII_PARTITION_TABLE_GROUPS * 8
    );
    const partitions: WiiDiscPartition[] = [];

    for (let group = 0; group < WII_PARTITION_TABLE_GROUPS; group += 1) {
        const count = groups.readUInt32BE(group * 8);
        const tableOffset = groups.readUInt32BE(group * 8 + 4) * 4;
        if (count === 0) {
            continue;
        }
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

export function readWiiPartitionHeader(
    header: Buffer
): WiiPartitionHeader | null {
    if (header.length < WII_PARTITION_HEADER_SIZE) {
        return null;
    }
    const result = {
        tmdSize: header.readUInt32BE(0x2a4),
        tmdOffset: header.readUInt32BE(0x2a8) * 4,
        certificateSize: header.readUInt32BE(0x2ac),
        certificateOffset: header.readUInt32BE(0x2b0) * 4,
        h3Offset: header.readUInt32BE(0x2b4) * 4,
        dataOffset: header.readUInt32BE(0x2b8) * 4,
        dataSize: header.readUInt32BE(0x2bc) * 4,
    };
    return result.dataOffset < WII_PARTITION_HEADER_SIZE ||
        result.dataSize === 0 ||
        result.dataSize % WII_CLUSTER_SIZE !== 0
        ? null
        : result;
}

export async function verifyWiiDisc(
    reader: DiscReader,
    signal?: AbortSignal
): Promise<WiiDiscVerification> {
    const discFlags = await reader.read(
        WII_DISABLE_HASH_VERIFICATION_OFFSET,
        WII_DISABLE_ENCRYPTION_OFFSET - WII_DISABLE_HASH_VERIFICATION_OFFSET + 1
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

    const partitions = await readWiiDiscPartitions(reader);
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
}

async function verifyPartition(
    reader: DiscReader,
    index: number,
    partition: WiiDiscPartition,
    signal?: AbortSignal
): Promise<WiiPartitionVerification> {
    try {
        const rawHeader = await reader.read(
            partition.offset,
            WII_PARTITION_HEADER_SIZE
        );
        const header = readWiiPartitionHeader(rawHeader);
        if (!header) {
            throw new Error('Invalid Wii partition data range');
        }

        const titleKey = decryptPartitionTitleKey(rawHeader);
        const h3 = await reader.read(
            partition.offset + header.h3Offset,
            WII_H3_TABLE_SIZE
        );
        await verifyH3Table(reader, partition.offset, header, h3);

        const clusters = header.dataSize / WII_CLUSTER_SIZE;
        let failedClusters = 0;
        let skippedClusters = 0;
        let firstFailure: string | null = null;
        for (let cluster = 0; cluster < clusters; cluster += 1) {
            signal?.throwIfAborted();
            if (cluster % WII_VERIFY_YIELD_CLUSTER_INTERVAL === 0) {
                await scheduler.yield();
            }
            const raw = await reader.read(
                partition.offset +
                    header.dataOffset +
                    cluster * WII_CLUSTER_SIZE,
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
        if (signal?.aborted) {
            throw error;
        }
        return {
            index,
            type: partition.type,
            offset: partition.offset,
            clusters: 0,
            skippedClusters: 0,
            failedClusters: 0,
            status: 'failed',
            error: formatLogError(error),
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
    header: WiiPartitionHeader,
    h3: Buffer
): Promise<void> {
    if (header.tmdSize === 0 || header.tmdSize > 0x100000) {
        throw new Error('Invalid Wii partition TMD size');
    }
    const tmd = await reader.read(
        partitionOffset + header.tmdOffset,
        header.tmdSize
    );
    const payloadOffset = getSignedPayloadOffset(tmd);
    const contentCount = tmd.readUInt16BE(payloadOffset + 0x9e);
    if (contentCount === 0) {
        throw new Error('Wii partition TMD has no content');
    }
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
