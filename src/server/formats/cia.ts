import { type TmdContent } from './tmd.js';

export type CiaHeader = {
    ticketOffset: number;
    ticketSize: number;
    tmdOffset: number;
    tmdSize: number;
    contentOffset: number;
    contentSize: number;
    contentIndex: Buffer;
};

export const CIA_HEADER_MIN_SIZE = 0x2020;

const CIA_HEADER_SIZE_OFFSET = 0x00;
const CIA_CERT_SIZE_OFFSET = 0x08;
const CIA_TICKET_SIZE_OFFSET = 0x0c;
const CIA_TMD_SIZE_OFFSET = 0x10;
const CIA_CONTENT_SIZE_OFFSET = 0x18;
const CIA_CONTENT_INDEX_OFFSET = 0x20;
const CIA_CONTENT_INDEX_SIZE = 0x2000;

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

export function getCiaPresentContentIndexes(header: CiaHeader): number[] {
    const indexes: number[] = [];
    for (const [byteIndex, byte] of header.contentIndex.entries()) {
        for (let bit = 0; bit < 8; bit += 1) {
            if ((byte & (0x80 >>> bit)) !== 0) {
                indexes.push(byteIndex * 8 + bit);
            }
        }
    }
    return indexes;
}

export function getCiaContentStorageSize(
    content: Pick<TmdContent, 'size'>
): number {
    return align64(content.size);
}

function align64(value: number): number {
    return Math.ceil(value / 64) * 64;
}
