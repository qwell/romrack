import { createCipheriv, createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

import { type RandomAccessReader } from './disc.js';

const RVZ_MAGIC = Buffer.from([0x52, 0x56, 0x5a, 0x01]);
const HEADER_1_SIZE = 0x48;
const HEADER_2_MIN_SIZE = 0xd5;
const DISC_HEADER_OFFSET = 0x10;
const DISC_HEADER_SIZE = 0x80;
const PARTITION_ENTRY_SIZE = 0x30;
const RAW_ENTRY_SIZE = 0x18;
const GROUP_ENTRY_SIZE = 0x0c;
const WII_SECTOR_SIZE = 0x8000;
const WII_HASH_SIZE = 0x400;
const WII_DATA_SIZE = 0x7c00;
const WII_GROUP_SECTORS = 64;
const WII_GROUP_SIZE = WII_SECTOR_SIZE * WII_GROUP_SECTORS;
const WII_GROUP_DATA_SIZE = WII_DATA_SIZE * WII_GROUP_SECTORS;

const COMPRESSION_NONE = 0;
const COMPRESSION_ZSTD = 5;
type CompressionType = typeof COMPRESSION_NONE | typeof COMPRESSION_ZSTD;

export type RvzCheck = {
    ok: boolean;
    message: string;
};

export type RvzHeader = {
    discHeader: Buffer;
    isoSize: number;
    compressionType: CompressionType;
    chunkSize: number;
};

export type RvzInspection = {
    header: RvzHeader | null;
    checks: RvzCheck[];
};

type PartitionDataEntry = {
    firstSector: number;
    numberOfSectors: number;
    groupIndex: number;
    numberOfGroups: number;
};

type PartitionEntry = {
    key: Buffer;
    data: [PartitionDataEntry, PartitionDataEntry];
};

type RawDataEntry = {
    offset: number;
    size: number;
    groupIndex: number;
    numberOfGroups: number;
};

type GroupEntry = {
    fileOffset: number;
    dataSize: number;
    compressed: boolean;
    packedSize: number;
};

type ParsedRvz = {
    header: RvzHeader;
    partitions: PartitionEntry[];
    rawEntries: RawDataEntry[];
    groups: GroupEntry[];
};

type HashException = { offset: number; hash: Buffer };

type DecodedGroup = { data: Buffer; exceptions: HashException[][] };

function sha1(buffer: Buffer): Buffer {
    return createHash('sha1').update(buffer).digest();
}

async function readExact(
    reader: RandomAccessReader,
    position: number,
    length: number
): Promise<Buffer | null> {
    const buffer = await reader.read(position, length);
    return buffer.length === length ? buffer : null;
}

function toSafeNumber(value: bigint): number | null {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function rangeIsValid(offset: number | null, size: number, fileSize: number) {
    return (
        offset !== null &&
        offset >= 0 &&
        size >= 0 &&
        offset <= fileSize &&
        size <= fileSize - offset
    );
}

function decompress(data: Buffer, compressionType: CompressionType): Buffer {
    switch (compressionType) {
        case COMPRESSION_NONE:
            return data;
        case COMPRESSION_ZSTD:
            return zstdDecompressSync(data);
    }
}

async function parseRvz(
    reader: RandomAccessReader,
    fileSize: number
): Promise<{ parsed: ParsedRvz | null; inspection: RvzInspection }> {
    const header1 = await readExact(reader, 0, HEADER_1_SIZE);
    const magicValid = header1?.subarray(0, 4).equals(RVZ_MAGIC) === true;

    const checks: RvzCheck[] = [
        { ok: magicValid, message: 'RVZ magic is valid' },
    ];

    if (!header1 || !magicValid) {
        return { parsed: null, inspection: { header: null, checks } };
    }

    const fileVersion = header1.readUInt32BE(0x04);
    const compatibleVersion = header1.readUInt32BE(0x08);
    const versionSupported =
        compatibleVersion <= 0x01000000 && fileVersion >= 0x00030000;
    checks.push({
        ok: versionSupported,
        message: 'RVZ format version is supported',
    });

    checks.push({
        ok: sha1(header1.subarray(0, 0x34)).equals(
            header1.subarray(0x34, 0x48)
        ),
        message: 'RVZ primary header hash is valid',
    });

    const header2Size = header1.readUInt32BE(0x0c);
    const header2SizeValid =
        header2Size >= HEADER_2_MIN_SIZE &&
        header2Size <= fileSize - HEADER_1_SIZE;

    checks.push({
        ok: header2SizeValid,
        message: 'RVZ secondary header size is valid',
    });

    if (!header2SizeValid) {
        return { parsed: null, inspection: { header: null, checks } };
    }

    const header2 = await readExact(reader, HEADER_1_SIZE, header2Size);
    if (!header2) {
        checks.push({ ok: false, message: 'RVZ secondary header is readable' });
        return { parsed: null, inspection: { header: null, checks } };
    }

    checks.push({
        ok: sha1(header2).equals(header1.subarray(0x10, 0x24)),
        message: 'RVZ secondary header hash is valid',
    });

    const declaredFileSize = toSafeNumber(header1.readBigUInt64BE(0x2c));
    checks.push({
        ok: declaredFileSize === fileSize,
        message: 'RVZ declared file size matches the file',
    });

    const isoSize = toSafeNumber(header1.readBigUInt64BE(0x24));

    const compressionValue = header2.readUInt32BE(0x04);

    const chunkSize = header2.readUInt32BE(0x0c);
    const chunkSizeValid =
        chunkSize >= WII_SECTOR_SIZE &&
        (chunkSize < WII_GROUP_SIZE
            ? (chunkSize & (chunkSize - 1)) === 0
            : chunkSize % WII_GROUP_SIZE === 0);

    checks.push({ ok: chunkSizeValid, message: 'RVZ chunk size is valid' });

    const compressionSupported =
        compressionValue === COMPRESSION_NONE ||
        compressionValue === COMPRESSION_ZSTD;

    checks.push({
        ok: compressionSupported,
        message: 'RVZ compression method is supported',
    });

    if (isoSize === null || !chunkSizeValid || !compressionSupported) {
        return { parsed: null, inspection: { header: null, checks } };
    }

    const compressionType: CompressionType = compressionValue;
    const header: RvzHeader = {
        discHeader: Buffer.from(
            header2.subarray(
                DISC_HEADER_OFFSET,
                DISC_HEADER_OFFSET + DISC_HEADER_SIZE
            )
        ),
        isoSize,
        compressionType,
        chunkSize,
    };

    const partitionCount = header2.readUInt32BE(0x90);
    const partitionEntrySize = header2.readUInt32BE(0x94);
    const partitionOffset = toSafeNumber(header2.readBigUInt64BE(0x98));
    const partitionBytes = partitionCount * partitionEntrySize;
    const partitionRangeValid =
        Number.isSafeInteger(partitionBytes) &&
        (partitionCount === 0 || partitionEntrySize >= PARTITION_ENTRY_SIZE) &&
        rangeIsValid(partitionOffset, partitionBytes, fileSize);

    checks.push({
        ok: partitionRangeValid,
        message: 'RVZ partition table range is valid',
    });

    let partitionBytesBuffer: Buffer | null = null;
    if (partitionRangeValid && partitionOffset !== null) {
        partitionBytesBuffer = await readExact(
            reader,
            partitionOffset,
            partitionBytes
        );

        checks.push({
            ok:
                partitionBytesBuffer !== null &&
                sha1(partitionBytesBuffer).equals(header2.subarray(0xa0, 0xb4)),
            message: 'RVZ partition table hash is valid',
        });
    }

    const rawCount = header2.readUInt32BE(0xb4);
    const rawTableOffset = toSafeNumber(header2.readBigUInt64BE(0xb8));
    const rawTableSize = header2.readUInt32BE(0xc0);
    const rawRangeValid = rangeIsValid(rawTableOffset, rawTableSize, fileSize);
    checks.push({
        ok: rawRangeValid,
        message: 'RVZ raw-data table range is valid',
    });

    const groupCount = header2.readUInt32BE(0xc4);
    const groupTableOffset = toSafeNumber(header2.readBigUInt64BE(0xc8));
    const groupTableSize = header2.readUInt32BE(0xd0);
    const groupRangeValid = rangeIsValid(
        groupTableOffset,
        groupTableSize,
        fileSize
    );

    checks.push({
        ok: groupRangeValid,
        message: 'RVZ group table range is valid',
    });

    if (
        !partitionBytesBuffer ||
        rawTableOffset === null ||
        !rawRangeValid ||
        groupTableOffset === null ||
        !groupRangeValid ||
        checks.some((check) => !check.ok)
    ) {
        return { parsed: null, inspection: { header, checks } };
    }

    const rawCompressed = await readExact(reader, rawTableOffset, rawTableSize);
    const groupCompressed = await readExact(
        reader,
        groupTableOffset,
        groupTableSize
    );

    let rawTable: Buffer | null = null;
    let groupTable: Buffer | null = null;
    try {
        rawTable = rawCompressed
            ? decompress(rawCompressed, compressionType)
            : null;
        groupTable = groupCompressed
            ? decompress(groupCompressed, compressionType)
            : null;
    } catch {
        // The checks below report malformed compressed tables.
    }

    const rawTableValid = rawTable?.length === rawCount * RAW_ENTRY_SIZE;
    checks.push({
        ok: rawTableValid,
        message: 'RVZ raw-data table decompresses to its declared size',
    });

    const groupTableValid =
        groupTable?.length === groupCount * GROUP_ENTRY_SIZE;
    checks.push({
        ok: groupTableValid,
        message: 'RVZ group table decompresses to its declared size',
    });

    if (!rawTable || !groupTable || !rawTableValid || !groupTableValid) {
        return { parsed: null, inspection: { header, checks } };
    }

    const partitions: PartitionEntry[] = [];
    for (let index = 0; index < partitionCount; index += 1) {
        const entry = partitionBytesBuffer.subarray(
            index * partitionEntrySize,
            index * partitionEntrySize + PARTITION_ENTRY_SIZE
        );

        partitions.push({
            key: Buffer.from(entry.subarray(0, 16)),
            data: [
                readPartitionData(entry, 0x10),
                readPartitionData(entry, 0x20),
            ],
        });
    }

    const rawEntries: RawDataEntry[] = [];

    for (let index = 0; index < rawCount; index += 1) {
        const offset = index * RAW_ENTRY_SIZE;
        const dataOffset = toSafeNumber(rawTable.readBigUInt64BE(offset));
        const size = toSafeNumber(rawTable.readBigUInt64BE(offset + 8));

        if (dataOffset === null || size === null) {
            throw new Error('RVZ raw-data range exceeds supported size');
        }

        rawEntries.push({
            offset: dataOffset,
            size,
            groupIndex: rawTable.readUInt32BE(offset + 16),
            numberOfGroups: rawTable.readUInt32BE(offset + 20),
        });
    }

    const groups: GroupEntry[] = [];
    for (let index = 0; index < groupCount; index += 1) {
        const offset = index * GROUP_ENTRY_SIZE;
        const sizeField = groupTable.readUInt32BE(offset + 4);
        groups.push({
            fileOffset: groupTable.readUInt32BE(offset) * 4,
            dataSize: sizeField & 0x7fffffff,
            compressed: (sizeField & 0x80000000) !== 0,
            packedSize: groupTable.readUInt32BE(offset + 8),
        });
    }

    const groupRangesValid = groups.every(
        (group) =>
            group.dataSize === 0 ||
            rangeIsValid(group.fileOffset, group.dataSize, fileSize)
    );

    checks.push({
        ok: groupRangesValid,
        message: 'RVZ compressed group ranges are valid',
    });

    if (!groupRangesValid) {
        return { parsed: null, inspection: { header, checks } };
    }

    const referencesValid = [
        ...rawEntries.map((entry) => ({
            start: entry.groupIndex,
            count: entry.numberOfGroups,
        })),
        ...partitions.flatMap((partition) =>
            partition.data.map((entry) => ({
                start: entry.groupIndex,
                count: entry.numberOfGroups,
            }))
        ),
    ].every(
        (reference) =>
            reference.start <= groups.length &&
            reference.count <= groups.length - reference.start
    );

    checks.push({
        ok: referencesValid,
        message: 'RVZ group references are within the group table',
    });

    const logicalRanges = [
        ...rawEntries.map((entry) => ({
            start: entry.offset,
            end: entry.offset + entry.size,
        })),
        ...partitions.flatMap((partition) =>
            partition.data
                .filter((entry) => entry.numberOfSectors > 0)
                .map((entry) => ({
                    start: entry.firstSector * WII_SECTOR_SIZE,
                    end:
                        (entry.firstSector + entry.numberOfSectors) *
                        WII_SECTOR_SIZE,
                }))
        ),
    ].sort((a, b) => a.start - b.start);

    let logicalCursor = DISC_HEADER_SIZE;

    const logicalCoverageValid = logicalRanges.every((range) => {
        const valid =
            range.start === logicalCursor &&
            range.end >= range.start &&
            range.end <= isoSize;
        logicalCursor = range.end;
        return valid;
    });

    checks.push({
        ok: logicalCoverageValid && logicalCursor === isoSize,
        message: 'RVZ mappings cover the logical disc without gaps or overlaps',
    });

    if (
        !referencesValid ||
        !logicalCoverageValid ||
        logicalCursor !== isoSize
    ) {
        return { parsed: null, inspection: { header, checks } };
    }

    return {
        parsed: { header, partitions, rawEntries, groups },
        inspection: { header, checks },
    };
}

function readPartitionData(buffer: Buffer, offset: number): PartitionDataEntry {
    return {
        firstSector: buffer.readUInt32BE(offset),
        numberOfSectors: buffer.readUInt32BE(offset + 4),
        groupIndex: buffer.readUInt32BE(offset + 8),
        numberOfGroups: buffer.readUInt32BE(offset + 12),
    };
}

export async function inspectRvz(
    reader: RandomAccessReader,
    fileSize: number
): Promise<RvzInspection> {
    return (await parseRvz(reader, fileSize)).inspection;
}

export async function openRvzReader(
    physical: RandomAccessReader,
    fileSize: number
): Promise<{ reader: RandomAccessReader; inspection: RvzInspection }> {
    const { parsed, inspection } = await parseRvz(physical, fileSize);
    if (!parsed) {
        throw new Error('Invalid or unsupported RVZ image');
    }

    const decodedGroups = new Map<number, Promise<DecodedGroup>>();
    const encryptedGroups = new Map<string, Promise<Buffer>>();
    const readGroup = (
        index: number,
        outputSize: number,
        exceptionLists: number,
        dataOffset: number
    ) => {
        let pending = decodedGroups.get(index);
        if (!pending) {
            pending = decodeGroup(
                physical,
                parsed,
                index,
                outputSize,
                exceptionLists,
                dataOffset
            );
            decodedGroups.set(index, pending);
            trimCache(decodedGroups, 64);
        } else {
            decodedGroups.delete(index);
            decodedGroups.set(index, pending);
        }

        return pending;
    };

    const logical: RandomAccessReader = {
        read: async (position, length) => {
            if (
                !Number.isSafeInteger(position) ||
                !Number.isSafeInteger(length) ||
                position < 0 ||
                length < 0 ||
                position + length > parsed.header.isoSize
            ) {
                throw new Error('RVZ read is outside the logical disc image');
            }

            const output = Buffer.alloc(length);

            let outputOffset = 0;
            while (outputOffset < length) {
                const logicalPosition = position + outputOffset;
                if (logicalPosition < DISC_HEADER_SIZE) {
                    const size = Math.min(
                        length - outputOffset,
                        DISC_HEADER_SIZE - logicalPosition
                    );
                    parsed.header.discHeader.copy(
                        output,
                        outputOffset,
                        logicalPosition,
                        logicalPosition + size
                    );

                    outputOffset += size;
                    continue;
                }

                const partition = findPartition(
                    parsed.partitions,
                    logicalPosition
                );
                if (partition) {
                    const groupStart =
                        Math.floor(
                            partition.relativeSector / WII_GROUP_SECTORS
                        ) * WII_GROUP_SECTORS;

                    const cacheKey = `${partition.index}:${groupStart}`;

                    let pending = encryptedGroups.get(cacheKey);
                    if (!pending) {
                        pending = reconstructWiiGroup(
                            parsed,
                            readGroup,
                            partition.index,
                            groupStart
                        );
                        encryptedGroups.set(cacheKey, pending);
                        trimCache(encryptedGroups, 2);
                    } else {
                        encryptedGroups.delete(cacheKey);
                        encryptedGroups.set(cacheKey, pending);
                    }

                    const group = await pending;
                    const offsetInGroup =
                        (partition.relativeSector - groupStart) *
                            WII_SECTOR_SIZE +
                        (logicalPosition % WII_SECTOR_SIZE);

                    const size = Math.min(
                        length - outputOffset,
                        group.length - offsetInGroup
                    );

                    group.copy(
                        output,
                        outputOffset,
                        offsetInGroup,
                        offsetInGroup + size
                    );

                    outputOffset += size;
                    continue;
                }

                const raw = findRawEntry(parsed.rawEntries, logicalPosition);
                if (!raw) {
                    throw new Error('RVZ logical range is not mapped');
                }

                const skippedData = raw.offset % WII_SECTOR_SIZE;

                const alignedOffset = raw.offset - skippedData;
                const alignedSize = raw.size + skippedData;

                const groupInEntry = Math.floor(
                    (logicalPosition - alignedOffset) / parsed.header.chunkSize
                );
                if (groupInEntry >= raw.numberOfGroups) {
                    throw new Error('RVZ raw-data group index is invalid');
                }

                const groupOffset = groupInEntry * parsed.header.chunkSize;
                const groupSize = Math.min(
                    parsed.header.chunkSize,
                    alignedSize - groupOffset
                );
                const offsetInGroup =
                    logicalPosition - alignedOffset - groupOffset;

                const decoded = await readGroup(
                    raw.groupIndex + groupInEntry,
                    groupSize,
                    0,
                    groupOffset
                );

                const size = Math.min(
                    length - outputOffset,
                    decoded.data.length - offsetInGroup,
                    raw.offset + raw.size - logicalPosition
                );

                decoded.data.copy(
                    output,
                    outputOffset,
                    offsetInGroup,
                    offsetInGroup + size
                );
                outputOffset += size;
            }

            return output;
        },
        close: () => physical.close(),
    };

    return { reader: logical, inspection };
}

function trimCache<Key, Value>(cache: Map<Key, Value>, maximum: number): void {
    while (cache.size > maximum) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            return;
        }

        cache.delete(oldest);
    }
}

function findRawEntry(entries: RawDataEntry[], position: number) {
    return entries.find(
        (entry) =>
            position >= entry.offset && position < entry.offset + entry.size
    );
}

function findPartition(entries: PartitionEntry[], position: number) {
    for (const [index, entry] of entries.entries()) {
        const firstSector = entry.data[0].firstSector;

        for (const data of entry.data) {
            if (
                position >= data.firstSector * WII_SECTOR_SIZE &&
                position <
                    (data.firstSector + data.numberOfSectors) * WII_SECTOR_SIZE
            ) {
                return {
                    index,
                    relativeSector:
                        Math.floor(position / WII_SECTOR_SIZE) - firstSector,
                };
            }
        }
    }
    return null;
}

async function decodeGroup(
    physical: RandomAccessReader,
    parsed: ParsedRvz,
    index: number,
    outputSize: number,
    exceptionLists: number,
    dataOffset: number
): Promise<DecodedGroup> {
    const group = parsed.groups[index];
    if (!group) {
        throw new Error('RVZ group index is outside the group table');
    }

    if (group.dataSize === 0) {
        return {
            data: Buffer.alloc(outputSize),
            exceptions: Array.from({ length: exceptionLists }, () => []),
        };
    }

    const stored = await physical.read(group.fileOffset, group.dataSize);
    if (stored.length !== group.dataSize) {
        throw new Error('Unexpected end of RVZ group data');
    }

    const decoded = group.compressed
        ? decompress(stored, parsed.header.compressionType)
        : stored;
    const exceptions: HashException[][] = [];

    let offset = 0;

    for (let list = 0; list < exceptionLists; list += 1) {
        if (offset + 2 > decoded.length) {
            throw new Error('Invalid RVZ hash exception list');
        }

        const values: HashException[] = [];

        const count = decoded.readUInt16BE(offset);
        offset += 2;

        for (let index = 0; index < count; index += 1) {
            if (offset + 22 > decoded.length) {
                throw new Error('Invalid RVZ hash exception entry');
            }
            values.push({
                offset: decoded.readUInt16BE(offset),
                hash: Buffer.from(decoded.subarray(offset + 2, offset + 22)),
            });
            offset += 22;
        }
        exceptions.push(values);
    }

    if (!group.compressed && exceptionLists > 0) {
        offset = (offset + 3) & ~3;
    }

    const encodedData = decoded.subarray(offset);
    const data =
        group.packedSize === 0
            ? Buffer.from(encodedData)
            : unpackRvz(encodedData, outputSize, dataOffset);

    if (data.length !== outputSize) {
        throw new Error(
            `RVZ group decoded to ${data.length} bytes; expected ${outputSize}`
        );
    }

    return { data, exceptions };
}

function unpackRvz(
    input: Buffer,
    outputSize: number,
    dataOffset: number
): Buffer {
    const output = Buffer.alloc(outputSize);

    let inputOffset = 0;
    let outputOffset = 0;

    while (inputOffset < input.length) {
        if (inputOffset + 4 > input.length) {
            throw new Error('Invalid RVZ packed segment header');
        }

        const sizeField = input.readUInt32BE(inputOffset);
        inputOffset += 4;
        const generated = (sizeField & 0x80000000) !== 0;
        const size = sizeField & 0x7fffffff;

        if (size > output.length - outputOffset) {
            throw new Error('RVZ packed segment exceeds its decoded group');
        }

        if (generated) {
            if (inputOffset + 68 > input.length) {
                throw new Error('Invalid RVZ pseudorandom seed');
            }

            fillRvzPseudorandomPadding(
                input.subarray(inputOffset, inputOffset + 68),
                output.subarray(outputOffset, outputOffset + size),
                (dataOffset + outputOffset) % WII_SECTOR_SIZE
            );

            inputOffset += 68;
        } else {
            if (inputOffset + size > input.length) {
                throw new Error('RVZ literal segment exceeds its input');
            }

            input.copy(output, outputOffset, inputOffset, inputOffset + size);
            inputOffset += size;
        }

        outputOffset += size;
    }

    if (outputOffset !== output.length) {
        throw new Error('RVZ packed data does not fill its decoded group');
    }

    return output;
}

function fillRvzPseudorandomPadding(
    seed: Buffer,
    output: Buffer,
    byteOffset: number
): void {
    const state = new Uint32Array(521);

    for (let index = 0; index < 17; index += 1) {
        state[index] = seed.readUInt32BE(index * 4);
    }

    for (let index = 17; index < state.length; index += 1) {
        state[index] =
            ((state[index - 17] << 23) ^
                (state[index - 16] >>> 9) ^
                state[index - 1]) >>>
            0;
    }

    for (let index = 0; index < 4; index += 1) {
        advanceRvzPseudorandomState(state);
    }

    let wordIndex = 0;
    let byteInWord = 0;

    const totalBytes = byteOffset + output.length;
    for (let position = 0; position < totalBytes; position += 1) {
        if (wordIndex === state.length) {
            advanceRvzPseudorandomState(state);
            wordIndex = 0;
        }

        const word = state[wordIndex];
        const value =
            byteInWord === 0
                ? word >>> 24
                : byteInWord === 1
                  ? word >>> 16
                  : byteInWord === 2
                    ? word >>> 8
                    : word;

        if (position >= byteOffset) {
            output[position - byteOffset] = value;
        }

        byteInWord += 1;
        if (byteInWord === 4) {
            byteInWord = 0;
            wordIndex += 1;
        }
    }
}

function advanceRvzPseudorandomState(state: Uint32Array): void {
    for (let index = 0; index < 32; index += 1) {
        state[index] = (state[index] ^ state[index + 489]) >>> 0;
    }

    for (let index = 32; index < state.length; index += 1) {
        state[index] = (state[index] ^ state[index - 32]) >>> 0;
    }
}

async function reconstructWiiGroup(
    parsed: ParsedRvz,
    readGroup: (
        index: number,
        outputSize: number,
        exceptionLists: number,
        dataOffset: number
    ) => Promise<DecodedGroup>,
    partitionIndex: number,
    firstRelativeSector: number
): Promise<Buffer> {
    const partition = parsed.partitions[partitionIndex];
    const partitionFirstSector = partition.data[0].firstSector;
    const totalSectors = Math.max(
        ...partition.data.map(
            (entry) =>
                entry.firstSector - partitionFirstSector + entry.numberOfSectors
        )
    );
    const sectors = Math.min(
        WII_GROUP_SECTORS,
        totalSectors - firstRelativeSector
    );

    const decrypted = Buffer.alloc(WII_GROUP_DATA_SIZE);
    const exceptions: HashException[] = [];

    for (const dataEntry of partition.data) {
        const entryRelative = dataEntry.firstSector - partitionFirstSector;
        const overlapStart = Math.max(firstRelativeSector, entryRelative);
        const overlapEnd = Math.min(
            firstRelativeSector + WII_GROUP_SECTORS,
            entryRelative + dataEntry.numberOfSectors
        );

        if (overlapStart >= overlapEnd) {
            continue;
        }

        const chunkDataSize =
            (parsed.header.chunkSize / WII_SECTOR_SIZE) * WII_DATA_SIZE;

        const firstByte = (overlapStart - entryRelative) * WII_DATA_SIZE;
        const lastByte = (overlapEnd - entryRelative) * WII_DATA_SIZE;
        const firstGroup = Math.floor(firstByte / chunkDataSize);
        const lastGroup = Math.ceil(lastByte / chunkDataSize);
        for (
            let groupInEntry = firstGroup;
            groupInEntry < lastGroup;
            groupInEntry += 1
        ) {
            if (groupInEntry >= dataEntry.numberOfGroups) {
                throw new Error('RVZ partition group index is invalid');
            }

            const groupDataOffset = groupInEntry * chunkDataSize;
            const groupSectors = Math.min(
                parsed.header.chunkSize / WII_SECTOR_SIZE,
                dataEntry.numberOfSectors -
                    Math.floor(groupDataOffset / WII_DATA_SIZE)
            );

            const decoded = await readGroup(
                dataEntry.groupIndex + groupInEntry,
                groupSectors * WII_DATA_SIZE,
                Math.max(1, parsed.header.chunkSize / WII_GROUP_SIZE),
                groupDataOffset
            );

            const groupRelativeSector =
                entryRelative + Math.floor(groupDataOffset / WII_DATA_SIZE);

            const copyStart = Math.max(
                firstRelativeSector,
                groupRelativeSector
            );
            const copyEnd = Math.min(
                firstRelativeSector + sectors,
                groupRelativeSector + groupSectors
            );
            decoded.data.copy(
                decrypted,
                (copyStart - firstRelativeSector) * WII_DATA_SIZE,
                (copyStart - groupRelativeSector) * WII_DATA_SIZE,
                (copyEnd - groupRelativeSector) * WII_DATA_SIZE
            );

            for (const [listIndex, list] of decoded.exceptions.entries()) {
                const listRelativeSector =
                    groupRelativeSector + listIndex * WII_GROUP_SECTORS;
                if (
                    listRelativeSector + WII_GROUP_SECTORS <=
                        firstRelativeSector ||
                    listRelativeSector >= firstRelativeSector + sectors
                ) {
                    continue;
                }

                const additionalOffset =
                    (listRelativeSector - firstRelativeSector) * WII_HASH_SIZE;
                for (const exception of list) {
                    const offset = exception.offset + additionalOffset;
                    if (
                        offset < 0 ||
                        offset + exception.hash.length > sectors * WII_HASH_SIZE
                    ) {
                        continue;
                    }

                    exceptions.push({
                        offset,
                        hash: exception.hash,
                    });
                }
            }
        }
    }
    const hashes = buildWiiHashes(decrypted);
    for (const exception of exceptions) {
        const sector = Math.floor(exception.offset / WII_HASH_SIZE);
        const offset = exception.offset % WII_HASH_SIZE;
        if (
            sector >= WII_GROUP_SECTORS ||
            offset + exception.hash.length > WII_HASH_SIZE
        ) {
            throw new Error('RVZ hash exception is outside its Wii hash group');
        }
        exception.hash.copy(hashes[sector], offset);
    }

    const output = Buffer.alloc(sectors * WII_SECTOR_SIZE);
    for (let sector = 0; sector < sectors; sector += 1) {
        const encryptedHashes = encryptAesCbc(
            hashes[sector],
            partition.key,
            Buffer.alloc(16)
        );
        const encryptedData = encryptAesCbc(
            decrypted.subarray(
                sector * WII_DATA_SIZE,
                (sector + 1) * WII_DATA_SIZE
            ),
            partition.key,
            encryptedHashes.subarray(0x3d0, 0x3e0)
        );
        encryptedHashes.copy(output, sector * WII_SECTOR_SIZE);
        encryptedData.copy(output, sector * WII_SECTOR_SIZE + WII_HASH_SIZE);
    }
    return output;
}

function buildWiiHashes(data: Buffer): Buffer[] {
    const hashes = Array.from({ length: WII_GROUP_SECTORS }, () =>
        Buffer.alloc(WII_HASH_SIZE)
    );

    for (let sector = 0; sector < WII_GROUP_SECTORS; sector += 1) {
        for (let block = 0; block < WII_DATA_SIZE / 0x400; block += 1) {
            sha1(
                data.subarray(
                    sector * WII_DATA_SIZE + block * 0x400,
                    sector * WII_DATA_SIZE + (block + 1) * 0x400
                )
            ).copy(hashes[sector], block * 20);
        }
    }

    for (let subgroup = 0; subgroup < 8; subgroup += 1) {
        const h1 = Buffer.alloc(8 * 20);
        for (let index = 0; index < 8; index += 1) {
            sha1(hashes[subgroup * 8 + index].subarray(0, 0x26c)).copy(
                h1,
                index * 20
            );
        }

        for (let index = 0; index < 8; index += 1) {
            h1.copy(hashes[subgroup * 8 + index], 0x280);
        }
    }

    const h2 = Buffer.alloc(8 * 20);
    for (let subgroup = 0; subgroup < 8; subgroup += 1) {
        sha1(hashes[subgroup * 8].subarray(0x280, 0x320)).copy(
            h2,
            subgroup * 20
        );
    }

    for (const hash of hashes) {
        h2.copy(hash, 0x340);
    }

    return hashes;
}

function encryptAesCbc(data: Buffer, key: Buffer, iv: Buffer): Buffer {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}
