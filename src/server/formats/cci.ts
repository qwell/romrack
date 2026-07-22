export type CciPartition = {
    offset: number;
    size: number;
};

export type CciHeader = {
    mediaSize: number;
    partitions: CciPartition[];
};

const CCI_HEADER_OFFSET = 0x100;
const CCI_MAGIC = 'NCSD';
const CCI_MEDIA_SIZE_OFFSET = 0x104;
const CCI_PARTITION_TABLE_OFFSET = 0x120;
const CCI_PARTITION_COUNT = 8;
const CCI_PARTITION_ENTRY_SIZE = 8;
const CCI_MEDIA_UNIT_SIZE = 0x200;

export function readCciHeader(header: Buffer): CciHeader | null {
    if (
        header.length <
            CCI_PARTITION_TABLE_OFFSET +
                CCI_PARTITION_COUNT * CCI_PARTITION_ENTRY_SIZE ||
        readAscii(header, CCI_HEADER_OFFSET, CCI_MAGIC.length) !== CCI_MAGIC
    ) {
        return null;
    }

    const mediaSize =
        header.readUInt32LE(CCI_MEDIA_SIZE_OFFSET) * CCI_MEDIA_UNIT_SIZE;
    if (mediaSize < CCI_MEDIA_UNIT_SIZE) {
        return null;
    }

    const partitions: CciPartition[] = [];
    for (let index = 0; index < CCI_PARTITION_COUNT; index += 1) {
        const entryOffset =
            CCI_PARTITION_TABLE_OFFSET + index * CCI_PARTITION_ENTRY_SIZE;
        const offsetMediaUnits = header.readUInt32LE(entryOffset);
        const sizeMediaUnits = header.readUInt32LE(entryOffset + 4);
        if (offsetMediaUnits === 0 && sizeMediaUnits === 0) {
            continue;
        }
        if (offsetMediaUnits === 0 || sizeMediaUnits === 0) {
            return null;
        }

        partitions.push({
            offset: offsetMediaUnits * CCI_MEDIA_UNIT_SIZE,
            size: sizeMediaUnits * CCI_MEDIA_UNIT_SIZE,
        });
    }

    return { mediaSize, partitions };
}

export function readCciPartitions(header: Buffer): CciPartition[] | null {
    return readCciHeader(header)?.partitions ?? null;
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
    return buffer
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
}
