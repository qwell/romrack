export type CiaHeader = {
    ticketOffset: number;
    ticketSize: number;
    tmdOffset: number;
    tmdSize: number;
    contentOffset: number;
};

export type CiaContent = {
    index: number;
    size: number;
};

export const CIA_HEADER_MIN_SIZE = 0x20;
export const TICKET_TITLE_ID_OFFSET = 0x1dc;
export const TICKET_TITLE_ID_SIZE = 8;
export const TICKET_ENCRYPTED_TITLE_KEY_OFFSET = 0x1bf;
export const TICKET_ENCRYPTED_TITLE_KEY_SIZE = 16;

const CIA_HEADER_SIZE_OFFSET = 0x00;
const CIA_CERT_SIZE_OFFSET = 0x08;
const CIA_TICKET_SIZE_OFFSET = 0x0c;
const CIA_TMD_SIZE_OFFSET = 0x10;
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

    if (headerSize <= 0 || ticketSize <= 0 || tmdSize <= 0) {
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
    };
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
        contents.push({
            index: tmd.readUInt16BE(offset + 4),
            size: Number(tmd.readBigUInt64BE(offset + 8)),
        });
    }

    return contents;
}

function align64(value: number): number {
    return (value + 63) & ~63;
}
