export type CiaHeader = {
    ticketOffset: number;
    ticketSize: number;
    tmdOffset: number;
    tmdSize: number;
    contentOffset: number;
    contentSize: number;
    contentIndex: Buffer;
};

export type CiaContent = {
    index: number;
    size: number;
};

export const CIA_HEADER_MIN_SIZE = 0x2020;
export const TICKET_TITLE_ID_OFFSET = 0x1dc;
export const TICKET_TITLE_ID_SIZE = 8;
export const TICKET_ENCRYPTED_TITLE_KEY_OFFSET = 0x1bf;
export const TICKET_ENCRYPTED_TITLE_KEY_SIZE = 16;

const CIA_HEADER_SIZE_OFFSET = 0x00;
const CIA_CERT_SIZE_OFFSET = 0x08;
const CIA_TICKET_SIZE_OFFSET = 0x0c;
const CIA_TMD_SIZE_OFFSET = 0x10;
const CIA_CONTENT_SIZE_OFFSET = 0x18;
const CIA_CONTENT_INDEX_OFFSET = 0x20;
const CIA_CONTENT_INDEX_SIZE = 0x2000;
const TMD_CONTENT_COUNT_OFFSET = 0x1de;
const TMD_CONTENT_TABLE_OFFSET = 0xb04;
const TMD_CONTENT_ENTRY_SIZE = 0x30;

export function readCiaHeader(header: Buffer): CiaHeader | null {
    if (header.length < CIA_HEADER_MIN_SIZE) {
        return null;
    }

    const headerSize = header.readUInt32LE(CIA_HEADER_SIZE_OFFSET);
    const certSize = header.readUInt32LE(CIA_CERT_SIZE_OFFSET);
    const ticketSize = header.readUInt32LE(CIA_TICKET_SIZE_OFFSET);
    const tmdSize = header.readUInt32LE(CIA_TMD_SIZE_OFFSET);
    const contentSizeValue = header.readBigUInt64LE(CIA_CONTENT_SIZE_OFFSET);

    if (
        headerSize < CIA_HEADER_MIN_SIZE ||
        ticketSize <= 0 ||
        tmdSize <= 0 ||
        contentSizeValue > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
        return null;
    }

    const ticketOffset = align64(align64(headerSize) + certSize);
    const tmdOffset = align64(ticketOffset + ticketSize);

    return {
        ticketOffset,
        ticketSize,
        tmdOffset,
        tmdSize,
        contentOffset: align64(tmdOffset + tmdSize),
        contentSize: Number(contentSizeValue),
        contentIndex: Buffer.from(
            header.subarray(
                CIA_CONTENT_INDEX_OFFSET,
                CIA_CONTENT_INDEX_OFFSET + CIA_CONTENT_INDEX_SIZE
            )
        ),
    };
}

export function isCiaContentPresent(
    header: CiaHeader,
    contentIndex: number
): boolean {
    if (
        !Number.isInteger(contentIndex) ||
        contentIndex < 0 ||
        contentIndex > 0xffff
    ) {
        return false;
    }

    const byte = header.contentIndex[contentIndex >>> 3];
    const mask = 0x80 >>> (contentIndex & 7);
    return byte !== undefined && (byte & mask) !== 0;
}

export function getCiaContentStorageSize(
    content: Pick<CiaContent, 'size'>
): number {
    return align64(content.size);
}

export function readCiaTmdContents(tmd: Buffer): CiaContent[] {
    if (tmd.length < TMD_CONTENT_COUNT_OFFSET + 2) {
        return [];
    }

    const count = tmd.readUInt16BE(TMD_CONTENT_COUNT_OFFSET);
    const contents: CiaContent[] = [];
    for (let index = 0; index < count; index += 1) {
        const offset =
            TMD_CONTENT_TABLE_OFFSET + index * TMD_CONTENT_ENTRY_SIZE;
        if (offset + TMD_CONTENT_ENTRY_SIZE > tmd.length) {
            break;
        }
        const size = tmd.readBigUInt64BE(offset + 8);
        if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
            break;
        }
        contents.push({
            index: tmd.readUInt16BE(offset + 4),
            size: Number(size),
        });
    }

    return contents;
}

function align64(value: number): number {
    return Math.ceil(value / 64) * 64;
}
