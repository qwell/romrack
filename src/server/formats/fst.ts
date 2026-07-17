import {
    isNonEmptyString,
    readNullTerminatedString,
} from '../../shared/utils.js';
import { isHashedContent } from './content.js';
import { type Tmd } from './tmd.js';

export type FstEntry = {
    name: string;
    path: string;
    fullPath: string;
    isDirectory: boolean;
    contentId: number;
    fileOffset: number;
    shiftedFileOffset: number;
    fileLength: number;
};

export type TitleFstEntry = FstEntry & {
    extractWithHash: boolean;
};

export type FstContentInfo = {
    offset: bigint;
};

const FST_MAGIC = 'FST';
const FST_CONTENT_COUNT_OFFSET = 0x08;
const FST_CONTENT_INFO_OFFSET = 0x20;
const FST_CONTENT_INFO_SIZE = 0x20;
const FST_CONTENT_INFO_SECTOR_SIZE = 0x8000n;
const FST_ENTRY_SIZE = 0x10;
const FST_ENTRY_TYPE_DIRECTORY = 0x01;
const FST_ENTRY_NAME_OFFSET_MASK = 0x00ff_ffff;
const FST_CHANGE_OFFSET_FLAG = 0x0004;
const FST_SHIFTED_OFFSET_SHIFT = 5;
const FST_ROOT_NEXT_OFFSET = 8;
const FST_ENTRY_NAME_OFFSET = 0;
const FST_ENTRY_FILE_OFFSET = 4;
const FST_ENTRY_LENGTH_OFFSET = 8;
const FST_ENTRY_FLAGS_OFFSET = 12;
const FST_ENTRY_CONTENT_ID_OFFSET = 14;

export function looksLikeFst(value: Buffer | null): boolean {
    return (
        value !== null &&
        value.length >= FST_CONTENT_COUNT_OFFSET + 4 &&
        Buffer.from(value.subarray(0, FST_MAGIC.length)).toString('ascii') ===
            FST_MAGIC
    );
}

export function parseFstEntries(fst: Buffer): FstEntry[] {
    if (!looksLikeFst(fst)) {
        return [];
    }

    const buffer = Buffer.from(fst);
    const contentCount = readFstContentCount(buffer);
    const baseOffset =
        FST_CONTENT_INFO_OFFSET + contentCount * FST_CONTENT_INFO_SIZE;

    if (buffer.length < baseOffset + FST_ENTRY_SIZE) {
        return [];
    }

    const totalEntries = buffer.readUInt32BE(baseOffset + FST_ROOT_NEXT_OFFSET);
    const nameOffsetBase = baseOffset + totalEntries * FST_ENTRY_SIZE;
    if (
        !Number.isSafeInteger(nameOffsetBase) ||
        nameOffsetBase > buffer.length
    ) {
        return [];
    }
    const directoryStack: Array<{ name: string; nextOffset: number }> = [];
    const entries: FstEntry[] = [];

    for (let index = 0; index < totalEntries; index += 1) {
        while (
            directoryStack.length > 0 &&
            directoryStack[directoryStack.length - 1].nextOffset === index
        ) {
            directoryStack.pop();
        }

        const offset = baseOffset + index * FST_ENTRY_SIZE;
        if (offset + FST_ENTRY_SIZE > buffer.length) {
            break;
        }

        const type = buffer[offset];
        const isDirectory = (type & FST_ENTRY_TYPE_DIRECTORY) !== 0;
        const nameOffset =
            buffer.readUInt32BE(offset + FST_ENTRY_NAME_OFFSET) &
            FST_ENTRY_NAME_OFFSET_MASK;
        const name = readNullTerminatedString(
            buffer,
            nameOffsetBase + nameOffset
        );
        const fileOffset = buffer.readUInt32BE(offset + FST_ENTRY_FILE_OFFSET);
        const fileLength = buffer.readUInt32BE(
            offset + FST_ENTRY_LENGTH_OFFSET
        );
        const flags = buffer.readUInt16BE(offset + FST_ENTRY_FLAGS_OFFSET);
        const contentId = buffer.readUInt16BE(
            offset + FST_ENTRY_CONTENT_ID_OFFSET
        );
        const dirPath = directoryStack
            .map((entry) => entry.name)
            .filter(isNonEmptyString)
            .join('/');
        const fullPath = [dirPath, name].filter(isNonEmptyString).join('/');

        entries.push({
            name,
            path: dirPath,
            fullPath,
            isDirectory,
            contentId,
            fileOffset,
            shiftedFileOffset:
                (flags & FST_CHANGE_OFFSET_FLAG) === 0
                    ? fileOffset * 2 ** FST_SHIFTED_OFFSET_SHIFT
                    : fileOffset,
            fileLength,
        });

        if (isDirectory) {
            directoryStack.push({ name, nextOffset: fileLength });
        }
    }

    return entries;
}

export function parseTitleFstEntries(
    decryptedFst: Buffer,
    tmd: Tmd
): TitleFstEntry[] {
    return parseFstEntries(decryptedFst).map((entry) => {
        const content =
            tmd.contents.find(
                (candidate) => candidate.index === entry.contentId
            ) ?? tmd.contents[entry.contentId];

        return {
            ...entry,
            extractWithHash:
                content !== undefined &&
                content !== null &&
                isHashedContent(content),
        };
    });
}

export function findFstEntry(fst: Buffer, fullPath: string): FstEntry | null {
    return (
        parseFstEntries(fst).find((entry) => entry.fullPath === fullPath) ??
        null
    );
}

export function getRootDirectoryChildren(fst: Buffer): string[] {
    return parseFstEntries(fst)
        .filter(
            (entry) =>
                entry.path === '' &&
                entry.isDirectory &&
                isNonEmptyString(entry.name)
        )
        .map((entry) => entry.name);
}

export function readFstContentInfos(fst: Buffer): Map<number, FstContentInfo> {
    const buffer = Buffer.from(fst);
    if (!looksLikeFst(buffer)) {
        return new Map();
    }
    const count = readFstContentCount(buffer);
    const infos = new Map<number, FstContentInfo>();

    if (
        FST_CONTENT_INFO_OFFSET + count * FST_CONTENT_INFO_SIZE >
        buffer.length
    ) {
        return infos;
    }

    for (let index = 0; index < count; index += 1) {
        const offset = FST_CONTENT_INFO_OFFSET + index * FST_CONTENT_INFO_SIZE;
        const offsetSector = buffer.readUInt32BE(offset);
        const byteOffset =
            BigInt(offsetSector) * FST_CONTENT_INFO_SECTOR_SIZE -
            FST_CONTENT_INFO_SECTOR_SIZE;

        infos.set(index, {
            offset: byteOffset < 0n ? 0n : byteOffset,
        });
    }

    return infos;
}

function readFstContentCount(buffer: Buffer): number {
    return buffer.readUInt32BE(FST_CONTENT_COUNT_OFFSET);
}
