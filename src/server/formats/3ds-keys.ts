import { createDecipheriv } from 'node:crypto';

export type ThreeDSAesKeys = {
    generatorConstant: Uint8Array;
    slot0x18KeyX: Uint8Array | null;
    slot0x1bKeyX: Uint8Array | null;
    slot0x25KeyX: Uint8Array | null;
    slot0x2cKeyX: Uint8Array | null;
    slot0x3dKeyX: Uint8Array | null;
    commonKeyYs: Array<Uint8Array | null>;
};

const AES_BLOCK_SIZE = 16;
const KEY_NAMES = {
    generatorConstant: ['generatorConstant', 'generator'],
    slot0x18KeyX: ['slot0x18KeyX'],
    slot0x1bKeyX: ['slot0x1BKeyX'],
    slot0x25KeyX: ['slot0x25KeyX'],
    slot0x2cKeyX: ['slot0x2CKeyX'],
    slot0x3dKeyX: ['slot0x3DKeyX'],
} as const;

export function parseThreeDSAesKeys(text: string): ThreeDSAesKeys | null {
    const entries = parseKeyValueHex(text);
    const generatorConstant = readNamedKey(
        entries,
        KEY_NAMES.generatorConstant
    );
    if (!generatorConstant) {
        return null;
    }

    return {
        generatorConstant,
        slot0x18KeyX: readNamedKey(entries, KEY_NAMES.slot0x18KeyX),
        slot0x1bKeyX: readNamedKey(entries, KEY_NAMES.slot0x1bKeyX),
        slot0x25KeyX: readNamedKey(entries, KEY_NAMES.slot0x25KeyX),
        slot0x2cKeyX: readNamedKey(entries, KEY_NAMES.slot0x2cKeyX),
        slot0x3dKeyX: readNamedKey(entries, KEY_NAMES.slot0x3dKeyX),
        commonKeyYs: Array.from({ length: 6 }, (_, index) =>
            readNamedKey(entries, [`common${index.toString()}`])
        ),
    };
}

export function deriveThreeDSNormalKey(
    keyX: Uint8Array,
    keyY: Uint8Array,
    generatorConstant: Uint8Array
): Uint8Array {
    assertKey(keyX, 'keyX');
    assertKey(keyY, 'keyY');
    assertKey(generatorConstant, 'generatorConstant');

    return rotateLeft128(
        add128(xor128(rotateLeft128(keyX, 2), keyY), generatorConstant),
        87
    );
}

export function decryptAes128Ctr(
    input: Uint8Array,
    key: Uint8Array,
    counter: Uint8Array
): Uint8Array {
    assertKey(key, 'key');
    assertKey(counter, 'counter');
    const decipher = createDecipheriv(
        'aes-128-ctr',
        Buffer.from(key),
        Buffer.from(counter)
    );
    return new Uint8Array(
        Buffer.concat([decipher.update(Buffer.from(input)), decipher.final()])
    );
}

function parseKeyValueHex(text: string): Map<string, Uint8Array> {
    const entries = new Map<string, Uint8Array>();
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(':')) {
            continue;
        }
        const match = /^([^=#\s]+)\s*=\s*([0-9a-fA-F]{32})\s*$/.exec(trimmed);
        if (!match) {
            continue;
        }
        entries.set(match[1], new Uint8Array(Buffer.from(match[2], 'hex')));
    }
    return entries;
}

function readNamedKey(
    entries: Map<string, Uint8Array>,
    names: readonly string[]
): Uint8Array | null {
    for (const name of names) {
        const key = entries.get(name);
        if (key) {
            return key;
        }
    }
    return null;
}

function assertKey(key: Uint8Array, label: string): void {
    if (key.length !== AES_BLOCK_SIZE) {
        throw new Error(`${label} must be 16 bytes, got ${key.length}`);
    }
}

function xor128(a: Uint8Array, b: Uint8Array): Uint8Array {
    return new Uint8Array(a.map((value, index) => value ^ b[index]));
}

function add128(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = (toBigInt(a) + toBigInt(b)) & ((1n << 128n) - 1n);
    return fromBigInt(result);
}

function rotateLeft128(value: Uint8Array, bits: number): Uint8Array {
    const mask = (1n << 128n) - 1n;
    const shift = BigInt(bits % 128);
    const input = toBigInt(value);
    return fromBigInt(((input << shift) | (input >> (128n - shift))) & mask);
}

function toBigInt(value: Uint8Array): bigint {
    return BigInt(`0x${Buffer.from(value).toString('hex')}`);
}

function fromBigInt(value: bigint): Uint8Array {
    return new Uint8Array(
        Buffer.from(value.toString(16).padStart(32, '0'), 'hex')
    );
}
