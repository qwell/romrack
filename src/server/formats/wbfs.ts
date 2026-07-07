import { open, stat } from 'node:fs/promises';
import path from 'node:path';

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

const WBFS_MAGIC = 'WBFS';
const WBFS_MAGIC_OFFSET = 0x00;
const WBFS_MAGIC_LENGTH = 0x04;
const WBFS_HEADER_LENGTH = 0x0c;
const WBFS_HD_SECTOR_SHIFT_OFFSET = 0x08;
const WBFS_WBFS_SECTOR_SHIFT_OFFSET = 0x09;
const WBFS_SPLIT_PART_PATTERN = /^\.wbf([1-9][0-9]*)$/i;

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
