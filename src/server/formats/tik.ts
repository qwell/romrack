export const TIK_TITLE_FILE = 'title.tik';

const TIK_TITLE_ID_OFFSET = 0x1dc;
const TIK_TITLE_ID_SIZE = 8;

const TIK_VERSION_OFFSET = 0x1e6;
const TIK_VERSION_SIZE = 2;

const TIK_COMMON_KEY_INDEX_OFFSET = 0x1f1;

const TIK_ENCRYPTED_KEY_OFFSET = 0x1bf;
const TIK_ENCRYPTED_KEY_SIZE = 16;

const TIK_CERT_1_OFFSET = 0x350;
const TIK_CERT_1_SIZE = 0x300;

const TIK_CERT_0_OFFSET = 0x650;
const TIK_CERT_0_SIZE = 0x400;

const TIK_MIN_READ_SIZE = Math.max(
    TIK_TITLE_ID_OFFSET + TIK_TITLE_ID_SIZE,
    TIK_VERSION_OFFSET + TIK_VERSION_SIZE,
    TIK_ENCRYPTED_KEY_OFFSET + TIK_ENCRYPTED_KEY_SIZE
);

const TIK_MIN_TEMPLATE_SIZE = Math.max(
    TIK_TITLE_ID_OFFSET + TIK_TITLE_ID_SIZE,
    TIK_VERSION_OFFSET + TIK_VERSION_SIZE,
    TIK_ENCRYPTED_KEY_OFFSET + TIK_ENCRYPTED_KEY_SIZE
);

export type Tik = {
    titleId: Buffer;
    titleVersion: number;
    encryptedKey: Buffer;
    commonKeyIndex: number | null;
    cert0: Buffer | null;
    cert1: Buffer | null;
};

export type GeneratedTikInput = {
    titleId: Buffer;
    encryptedTitleKey: Buffer;
    titleVersion: number;
};

export function readTik(data: Buffer): Tik | null {
    if (data.length < TIK_MIN_READ_SIZE) {
        return null;
    }

    return {
        titleId: copyRange(data, TIK_TITLE_ID_OFFSET, TIK_TITLE_ID_SIZE),
        titleVersion: data.readUInt16BE(TIK_VERSION_OFFSET),
        encryptedKey: copyRange(
            data,
            TIK_ENCRYPTED_KEY_OFFSET,
            TIK_ENCRYPTED_KEY_SIZE
        ),
        commonKeyIndex:
            data.length > TIK_COMMON_KEY_INDEX_OFFSET
                ? data.readUInt8(TIK_COMMON_KEY_INDEX_OFFSET)
                : null,
        cert0: readOptionalRange(data, TIK_CERT_0_OFFSET, TIK_CERT_0_SIZE),
        cert1: readOptionalRange(data, TIK_CERT_1_OFFSET, TIK_CERT_1_SIZE),
    };
}

export function createTikFromTemplate(
    template: Buffer,
    { titleId, encryptedTitleKey, titleVersion }: GeneratedTikInput
): Buffer {
    assertByteLength(titleId, TIK_TITLE_ID_SIZE, 'titleId');
    assertByteLength(
        encryptedTitleKey,
        TIK_ENCRYPTED_KEY_SIZE,
        'encryptedTitleKey'
    );
    assertUint16(titleVersion, 'titleVersion');

    if (template.length < TIK_MIN_TEMPLATE_SIZE) {
        throw new Error(
            `Generated ticket template too small: got ${template.length.toString()}, ` +
                `need ${TIK_MIN_TEMPLATE_SIZE.toString()}`
        );
    }

    const ticket = Buffer.from(template);

    encryptedTitleKey.copy(ticket, TIK_ENCRYPTED_KEY_OFFSET);
    titleId.copy(ticket, TIK_TITLE_ID_OFFSET);
    ticket.writeUInt16BE(titleVersion, TIK_VERSION_OFFSET);

    return ticket;
}

export function readTikAuthorityCertificate(ticket: Buffer): Buffer | null {
    return readOptionalRange(ticket, TIK_CERT_1_OFFSET, TIK_CERT_1_SIZE);
}

function copyRange(data: Buffer, offset: number, size: number): Buffer {
    return Buffer.from(data.subarray(offset, offset + size));
}

function readOptionalRange(
    data: Buffer,
    offset: number,
    size: number
): Buffer | null {
    if (!hasCompleteRange(data, offset, size)) {
        return null;
    }

    return copyRange(data, offset, size);
}

function hasCompleteRange(data: Buffer, offset: number, size: number): boolean {
    return (
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(size) &&
        offset >= 0 &&
        size >= 0 &&
        offset <= data.length &&
        size <= data.length - offset
    );
}

function assertByteLength(value: Buffer, expected: number, name: string): void {
    if (value.length !== expected) {
        throw new Error(
            `${name} must be ${expected.toString()} bytes; got ${value.length.toString()}`
        );
    }
}

function assertUint16(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new Error(`${name} must be an unsigned 16-bit integer`);
    }
}
