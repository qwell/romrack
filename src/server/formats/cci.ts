export type CciPartition = {
    offset: number;
    size: number;
};

const CCI_HEADER_OFFSET = 0x100;
const CCI_MAGIC = 'NCSD';
const CCI_PARTITION_TABLE_OFFSET = 0x120;
const CCI_PARTITION_COUNT = 8;
const CCI_PARTITION_ENTRY_SIZE = 8;
const CCI_MEDIA_UNIT_SIZE = 0x200;

export function readCciPartitions(header: Buffer): CciPartition[] | null {
    if (
        header.length <
            CCI_PARTITION_TABLE_OFFSET +
                CCI_PARTITION_COUNT * CCI_PARTITION_ENTRY_SIZE ||
        readAscii(header, CCI_HEADER_OFFSET, CCI_MAGIC.length) !== CCI_MAGIC
    ) {
        return null;
    }

    const partitions: CciPartition[] = [];
    for (let index = 0; index < CCI_PARTITION_COUNT; index += 1) {
        const entryOffset =
            CCI_PARTITION_TABLE_OFFSET + index * CCI_PARTITION_ENTRY_SIZE;
        const offsetMediaUnits = header.readUInt32LE(entryOffset);
        const sizeMediaUnits = header.readUInt32LE(entryOffset + 4);
        if (offsetMediaUnits === 0) {
            continue;
        }

        partitions.push({
            offset: offsetMediaUnits * CCI_MEDIA_UNIT_SIZE,
            size: sizeMediaUnits * CCI_MEDIA_UNIT_SIZE,
        });
    }

    return partitions;
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
    return buffer
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
}
