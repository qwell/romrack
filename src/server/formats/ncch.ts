const MEDIA_UNIT_SIZE = 0x200;
const NCCH_MAGIC_OFFSET = 0x100;
const NCCH_MAGIC = 'NCCH';
const NCCH_PARTITION_ID_OFFSET = 0x108;
const NCCH_PROGRAM_ID_OFFSET = 0x118;
const NCCH_VERSION_OFFSET = 0x112;
const NCCH_PRODUCT_CODE_OFFSET = 0x150;
const NCCH_PRODUCT_CODE_LENGTH = 0x10;
const NCCH_FLAGS_OFFSET = 0x188;
const NCCH_EXEFS_OFFSET_OFFSET = 0x1a0;
const NCCH_EXEFS_SIZE_OFFSET = 0x1a4;

export const NCCH_HEADER_SIZE = 0x200;

export type NcchHeader = {
    titleId: string;
    productCode: string | null;
    version: number;
    exefsOffset: number;
    exefsSize: number;
    noCrypto: boolean;
    mediaUnitSize: number;
};

export type Ncch = {
    productCode: string | null;
    exefs: Uint8Array | null;
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

export function readNcch(content: Uint8Array): Ncch | null {
    const result = inspectNcch(content);
    return result.ok ? result.ncch : null;
}

export function isNcchHeader(header: Buffer | Uint8Array): boolean {
    return (
        header.length >= NCCH_MAGIC_OFFSET + NCCH_MAGIC.length &&
        Buffer.from(header)
            .subarray(NCCH_MAGIC_OFFSET, NCCH_MAGIC_OFFSET + NCCH_MAGIC.length)
            .toString('ascii') === NCCH_MAGIC
    );
}

export function readNcchHeader(header: Buffer | Uint8Array): NcchHeader | null {
    if (!isNcchHeader(header)) {
        return null;
    }

    const view = dataView(header);
    const mediaUnitSize = getNcchMediaUnitSize(header);
    return {
        titleId: readTitleId(Buffer.from(header), NCCH_PROGRAM_ID_OFFSET),
        productCode:
            readAscii(
                header,
                NCCH_PRODUCT_CODE_OFFSET,
                NCCH_PRODUCT_CODE_LENGTH
            ) || null,
        version: view.getUint16(NCCH_VERSION_OFFSET, true),
        exefsOffset:
            view.getUint32(NCCH_EXEFS_OFFSET_OFFSET, true) * mediaUnitSize,
        exefsSize: view.getUint32(NCCH_EXEFS_SIZE_OFFSET, true) * mediaUnitSize,
        noCrypto: (header[NCCH_FLAGS_OFFSET + 7] & 0x04) !== 0,
        mediaUnitSize,
    };
}

export function createNcchRegionCounter(
    header: Buffer | Uint8Array,
    regionOffset: number,
    regionId: number
): Uint8Array {
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

export function inspectNcch(content: Uint8Array): NcchReadResult {
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

function readNcchExeFs(content: Uint8Array): Uint8Array | null {
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

function getNcchMediaUnitSize(header: Buffer | Uint8Array): number {
    return MEDIA_UNIT_SIZE << header[NCCH_FLAGS_OFFSET + 6];
}

function readTitleId(buffer: Buffer, offset: number): string {
    return buffer.readBigUInt64LE(offset).toString(16).padStart(16, '0');
}

function readAscii(
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number
): string {
    return Buffer.from(buffer)
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
}

function dataView(buffer: Uint8Array): DataView {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
