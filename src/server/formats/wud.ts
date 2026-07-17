import { createDecipheriv } from 'node:crypto';

import { getEncryptedContentFileSize, isHashedContent } from './content.js';
import { findFstEntry, looksLikeFst, readFstContentInfos } from './fst.js';
import { type Tmd } from './tmd.js';

export type WuxInfo = {
    sectorSize: number;
    uncompressedSize: bigint;
    offsetSectorArray: bigint;
    indexTable: number[];
};

export type WudImage = {
    compressed: WuxInfo | null;
    read: (offset: bigint, size: number) => Promise<Buffer>;
};

export type WudPartitionReference = {
    name: string;
    offset: bigint;
};

export type WudDataPartition = {
    partitionOffset: bigint;
    headerSize: bigint;
    fst: Buffer;
};

export type WudGamePartition = {
    name: string;
    partitionOffset: bigint;
    header: Buffer;
    contentKey: Buffer;
    contentKeyPassword: string | null;
    rawTmd: Buffer;
    rawTicket: Buffer;
    rawCert: Buffer;
    tmd: Tmd;
    fst: Buffer;
    contentOffsets: Map<number, bigint>;
};

export const WUD_FILE_EXTENSIONS = new Set(['.wud', '.wux']);
export const WUD_DECRYPTED_AREA_OFFSET = 0x18000n;
export const WUD_SECTOR_SIZE = 0x8000;
export const WUD_CLUSTER_SIZE = 0x10000;

export const WUD_PARTITION_TOC_ENTRY_SIZE = 0x80;
export const WUD_PARTITION_TOC_OFFSET = 0x800;
export const WUD_PARTITION_TOC_COUNT_OFFSET = 0x1c;
export const WUD_PARTITION_TOC_NAME_SIZE = 0x19;
export const WUD_PARTITION_TOC_SECTOR_OFFSET = 0x20;
export const WUD_PARTITION_HEADER_META_SIZE = 0x20;
export const WUD_PARTITION_HEADER_SIZE_OFFSET = 0x04;
export const WUD_PARTITION_HEADER_FST_SIZE_OFFSET = 0x14;
export const WUD_PARTITION_HEADER_HASH_COUNT_OFFSET = 0x10;
export const WUD_PARTITION_HEADER_HASH_TABLE_OFFSET = 0x40;
export const WUD_PARTITION_HEADER_HASH_POINTER_SIZE = 0x04;
export const WUD_PARTITION_START_SIGNATURE = 0xcc93a4f5;
export const WUD_DECRYPTED_AREA_SIGNATURE = 0xcca6e67b;

export const WUD_H3_HASH_ENTRY_SIZE = 0x14;
export const WUD_H3_HASH_CLUSTER_SPAN = 0x1000;
export const WUD_AES_BLOCK_SIZE = 0x10;
export const WUD_IV_FILE_OFFSET_SHIFT = 16n;

export async function readWudImageRange(
    image: WudImage,
    offset: bigint,
    size: number | bigint
): Promise<Buffer> {
    const length = typeof size === 'bigint' ? Number(size) : size;

    if (!image.compressed) {
        return image.read(offset, length);
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

        const chunk = await image.read(
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

export function readWudPartitionReferences(
    data: Buffer
): WudPartitionReference[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < WUD_PARTITION_TOC_OFFSET) {
        return [];
    }

    const count = view.getUint32(WUD_PARTITION_TOC_COUNT_OFFSET);
    if (
        count >
        Math.floor(
            (data.length - WUD_PARTITION_TOC_OFFSET) /
                WUD_PARTITION_TOC_ENTRY_SIZE
        )
    ) {
        return [];
    }

    const partitions: WudPartitionReference[] = [];
    for (let index = 0; index < count; index += 1) {
        const offset =
            WUD_PARTITION_TOC_OFFSET + index * WUD_PARTITION_TOC_ENTRY_SIZE;
        const rawName = data.subarray(
            offset,
            offset + WUD_PARTITION_TOC_NAME_SIZE
        );
        const terminator = rawName.indexOf(0);
        const name = Buffer.from(
            terminator < 0 ? rawName : rawName.subarray(0, terminator)
        ).toString('ascii');
        const sector = view.getUint32(offset + WUD_PARTITION_TOC_SECTOR_OFFSET);
        partitions.push({
            name,
            offset: BigInt(sector) * BigInt(WUD_SECTOR_SIZE),
        });
    }

    return partitions;
}

export function getWudPartitionHeaderHashStart(data: Buffer): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(WUD_PARTITION_HEADER_HASH_COUNT_OFFSET);
    return (
        WUD_PARTITION_HEADER_HASH_TABLE_OFFSET +
        count * WUD_PARTITION_HEADER_HASH_POINTER_SIZE
    );
}

export async function readWudDataPartition(
    image: WudImage,
    partition: WudPartitionReference,
    discKey: Buffer
): Promise<WudDataPartition | null> {
    const headerMeta = await readWudImageRange(
        image,
        partition.offset,
        WUD_PARTITION_HEADER_META_SIZE
    );
    if (headerMeta.readUInt32BE(0) !== WUD_PARTITION_START_SIGNATURE) {
        return null;
    }

    const headerSize = BigInt(
        headerMeta.readUInt32BE(WUD_PARTITION_HEADER_SIZE_OFFSET)
    );
    const fstSize = headerMeta.readUInt32BE(
        WUD_PARTITION_HEADER_FST_SIZE_OFFSET
    );
    const fst = await readDecryptedWudRange(
        image,
        partition.offset + headerSize,
        0n,
        fstSize,
        discKey,
        null,
        true
    );
    return looksLikeFst(fst)
        ? { partitionOffset: partition.offset, headerSize, fst }
        : null;
}

export async function readWudGamePartition(
    image: WudImage,
    partition: WudPartitionReference,
    contentKey: Buffer,
    contentKeyPassword: string | null,
    rawTmd: Buffer,
    rawCert: Buffer,
    rawTicket: Buffer,
    tmd: Tmd
): Promise<WudGamePartition | null> {
    const headerMeta = await readWudImageRange(
        image,
        partition.offset,
        WUD_PARTITION_HEADER_META_SIZE
    );
    if (headerMeta.readUInt32BE(0) !== WUD_PARTITION_START_SIGNATURE) {
        return null;
    }

    const headerSize = BigInt(
        headerMeta.readUInt32BE(WUD_PARTITION_HEADER_SIZE_OFFSET)
    );
    const header = await readWudImageRange(
        image,
        partition.offset,
        Number(headerSize)
    );
    const partitionOffset = partition.offset + headerSize;
    const fstContent = tmd.contents[0];
    if (!fstContent) {
        return null;
    }
    const fst = await readDecryptedWudRange(
        image,
        partitionOffset,
        0n,
        Number(getEncryptedContentFileSize(fstContent)),
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
        contentOffsets: new Map(
            [...readFstContentInfos(fst)].map(([index, info]) => [
                index,
                info.offset,
            ])
        ),
    };
}

export async function readWudFstFile(
    image: WudImage,
    partition: WudDataPartition,
    fullPath: string,
    discKey: Buffer
): Promise<Buffer | null> {
    const entry = findFstEntry(partition.fst, fullPath);
    if (!entry) {
        return null;
    }

    const contentOffset =
        partition.headerSize +
        partition.partitionOffset +
        (readFstContentInfos(partition.fst).get(entry.contentId)?.offset ?? 0n);
    return readDecryptedWudRange(
        image,
        contentOffset,
        BigInt(entry.shiftedFileOffset),
        entry.fileLength,
        discKey,
        createWudFileOffsetIv(BigInt(entry.shiftedFileOffset)),
        false
    );
}

export function readWudPartitionH3(
    partition: WudGamePartition,
    contentIndex: number,
    encryptedSize: number
): Buffer {
    const hashedContents = partition.tmd.contents.filter(
        (content) => isHashedContent(content) && (content.type & 1) === 1
    );
    let hashOffset = 0;
    const hashStart = getWudPartitionHeaderHashStart(partition.header);
    for (const content of hashedContents) {
        const h3Size =
            (Math.floor(
                Number(getEncryptedContentFileSize(content)) /
                    WUD_CLUSTER_SIZE /
                    WUD_H3_HASH_CLUSTER_SPAN
            ) +
                1) *
            WUD_H3_HASH_ENTRY_SIZE;
        if (content.index === contentIndex) {
            return partition.header.subarray(
                hashStart + hashOffset,
                hashStart + hashOffset + h3Size
            );
        }
        hashOffset += h3Size;
    }

    throw new Error(
        `Missing H3 data for content ${contentIndex.toString()} (${encryptedSize.toString()} bytes)`
    );
}

export async function readDecryptedWudRange(
    image: WudImage,
    clusterOffset: bigint,
    fileOffset: bigint,
    size: number,
    key: Buffer,
    iv: Buffer | null,
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
            ? (iv ?? Buffer.alloc(WUD_AES_BLOCK_SIZE))
            : createWudFileOffsetIv(usedFileOffset);
        const decrypted = decryptWudContent(
            await readWudImageRange(image, readOffset, WUD_CLUSTER_SIZE),
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

export function decryptWudContent(
    encrypted: Buffer,
    key: Buffer,
    iv: Buffer
): Buffer {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([
        decipher.update(Buffer.from(encrypted)),
        decipher.final(),
    ]);
}

export function createWudContentIv(contentIndex: number): Buffer {
    const iv = Buffer.alloc(WUD_AES_BLOCK_SIZE);
    iv.writeUInt16BE(contentIndex, 0);
    return iv;
}

export function createWudFileOffsetIv(fileOffset: bigint): Buffer {
    const iv = Buffer.alloc(WUD_AES_BLOCK_SIZE);
    iv.writeBigUInt64BE(
        fileOffset >> WUD_IV_FILE_OFFSET_SHIFT,
        WUD_AES_BLOCK_SIZE / 2
    );
    return iv;
}
