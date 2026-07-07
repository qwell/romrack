import { deflateSync } from 'node:zlib';

import { normalizeRegion } from '../../shared/regions.js';

export type SmdhMetadata = {
    name: string | null;
    publisher: string | null;
    region: string | null;
};

export type SmdhReadResult =
    | {
          ok: true;
          metadata: SmdhMetadata;
      }
    | {
          ok: false;
          reason: string;
      };

type SmdhTitle = {
    shortDescription: string;
    longDescription: string;
    publisher: string;
};

const SMDH_MAGIC = 'SMDH';
const SMDH_TITLE_OFFSET = 0x08;
const SMDH_TITLE_COUNT = 16;
const SMDH_TITLE_SIZE = 0x200;
const SMDH_SHORT_DESCRIPTION_OFFSET = 0x000;
const SMDH_SHORT_DESCRIPTION_SIZE = 0x80;
const SMDH_LONG_DESCRIPTION_OFFSET = 0x080;
const SMDH_LONG_DESCRIPTION_SIZE = 0x100;
const SMDH_PUBLISHER_OFFSET = 0x180;
const SMDH_PUBLISHER_SIZE = 0x80;
const SMDH_REGION_LOCKOUT_OFFSET = 0x2018;
const SMDH_LARGE_ICON_OFFSET = 0x24c0;
const SMDH_LARGE_ICON_SIZE = 48;
const SMDH_RGB565_BYTES_PER_PIXEL = 2;

const SMDH_TITLE_ENGLISH = 1;

const SMDH_REGION_BITS: Array<[number, string]> = [
    [0x01, 'JPN'],
    [0x02, 'USA'],
    [0x04, 'EUR'],
    [0x08, 'AUS'],
    [0x10, 'KOR'],
    [0x20, 'TWN'],
    [0x40, 'CHN'],
];

export function readSmdhMetadata(
    smdh: Uint8Array,
    productCode: string | null
): SmdhMetadata | null {
    const result = inspectSmdhMetadata(smdh, productCode);
    return result.ok ? result.metadata : null;
}

export function readSmdhLargeIconPng(smdh: Uint8Array): Buffer | null {
    const iconBytes =
        SMDH_LARGE_ICON_SIZE *
        SMDH_LARGE_ICON_SIZE *
        SMDH_RGB565_BYTES_PER_PIXEL;
    if (smdh.length < SMDH_LARGE_ICON_OFFSET + iconBytes) {
        return null;
    }

    const rgba = Buffer.alloc(SMDH_LARGE_ICON_SIZE * SMDH_LARGE_ICON_SIZE * 4);
    const icon = Buffer.from(
        smdh.subarray(
            SMDH_LARGE_ICON_OFFSET,
            SMDH_LARGE_ICON_OFFSET + iconBytes
        )
    );
    let sourceOffset = 0;

    for (let tileY = 0; tileY < SMDH_LARGE_ICON_SIZE; tileY += 8) {
        for (let tileX = 0; tileX < SMDH_LARGE_ICON_SIZE; tileX += 8) {
            for (let pixel = 0; pixel < 64; pixel += 1) {
                const { x, y } = decodeMorton8x8(pixel);
                const color = readRgb565(icon.readUInt16LE(sourceOffset));
                sourceOffset += SMDH_RGB565_BYTES_PER_PIXEL;

                const target =
                    ((tileY + y) * SMDH_LARGE_ICON_SIZE + tileX + x) * 4;
                rgba[target] = color.r;
                rgba[target + 1] = color.g;
                rgba[target + 2] = color.b;
                rgba[target + 3] = 255;
            }
        }
    }

    return encodePngRgba(SMDH_LARGE_ICON_SIZE, SMDH_LARGE_ICON_SIZE, rgba);
}

export function inspectSmdhMetadata(
    smdh: Uint8Array,
    productCode: string | null
): SmdhReadResult {
    if (smdh.length < SMDH_REGION_LOCKOUT_OFFSET + 4) {
        return {
            ok: false,
            reason: `SMDH too small (${smdh.length.toString()} bytes)`,
        };
    }

    const magic = readAscii(smdh, 0, SMDH_MAGIC.length);
    if (magic !== SMDH_MAGIC) {
        return {
            ok: false,
            reason: `SMDH magic mismatch (${JSON.stringify(magic)})`,
        };
    }

    const title = readSmdhTitle(smdh);
    const region = readSmdhRegion(smdh, productCode);

    if (!title && !region) {
        return {
            ok: false,
            reason: 'SMDH had no title or region metadata',
        };
    }

    return {
        ok: true,
        metadata: {
            name: title?.longDescription || title?.shortDescription || null,
            publisher: title?.publisher || null,
            region,
        },
    };
}

function readSmdhTitle(smdh: Uint8Array): SmdhTitle | null {
    const titles = Array.from({ length: SMDH_TITLE_COUNT }, (_, index) =>
        readSmdhTitleAt(smdh, index)
    );

    return (
        nonEmptySmdhTitle(titles[SMDH_TITLE_ENGLISH]) ??
        titles.find(nonEmptySmdhTitle) ??
        null
    );
}

function readSmdhTitleAt(smdh: Uint8Array, index: number): SmdhTitle {
    const offset = SMDH_TITLE_OFFSET + index * SMDH_TITLE_SIZE;

    return {
        shortDescription: readUtf16String(
            smdh,
            offset + SMDH_SHORT_DESCRIPTION_OFFSET,
            SMDH_SHORT_DESCRIPTION_SIZE
        ),
        longDescription: readUtf16String(
            smdh,
            offset + SMDH_LONG_DESCRIPTION_OFFSET,
            SMDH_LONG_DESCRIPTION_SIZE
        ),
        publisher: readUtf16String(
            smdh,
            offset + SMDH_PUBLISHER_OFFSET,
            SMDH_PUBLISHER_SIZE
        ),
    };
}

function readSmdhRegion(
    smdh: Uint8Array,
    productCode: string | null
): string | null {
    if (smdh.length < SMDH_REGION_LOCKOUT_OFFSET + 4) {
        return normalizeRegion(null, productCode);
    }

    const regionLockout = dataView(smdh).getUint32(
        SMDH_REGION_LOCKOUT_OFFSET,
        true
    );
    const regions = SMDH_REGION_BITS.flatMap(([bit, region]) =>
        (regionLockout & bit) !== 0 ? [region] : []
    );

    if (regions.length === 1) {
        return regions[0];
    }

    return normalizeRegion(null, productCode);
}

function nonEmptySmdhTitle(title: SmdhTitle): SmdhTitle | null {
    return title.shortDescription || title.longDescription || title.publisher
        ? title
        : null;
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
    return Buffer.from(buffer)
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
}

function readUtf16String(
    buffer: Uint8Array,
    offset: number,
    length: number
): string {
    return Buffer.from(buffer)
        .subarray(offset, offset + length)
        .toString('utf16le')
        .replace(/\0.*$/, '')
        .trim();
}

function dataView(buffer: Uint8Array): DataView {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function decodeMorton8x8(index: number): { x: number; y: number } {
    return {
        x:
            ((index >> 0) & 1) |
            (((index >> 2) & 1) << 1) |
            (((index >> 4) & 1) << 2),
        y:
            ((index >> 1) & 1) |
            (((index >> 3) & 1) << 1) |
            (((index >> 5) & 1) << 2),
    };
}

function readRgb565(value: number): { r: number; g: number; b: number } {
    const r = (value >> 11) & 0x1f;
    const g = (value >> 5) & 0x3f;
    const b = value & 0x1f;
    return {
        r: (r << 3) | (r >> 2),
        g: (g << 2) | (g >> 4),
        b: (b << 3) | (b >> 2),
    };
}

function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;

    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const rowOffset = y * (width * 4 + 1);
        raw[rowOffset] = 0;
        rgba.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = crc32(Buffer.concat([typeBuffer, data]));
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(data: Buffer): Buffer {
    let crc = ~0;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    const output = Buffer.alloc(4);
    output.writeUInt32BE(~crc >>> 0);
    return output;
}
