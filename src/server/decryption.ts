import {
    createCipheriv,
    createDecipheriv,
    createHash,
    pbkdf2Sync,
} from 'node:crypto';

export type TitleKey = Buffer;

export type GeneratedTitleKey = {
    password: string;
    titleKey: TitleKey;
};

const AES_BLOCK_SIZE = 16;

const KEYGEN_SECRET = Buffer.from([
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

export function createTitleKeyIv(titleId: Buffer): Buffer {
    if (titleId.length !== 8) {
        throw new Error(
            `titleId IV source must be 8 bytes, got ${titleId.length}`
        );
    }
    const iv = Buffer.alloc(AES_BLOCK_SIZE);
    Buffer.from(titleId).copy(iv, 0);
    return iv;
}

export function createContentIv(contentIndex: number): Buffer {
    if (
        !Number.isInteger(contentIndex) ||
        contentIndex < 0 ||
        contentIndex > 0xffff
    ) {
        throw new Error(`contentIndex must be a uint16, got ${contentIndex}`);
    }
    const iv = Buffer.alloc(AES_BLOCK_SIZE);
    iv.writeUInt16BE(contentIndex, 0);
    return iv;
}

export function createBigIntIv(value: bigint | number): Buffer {
    const iv = Buffer.alloc(AES_BLOCK_SIZE);
    iv.writeBigUInt64BE(
        typeof value === 'bigint' ? value : BigInt(Math.trunc(value)),
        0
    );
    return iv;
}

// -- Decryption --

export function decryptTitleKey(
    encryptedKey: Buffer,
    commonKey: Buffer,
    titleId: Buffer
): TitleKey {
    return aes128CbcDecrypt(encryptedKey, commonKey, createTitleKeyIv(titleId));
}

export function encryptTitleKey(
    titleKey: Buffer,
    commonKey: Buffer,
    titleId: Buffer
): Buffer {
    return aes128CbcEncrypt(titleKey, commonKey, createTitleKeyIv(titleId));
}

export function decryptContentWithBigIntIv(
    encryptedContent: Buffer,
    titleKey: Buffer,
    value: bigint | number
): Buffer {
    return aes128CbcDecrypt(encryptedContent, titleKey, createBigIntIv(value));
}

export function decryptContentWithIv(
    encryptedContent: Buffer,
    titleKey: Buffer,
    iv: Buffer
): Buffer {
    return aes128CbcDecrypt(encryptedContent, titleKey, iv);
}

export function deriveThreeDSNormalKey(
    keyX: Buffer,
    keyY: Buffer,
    generatorConstant: Buffer
): Buffer {
    assertAesParams(keyX, keyY);
    if (generatorConstant.length !== AES_BLOCK_SIZE) {
        throw new Error('3DS generator constant must be 16 bytes');
    }
    return rotateLeft128(
        add128(xor128(rotateLeft128(keyX, 2), keyY), generatorConstant),
        87
    );
}

export function decryptAes128Ctr(
    input: Buffer,
    key: Buffer,
    counter: Buffer
): Buffer {
    assertAesParams(key, counter);
    const decipher = createDecipheriv('aes-128-ctr', key, counter);
    return Buffer.concat([decipher.update(input), decipher.final()]);
}

function xor128(a: Buffer, b: Buffer): Buffer {
    return Buffer.from(a.map((value, index) => value ^ b[index]));
}

function add128(a: Buffer, b: Buffer): Buffer {
    return fromBigInt((toBigInt(a) + toBigInt(b)) & ((1n << 128n) - 1n));
}

function rotateLeft128(value: Buffer, bits: number): Buffer {
    const mask = (1n << 128n) - 1n;
    const shift = BigInt(bits % 128);
    const input = toBigInt(value);
    return fromBigInt(((input << shift) | (input >> (128n - shift))) & mask);
}

function toBigInt(value: Buffer): bigint {
    return BigInt(`0x${Buffer.from(value).toString('hex')}`);
}

function fromBigInt(value: bigint): Buffer {
    return Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
}

// -- Title key generation --

export function generateTitleKey(
    titleId: Buffer,
    password: string
): GeneratedTitleKey {
    return {
        password,
        titleKey: deriveTitleKey(titleId, password),
    };
}

export function findGeneratedTitleKey(
    titleId: Buffer,
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
function aes128CbcDecrypt(input: Buffer, key: Buffer, iv: Buffer): Buffer {
    assertAesParams(key, iv);
    const decipher = createDecipheriv(
        'aes-128-cbc',
        Buffer.from(key),
        Buffer.from(iv)
    );
    decipher.setAutoPadding(false);
    return Buffer.concat([
        decipher.update(Buffer.from(input)),
        decipher.final(),
    ]);
}

function aes128CbcEncrypt(input: Buffer, key: Buffer, iv: Buffer): Buffer {
    assertAesParams(key, iv);
    const cipher = createCipheriv(
        'aes-128-cbc',
        Buffer.from(key),
        Buffer.from(iv)
    );
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(Buffer.from(input)), cipher.final()]);
}

function assertAesParams(key: Buffer, iv: Buffer): void {
    if (key.length !== AES_BLOCK_SIZE) {
        throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`);
    }
    if (iv.length !== AES_BLOCK_SIZE) {
        throw new Error(`AES-CBC IV must be 16 bytes, got ${iv.length}`);
    }
}

function deriveTitleKey(titleId: Buffer, password: string): TitleKey {
    const saltSource = Buffer.concat([
        Buffer.from(KEYGEN_SECRET),
        Buffer.from(extractKeygenTitleIdPart(titleId)),
    ]);
    const salt = createHash('md5').update(saltSource).digest();
    return pbkdf2Sync(password, salt, 20, AES_BLOCK_SIZE, 'sha1');
}

function extractKeygenTitleIdPart(titleId: Buffer): Buffer {
    if (titleId.length !== 8) {
        throw new Error(`titleId must be 8 bytes, got ${titleId.length}`);
    }
    return isVwiiIosTitleId(titleId)
        ? titleId.subarray(3)
        : titleId.subarray(1);
}

function isVwiiIosTitleId(titleId: Buffer): boolean {
    return titleId[0] === 0x00 && titleId[1] === 0x01 && titleId[2] === 0x00;
}
