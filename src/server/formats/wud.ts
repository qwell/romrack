import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type WuxInfo = {
    sectorSize: number;
    uncompressedSize: bigint;
    offsetSectorArray: bigint;
    indexTable: number[];
};

export type WudImage = {
    filePath: string;
    file: FileHandle;
    compressed: WuxInfo | null;
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

const WUX_HEADER_SIZE = 0x20;
const WUX_MAGIC_0 = 0x30585557;
const WUX_MAGIC_1 = 0x1099d02e;
const WUX_SECTOR_SIZE_OFFSET = 0x08;
const WUX_UNCOMPRESSED_SIZE_OFFSET = 0x10;
const WUX_INDEX_TABLE_ENTRY_SIZE = 0x04;

export function isWudImagePath(filePath: string): boolean {
    return WUD_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function openWudImage(filePath: string): Promise<WudImage> {
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

export async function readWudImageRange(
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
