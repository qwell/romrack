import { createDecipheriv, createHash } from 'node:crypto';

import { createContentIv, decryptContentWithIv } from '../decryption.js';
import { type TmdContent } from './tmd.js';

export type ContentTreeVerification = {
    contentId: string;
    status: 'ok' | 'failed';
    error?: string;
};

export type ContentInstallNames = {
    contentId: string;
    appName: string;
    h3Name: string | null;
};

const AES_BLOCK_SIZE = 0x10;
const UINT32_MAX = 0xffffffff;
const CONTENT_TYPE_HASHED_ENCRYPTED = 0x2003;
export const HASHED_BLOCK_SIZE = 0x10000;
export const HASHED_BLOCK_DATA_OFFSET = 0x400;
export const HASHED_BLOCK_DATA_SIZE = 0xfc00;
export const HASH_ENTRY_SIZE = 0x14;
const H3_CONTENT_CLUSTER_SPAN = 0x1000;

const HASH_ENTRIES_PER_LEVEL = 0x10;
const HASH_H0_START = 0x000;
const HASH_H1_START = 0x140;
const HASH_H2_START = 0x280;
const HASH_H2_END = 0x3c0;

export function getEncryptedContentFileSize(content: TmdContent): number {
    if (isHashedContent(content)) {
        return content.size;
    }

    return Math.ceil(content.size / AES_BLOCK_SIZE) * AES_BLOCK_SIZE;
}

export function getContentH3FileSize(content: TmdContent): number {
    return (
        (Math.floor(
            Number(getEncryptedContentFileSize(content)) /
                HASHED_BLOCK_SIZE /
                H3_CONTENT_CLUSTER_SPAN
        ) +
            1) *
        HASH_ENTRY_SIZE
    );
}

export function isHashedContent(content: TmdContent): boolean {
    return (
        (content.type & CONTENT_TYPE_HASHED_ENCRYPTED) ===
        CONTENT_TYPE_HASHED_ENCRYPTED
    );
}

export function formatContentId(contentId: number): string {
    if (
        !Number.isInteger(contentId) ||
        contentId < 0 ||
        contentId > UINT32_MAX
    ) {
        throw new Error(`contentId must be a uint32, got ${contentId}`);
    }
    return contentId.toString(16).toUpperCase().padStart(8, '0');
}

export function getContentInstallNames(
    content: TmdContent
): ContentInstallNames {
    const contentId = formatContentId(content.id);
    return {
        contentId,
        appName: `${contentId}.app`,
        h3Name: isHashedContent(content) ? `${contentId}.h3` : null,
    };
}

export async function verifyContent({
    contentId,
    appSize,
    appChunks,
    h3,
    content,
    titleKey,
    signal,
}: {
    contentId: string;
    appSize: number;
    appChunks: AsyncIterable<Buffer>;
    h3: Buffer | null;
    content: TmdContent;
    titleKey: Buffer;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    try {
        throwIfAborted(signal);
        assertContentSize(
            appSize,
            getEncryptedContentFileSize(content),
            contentId
        );
        if (isHashedContent(content)) {
            if (!h3) {
                return {
                    contentId,
                    status: 'failed',
                    error: 'Missing H3 data for hashed content',
                };
            }

            return await verifyContentTree({
                appChunks,
                h3,
                content,
                titleKey,
                contentId,
                signal,
            });
        }

        return await verifyContentHash({
            appChunks,
            content,
            titleKey,
            contentId,
            signal,
        });
    } catch (error) {
        throwIfAborted(signal);
        return {
            contentId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function assertContentSize(
    actualSize: number,
    expectedSize: number,
    contentId: string
): void {
    if (actualSize !== expectedSize) {
        throw new Error(
            `Content size mismatch for ${contentId}: expected ${expectedSize.toString()} bytes, got ${actualSize.toString()} bytes`
        );
    }
}

export function decryptHashedContent(
    encryptedContent: Buffer,
    titleKey: Buffer,
    iv: Buffer
): Buffer {
    const output = Buffer.alloc(encryptedContent.length);

    for (
        let blockOffset = 0;
        blockOffset < encryptedContent.length;
        blockOffset += HASHED_BLOCK_SIZE
    ) {
        const encryptedBlock = encryptedContent.slice(
            blockOffset,
            Math.min(blockOffset + HASHED_BLOCK_SIZE, encryptedContent.length)
        );
        if (encryptedBlock.length === 0) {
            continue;
        }

        const decryptedHashArea = decryptContentWithIv(
            encryptedBlock.slice(0, HASHED_BLOCK_DATA_OFFSET),
            titleKey,
            iv
        );
        const dataIv = decryptedHashArea.slice(0, AES_BLOCK_SIZE);
        const decryptedDataArea = decryptContentWithIv(
            encryptedBlock.slice(HASHED_BLOCK_DATA_OFFSET),
            titleKey,
            dataIv
        );

        output.set(decryptedHashArea, blockOffset);
        output.set(decryptedDataArea, blockOffset + HASHED_BLOCK_DATA_OFFSET);
    }

    return output;
}

export function extractHashedContentSlice(
    buffer: Buffer,
    logicalOffset: number,
    length: number
): Buffer | null {
    if (logicalOffset < 0 || length < 0) {
        return null;
    }
    const output = Buffer.alloc(length);
    let sourceOffset = logicalOffset;
    let targetOffset = 0;
    let remaining = length;

    while (remaining > 0) {
        const blockIndex = Math.floor(sourceOffset / HASHED_BLOCK_DATA_SIZE);
        const blockDataOffset = sourceOffset % HASHED_BLOCK_DATA_SIZE;
        const physicalOffset =
            blockIndex * HASHED_BLOCK_SIZE +
            HASHED_BLOCK_DATA_OFFSET +
            blockDataOffset;
        const chunkSize = Math.min(
            remaining,
            HASHED_BLOCK_DATA_SIZE - blockDataOffset
        );

        if (physicalOffset + chunkSize > buffer.length) {
            return null;
        }
        output.set(
            buffer.slice(physicalOffset, physicalOffset + chunkSize),
            targetOffset
        );
        sourceOffset += chunkSize;
        targetOffset += chunkSize;
        remaining -= chunkSize;
    }

    return output;
}

async function verifyContentTree({
    appChunks,
    h3,
    content,
    titleKey,
    contentId,
    signal,
}: {
    appChunks: AsyncIterable<Buffer>;
    h3: Buffer;
    content: TmdContent;
    titleKey: Buffer;
    contentId: string;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    try {
        throwIfAborted(signal);
        await verifyEncryptedContentTree({
            appChunks,
            h3,
            content,
            titleKey,
            signal,
        });

        return {
            contentId,
            status: 'ok',
        };
    } catch (error) {
        throwIfAborted(signal);
        return {
            contentId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function verifyContentHash({
    appChunks,
    content,
    titleKey,
    contentId,
    signal,
}: {
    appChunks: AsyncIterable<Buffer>;
    content: TmdContent;
    titleKey: Buffer;
    contentId: string;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    try {
        throwIfAborted(signal);
        const actualHash = await hashDecryptedContent(
            appChunks,
            titleKey,
            content.index,
            content.size,
            signal
        );

        assertHashEquals(
            actualHash,
            content.hash.slice(0, HASH_ENTRY_SIZE),
            `Content hash mismatch for ${contentId}`
        );

        return {
            contentId,
            status: 'ok',
        };
    } catch (error) {
        throwIfAborted(signal);
        return {
            contentId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function hashDecryptedContent(
    appChunks: AsyncIterable<Buffer>,
    titleKey: Buffer,
    contentIndex: number,
    contentSize: number,
    signal?: AbortSignal
): Promise<Buffer> {
    throwIfAborted(signal);
    const decipher = createDecipheriv(
        'aes-128-cbc',
        Buffer.from(titleKey),
        Buffer.from(createContentIv(contentIndex))
    );
    decipher.setAutoPadding(false);

    const hash = createHash('sha1');
    let remaining = contentSize;

    for await (const chunk of appChunks) {
        throwIfAborted(signal);
        const decrypted = decipher.update(chunk);
        const hashLength = Math.min(remaining, decrypted.length);

        if (hashLength > 0) {
            hash.update(decrypted.subarray(0, hashLength));
            remaining -= hashLength;
        }
    }

    throwIfAborted(signal);
    const final = decipher.final();
    const finalHashLength = Math.min(remaining, final.length);
    if (finalHashLength > 0) {
        hash.update(final.subarray(0, finalHashLength));
        remaining -= finalHashLength;
    }

    if (remaining !== 0) {
        throw new Error(
            `Decrypted content was shorter than expected: missing ${remaining.toString()} bytes`
        );
    }

    return hash.digest();
}

async function verifyEncryptedContentTree({
    appChunks,
    h3,
    content,
    titleKey,
    signal,
}: {
    appChunks: AsyncIterable<Buffer>;
    h3: Buffer;
    content: TmdContent;
    titleKey: Buffer;
    signal?: AbortSignal;
}): Promise<void> {
    throwIfAborted(signal);
    assertHashEquals(
        sha1(h3),
        content.hash.slice(0, HASH_ENTRY_SIZE),
        'TMD H3 hash mismatch'
    );

    let pending = Buffer.alloc(0);
    let blockIndex = 0;

    for await (const chunk of appChunks) {
        throwIfAborted(signal);
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= HASHED_BLOCK_SIZE) {
            verifyEncryptedContentTreeBlock(
                pending.subarray(0, HASHED_BLOCK_SIZE),
                h3,
                titleKey,
                blockIndex
            );
            pending = pending.subarray(HASHED_BLOCK_SIZE);
            blockIndex += 1;
        }
    }

    if (pending.length > 0) {
        verifyEncryptedContentTreeBlock(pending, h3, titleKey, blockIndex);
    }
}

function verifyEncryptedContentTreeBlock(
    encryptedBlock: Buffer,
    h3: Buffer,
    titleKey: Buffer,
    blockIndex: number
): void {
    const hashArea = decryptContentWithIv(
        encryptedBlock.slice(0, HASHED_BLOCK_DATA_OFFSET),
        titleKey,
        Buffer.alloc(AES_BLOCK_SIZE)
    );
    const h0Index = blockIndex % HASH_ENTRIES_PER_LEVEL;
    const dataIv = hashArea.slice(
        HASH_H0_START + h0Index * HASH_ENTRY_SIZE,
        HASH_H0_START + h0Index * HASH_ENTRY_SIZE + AES_BLOCK_SIZE
    );
    const dataArea = decryptContentWithIv(
        encryptedBlock.slice(HASHED_BLOCK_DATA_OFFSET),
        titleKey,
        dataIv
    );

    verifyHashArea(hashArea, dataArea, h3, blockIndex);
}

function verifyHashArea(
    hashArea: Buffer,
    dataArea: Buffer,
    h3: Buffer,
    blockIndex: number
): void {
    const h0 = hashArea.slice(HASH_H0_START, HASH_H1_START);
    const h1 = hashArea.slice(HASH_H1_START, HASH_H2_START);
    const h2 = hashArea.slice(HASH_H2_START, HASH_H2_END);
    const h0Index = blockIndex % HASH_ENTRIES_PER_LEVEL;
    const h1Index =
        Math.floor(blockIndex / HASH_ENTRIES_PER_LEVEL) %
        HASH_ENTRIES_PER_LEVEL;
    const h2Index =
        Math.floor(
            blockIndex / (HASH_ENTRIES_PER_LEVEL * HASH_ENTRIES_PER_LEVEL)
        ) % HASH_ENTRIES_PER_LEVEL;
    const h3Index =
        Math.floor(
            blockIndex /
                (HASH_ENTRIES_PER_LEVEL *
                    HASH_ENTRIES_PER_LEVEL *
                    HASH_ENTRIES_PER_LEVEL)
        ) * HASH_ENTRY_SIZE;

    assertHashEquals(
        sha1(dataArea),
        h0.slice(h0Index * HASH_ENTRY_SIZE, (h0Index + 1) * HASH_ENTRY_SIZE),
        `H0 mismatch at block ${blockIndex}`
    );
    assertHashEquals(
        sha1(h0),
        h1.slice(h1Index * HASH_ENTRY_SIZE, (h1Index + 1) * HASH_ENTRY_SIZE),
        `H1 mismatch at block ${blockIndex}`
    );
    assertHashEquals(
        sha1(h1),
        h2.slice(h2Index * HASH_ENTRY_SIZE, (h2Index + 1) * HASH_ENTRY_SIZE),
        `H2 mismatch at block ${blockIndex}`
    );
    assertHashEquals(
        sha1(h2),
        h3.slice(h3Index, h3Index + HASH_ENTRY_SIZE),
        `H3 mismatch at block ${blockIndex}`
    );
}

function sha1(value: Buffer): Buffer {
    return createHash('sha1').update(value).digest();
}

function assertHashEquals(
    actual: Buffer,
    expected: Buffer,
    message: string
): void {
    if (expected.length !== actual.length) {
        throw new Error(`${message}: expected hash is missing`);
    }

    for (let i = 0; i < actual.length; i += 1) {
        if (actual[i] !== expected[i]) {
            throw new Error(message);
        }
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
