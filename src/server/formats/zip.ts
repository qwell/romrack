import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

export type ZipCentralDirectoryEntry = {
    filename: string;
    compressedSize: number;
    compressionMethod: number;
    localHeaderOffset: number;
};

export const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_COMMENT_SIZE = 0xffff;
export const ZIP_EOCD_SEARCH_SIZE =
    ZIP_EOCD_MIN_SIZE + ZIP_EOCD_MAX_COMMENT_SIZE;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const ZIP_LOCAL_FILE_HEADER_SIZE = 30;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_COMPRESSION_STORED = 0;
const ZIP_COMPRESSION_DEFLATED = 8;
const ZIP_EOCD_DIRECTORY_SIZE_OFFSET = 12;
const ZIP_EOCD_DIRECTORY_OFFSET_OFFSET = 16;
const ZIP_EOCD_COMMENT_LENGTH_OFFSET = 20;
const ZIP_CENTRAL_COMPRESSION_METHOD_OFFSET = 10;
const ZIP_CENTRAL_COMPRESSED_SIZE_OFFSET = 20;
const ZIP_CENTRAL_FILENAME_LENGTH_OFFSET = 28;
const ZIP_CENTRAL_EXTRA_LENGTH_OFFSET = 30;
const ZIP_CENTRAL_COMMENT_LENGTH_OFFSET = 32;
const ZIP_CENTRAL_LOCAL_HEADER_OFFSET = 42;
const ZIP_CENTRAL_FILENAME_OFFSET = ZIP_CENTRAL_DIRECTORY_HEADER_SIZE;
const ZIP_LOCAL_FILENAME_LENGTH_OFFSET = 26;
const ZIP_LOCAL_EXTRA_LENGTH_OFFSET = 28;

export type ZipRangeReader = (start: number, end: number) => Promise<Buffer>;

const inflateRawAsync = promisify(inflateRaw);

function findZipEndOfCentralDirectory(buffer: Buffer): number {
    for (
        let offset = buffer.length - ZIP_EOCD_MIN_SIZE;
        offset >= 0;
        offset -= 1
    ) {
        if (
            buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE &&
            offset +
                ZIP_EOCD_MIN_SIZE +
                buffer.readUInt16LE(offset + ZIP_EOCD_COMMENT_LENGTH_OFFSET) ===
                buffer.length
        ) {
            return offset;
        }
    }

    return -1;
}

export async function readZipCentralDirectory(
    fileSize: number,
    readRange: ZipRangeReader,
    label: string
): Promise<Buffer> {
    if (!Number.isSafeInteger(fileSize) || fileSize < ZIP_EOCD_MIN_SIZE) {
        throw new Error(`ZIP archive size was invalid: ${label}`);
    }

    const tailStart = Math.max(0, fileSize - ZIP_EOCD_SEARCH_SIZE);
    const tail = await readRange(tailStart, fileSize - 1);
    const eocdOffset = findZipEndOfCentralDirectory(tail);
    if (eocdOffset < 0) {
        throw new Error(
            `ZIP archive central directory was not found: ${label}`
        );
    }

    const directorySize = tail.readUInt32LE(
        eocdOffset + ZIP_EOCD_DIRECTORY_SIZE_OFFSET
    );
    const directoryOffset = tail.readUInt32LE(
        eocdOffset + ZIP_EOCD_DIRECTORY_OFFSET_OFFSET
    );
    const directoryEnd = directoryOffset + directorySize - 1;
    if (
        !Number.isSafeInteger(directoryEnd) ||
        directoryOffset > fileSize ||
        directorySize > fileSize - directoryOffset
    ) {
        throw new Error(`ZIP archive central directory was invalid: ${label}`);
    }

    if (directorySize === 0) {
        return Buffer.alloc(0);
    }
    return directoryOffset >= tailStart && directoryEnd < fileSize
        ? tail.subarray(
              directoryOffset - tailStart,
              directoryOffset - tailStart + directorySize
          )
        : readRange(directoryOffset, directoryEnd);
}

export function readZipCentralDirectoryEntries(
    directory: Buffer
): ZipCentralDirectoryEntry[] {
    const entries: ZipCentralDirectoryEntry[] = [];
    let offset = 0;

    while (
        offset + ZIP_CENTRAL_DIRECTORY_HEADER_SIZE <= directory.length &&
        directory.readUInt32LE(offset) === ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
        const compressionMethod = directory.readUInt16LE(
            offset + ZIP_CENTRAL_COMPRESSION_METHOD_OFFSET
        );
        const compressedSize = directory.readUInt32LE(
            offset + ZIP_CENTRAL_COMPRESSED_SIZE_OFFSET
        );
        const filenameLength = directory.readUInt16LE(
            offset + ZIP_CENTRAL_FILENAME_LENGTH_OFFSET
        );
        const extraLength = directory.readUInt16LE(
            offset + ZIP_CENTRAL_EXTRA_LENGTH_OFFSET
        );
        const commentLength = directory.readUInt16LE(
            offset + ZIP_CENTRAL_COMMENT_LENGTH_OFFSET
        );
        const localHeaderOffset = directory.readUInt32LE(
            offset + ZIP_CENTRAL_LOCAL_HEADER_OFFSET
        );
        const filenameStart = offset + ZIP_CENTRAL_FILENAME_OFFSET;
        const filenameEnd = filenameStart + filenameLength;
        const entryEnd = filenameEnd + extraLength + commentLength;

        if (entryEnd > directory.length) {
            break;
        }

        entries.push({
            filename: directory
                .subarray(filenameStart, filenameEnd)
                .toString('utf8'),
            compressedSize,
            compressionMethod,
            localHeaderOffset,
        });
        offset = entryEnd;
    }

    return entries;
}

export function readZipEntryDataLocation(
    header: Buffer,
    entry: ZipCentralDirectoryEntry
): { offset: number; length: number } {
    if (
        header.length < ZIP_LOCAL_FILE_HEADER_SIZE ||
        header.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
    ) {
        throw new Error(
            `ZIP archive entry header was invalid: ${entry.filename}`
        );
    }

    const filenameLength = header.readUInt16LE(
        ZIP_LOCAL_FILENAME_LENGTH_OFFSET
    );
    const extraLength = header.readUInt16LE(ZIP_LOCAL_EXTRA_LENGTH_OFFSET);
    return {
        offset:
            entry.localHeaderOffset +
            ZIP_LOCAL_FILE_HEADER_SIZE +
            filenameLength +
            extraLength,
        length: entry.compressedSize,
    };
}

export async function decompressZipEntry(
    compressed: Buffer,
    entry: ZipCentralDirectoryEntry
): Promise<Buffer> {
    if (compressed.length !== entry.compressedSize) {
        throw new Error(
            `ZIP archive entry data was truncated: ${entry.filename}`
        );
    }

    if (entry.compressionMethod === ZIP_COMPRESSION_STORED) {
        return compressed;
    }

    if (entry.compressionMethod === ZIP_COMPRESSION_DEFLATED) {
        return inflateRawAsync(compressed);
    }

    throw new Error(
        `ZIP archive entry compression is unsupported (${entry.compressionMethod.toString()}): ${entry.filename}`
    );
}
