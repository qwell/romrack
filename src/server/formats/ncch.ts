const MEDIA_UNIT_SIZE = 0x200;
const NCCH_MAGIC_OFFSET = 0x100;
const NCCH_MAGIC = 'NCCH';
const NCCH_PARTITION_ID_OFFSET = 0x108;
const NCCH_PROGRAM_ID_OFFSET = 0x118;
const NCCH_VERSION_OFFSET = 0x112;
const NCCH_PRODUCT_CODE_OFFSET = 0x150;
const NCCH_PRODUCT_CODE_LENGTH = 0x10;
const NCCH_CONTENT_SIZE_OFFSET = 0x104;
const NCCH_EXHEADER_SIZE_OFFSET = 0x180;
const NCCH_FLAGS_OFFSET = 0x188;
const NCCH_PLAIN_OFFSET_OFFSET = 0x190;
const NCCH_PLAIN_SIZE_OFFSET = 0x194;
const NCCH_LOGO_OFFSET_OFFSET = 0x198;
const NCCH_LOGO_SIZE_OFFSET = 0x19c;
const NCCH_EXEFS_OFFSET_OFFSET = 0x1a0;
const NCCH_EXEFS_SIZE_OFFSET = 0x1a4;
const NCCH_ROMFS_OFFSET_OFFSET = 0x1b0;
const NCCH_ROMFS_SIZE_OFFSET = 0x1b4;

export const NCCH_HEADER_SIZE = 0x200;

export type NcchHeader = {
    titleId: string;
    productCode: string | null;
    version: number;
    contentSize: number;
    exheaderSize: number;
    plainOffset: number;
    plainSize: number;
    logoOffset: number;
    logoSize: number;
    exefsOffset: number;
    exefsSize: number;
    romfsOffset: number;
    romfsSize: number;
    noCrypto: boolean;
    mediaUnitSize: number;
};

export type Ncch = {
    productCode: string | null;
    exefs: Buffer | null;
};

export type NcchReadResult =
    | {
          ok: true;
          ncch: Ncch;
      }
    | {
          ok: false;
          reason: string;
      };

export function readNcch(content: Buffer): Ncch | null {
    const result = inspectNcch(content);
    return result.ok ? result.ncch : null;
}

export function isNcchHeader(header: Buffer): boolean {
    return (
        header.length >= NCCH_HEADER_SIZE &&
        Buffer.from(header)
            .subarray(NCCH_MAGIC_OFFSET, NCCH_MAGIC_OFFSET + NCCH_MAGIC.length)
            .toString('ascii') === NCCH_MAGIC
    );
}

export function readNcchHeader(header: Buffer): NcchHeader | null {
    if (!isNcchHeader(header)) {
        return null;
    }

    const view = dataView(header);
    const mediaUnitSize = getNcchMediaUnitSize(header);
    const readMediaUnits = (offset: number): number =>
        view.getUint32(offset, true) * mediaUnitSize;
    return {
        titleId: readTitleId(Buffer.from(header), NCCH_PROGRAM_ID_OFFSET),
        productCode:
            readAscii(
                header,
                NCCH_PRODUCT_CODE_OFFSET,
                NCCH_PRODUCT_CODE_LENGTH
            ) || null,
        version: view.getUint16(NCCH_VERSION_OFFSET, true),
        contentSize: readMediaUnits(NCCH_CONTENT_SIZE_OFFSET),
        exheaderSize: view.getUint32(NCCH_EXHEADER_SIZE_OFFSET, true),
        plainOffset: readMediaUnits(NCCH_PLAIN_OFFSET_OFFSET),
        plainSize: readMediaUnits(NCCH_PLAIN_SIZE_OFFSET),
        logoOffset: readMediaUnits(NCCH_LOGO_OFFSET_OFFSET),
        logoSize: readMediaUnits(NCCH_LOGO_SIZE_OFFSET),
        exefsOffset: readMediaUnits(NCCH_EXEFS_OFFSET_OFFSET),
        exefsSize: readMediaUnits(NCCH_EXEFS_SIZE_OFFSET),
        romfsOffset: readMediaUnits(NCCH_ROMFS_OFFSET_OFFSET),
        romfsSize: readMediaUnits(NCCH_ROMFS_SIZE_OFFSET),
        noCrypto: (header[NCCH_FLAGS_OFFSET + 7] & 0x04) !== 0,
        mediaUnitSize,
    };
}

export function createNcchRegionCounter(
    header: Buffer,
    regionOffset: number,
    regionId: number
): Buffer {
    const counter = Buffer.alloc(16);
    const partitionId = Buffer.from(
        header.subarray(NCCH_PARTITION_ID_OFFSET, NCCH_PARTITION_ID_OFFSET + 8)
    );
    const version = dataView(header).getUint16(NCCH_VERSION_OFFSET, true);

    if (version === 1) {
        partitionId.copy(counter, 0);
        counter.writeUInt32BE(regionOffset, 12);
    } else {
        Buffer.from(partitionId).reverse().copy(counter, 0);
        counter[8] = regionId;
    }

    return counter;
}

export function inspectNcch(content: Buffer): NcchReadResult {
    if (content.length < NCCH_MAGIC_OFFSET + NCCH_MAGIC.length) {
        return {
            ok: false,
            reason: `content too small for NCCH header (${content.length.toString()} bytes)`,
        };
    }

    const magic = readAscii(content, NCCH_MAGIC_OFFSET, NCCH_MAGIC.length);
    if (magic !== NCCH_MAGIC) {
        return {
            ok: false,
            reason: `NCCH magic mismatch at 0x${NCCH_MAGIC_OFFSET.toString(16)} (${JSON.stringify(magic)})`,
        };
    }

    const productCode = readAscii(
        content,
        NCCH_PRODUCT_CODE_OFFSET,
        NCCH_PRODUCT_CODE_LENGTH
    );

    return {
        ok: true,
        ncch: {
            productCode: productCode || null,
            exefs: readNcchExeFs(content),
        },
    };
}

function readNcchExeFs(content: Buffer): Buffer | null {
    if (content.length < NCCH_EXEFS_SIZE_OFFSET + 4) {
        return null;
    }

    const view = dataView(content);
    const offset =
        view.getUint32(NCCH_EXEFS_OFFSET_OFFSET, true) * MEDIA_UNIT_SIZE;
    const size = view.getUint32(NCCH_EXEFS_SIZE_OFFSET, true) * MEDIA_UNIT_SIZE;

    if (offset <= 0 || size <= 0) {
        return null;
    }
    if (offset + size > content.length) {
        return null;
    }

    return content.slice(offset, offset + size);
}

function getNcchMediaUnitSize(header: Buffer): number {
    return MEDIA_UNIT_SIZE * 2 ** header[NCCH_FLAGS_OFFSET + 6];
}

function readTitleId(buffer: Buffer, offset: number): string {
    return buffer.readBigUInt64LE(offset).toString(16).padStart(16, '0');
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
    return Buffer.from(buffer)
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
}

function dataView(buffer: Buffer): DataView {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
