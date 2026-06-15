import {
    createCipheriv,
    createDecipheriv,
    createHash,
    pbkdf2Sync,
} from 'node:crypto';

export type TitleKey = Uint8Array;

export type GeneratedTitleKey = {
    password: string;
    titleKey: TitleKey;
};

const AES_BLOCK_SIZE = 16;

const KEYGEN_SECRET = new Uint8Array([
    0xfd, 0x04, 0x01, 0x05, 0x06, 0x0b, 0x11, 0x1c, 0x2d, 0x49,
]);

export const TITLE_KEY_PASSWORDS = [
    'mypass',
    'nintendo',
    'test',
    '1234567890',
    'Lucy131211',
    'fbf10',
    '5678',
    '1234',
    '',
] as const;

// -- IV construction --

export function createTitleKeyIv(titleId: Uint8Array): Uint8Array {
    if (titleId.length !== 8) {
        throw new Error(
            `titleId IV source must be 8 bytes, got ${titleId.length}`
        );
    }
    const iv = new Uint8Array(AES_BLOCK_SIZE);
    iv.set(titleId, 0);
    return iv;
}

export function createContentIv(contentIndex: number): Uint8Array {
    if (
        !Number.isInteger(contentIndex) ||
        contentIndex < 0 ||
        contentIndex > 0xffff
    ) {
        throw new Error(`contentIndex must be a uint16, got ${contentIndex}`);
    }
    const iv = new Uint8Array(AES_BLOCK_SIZE);
    new DataView(iv.buffer).setUint16(0, contentIndex, false);
    return iv;
}

export function createBigIntIv(value: bigint | number): Uint8Array {
    const iv = new Uint8Array(AES_BLOCK_SIZE);
    new DataView(iv.buffer).setBigUint64(
        0,
        typeof value === 'bigint' ? value : BigInt(Math.trunc(value)),
        false
    );
    return iv;
}

// -- Decryption --

export function decryptTitleKey(
    encryptedKey: Uint8Array,
    commonKey: Uint8Array,
    titleId: Uint8Array
): TitleKey {
    return aes128CbcDecrypt(encryptedKey, commonKey, createTitleKeyIv(titleId));
}

export function encryptTitleKey(
    titleKey: Uint8Array,
    commonKey: Uint8Array,
    titleId: Uint8Array
): Uint8Array {
    return aes128CbcEncrypt(titleKey, commonKey, createTitleKeyIv(titleId));
}

export function decryptContentWithBigIntIv(
    encryptedContent: Uint8Array,
    titleKey: Uint8Array,
    value: bigint | number
): Uint8Array {
    return aes128CbcDecrypt(encryptedContent, titleKey, createBigIntIv(value));
}

export function decryptContentWithIv(
    encryptedContent: Uint8Array,
    titleKey: Uint8Array,
    iv: Uint8Array
): Uint8Array {
    return aes128CbcDecrypt(encryptedContent, titleKey, iv);
}

// -- Title key generation --

export function generateTitleKey(
    titleId: Uint8Array,
    password: string
): GeneratedTitleKey {
    return {
        password,
        titleKey: deriveTitleKey(titleId, password),
    };
}

export function findGeneratedTitleKey(
    titleId: Uint8Array,
    isValid: (candidate: GeneratedTitleKey) => boolean,
    passwords: readonly string[] = TITLE_KEY_PASSWORDS
): GeneratedTitleKey | null {
    for (const password of passwords) {
        const candidate = generateTitleKey(titleId, password);

        if (isValid(candidate)) {
            return candidate;
        }
    }

    return null;
}

// -- Internal --
function aes128CbcDecrypt(
    input: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array
): Uint8Array {
    assertAesParams(key, iv);
    const decipher = createDecipheriv(
        'aes-128-cbc',
        Buffer.from(key),
        Buffer.from(iv)
    );
    decipher.setAutoPadding(false);
    return new Uint8Array(
        Buffer.concat([decipher.update(Buffer.from(input)), decipher.final()])
    );
}

function aes128CbcEncrypt(
    input: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array
): Uint8Array {
    assertAesParams(key, iv);
    const cipher = createCipheriv(
        'aes-128-cbc',
        Buffer.from(key),
        Buffer.from(iv)
    );
    cipher.setAutoPadding(false);
    return new Uint8Array(
        Buffer.concat([cipher.update(Buffer.from(input)), cipher.final()])
    );
}

function assertAesParams(key: Uint8Array, iv: Uint8Array): void {
    if (key.length !== AES_BLOCK_SIZE) {
        throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`);
    }
    if (iv.length !== AES_BLOCK_SIZE) {
        throw new Error(`AES-CBC IV must be 16 bytes, got ${iv.length}`);
    }
}

function deriveTitleKey(titleId: Uint8Array, password: string): TitleKey {
    const saltSource = Buffer.concat([
        Buffer.from(KEYGEN_SECRET),
        Buffer.from(extractKeygenTitleIdPart(titleId)),
    ]);
    const salt = createHash('md5').update(saltSource).digest();
    return new Uint8Array(
        pbkdf2Sync(password, salt, 20, AES_BLOCK_SIZE, 'sha1')
    );
}

function extractKeygenTitleIdPart(titleId: Uint8Array): Uint8Array {
    if (titleId.length !== 8) {
        throw new Error(`titleId must be 8 bytes, got ${titleId.length}`);
    }
    return isVwiiIosTitleId(titleId)
        ? titleId.subarray(3)
        : titleId.subarray(1);
}

function isVwiiIosTitleId(titleId: Uint8Array): boolean {
    return titleId[0] === 0x00 && titleId[1] === 0x01 && titleId[2] === 0x00;
}
