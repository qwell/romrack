import { createDecipheriv, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createContentIv, decryptContentWithIv } from '../decryption.js';
import logger from '../../shared/logger.js';
import { type TmdContent } from './tmd.js';
import { isHttpErrorStatus } from '../../shared/download.js';

export type ContentInstallFiles = {
    contentId: string;
    appName: string;
    appFile: string;
    h3Name: string | null;
    h3File: string | null;
};

export type ContentTreeVerification = {
    contentId: string;
    status: 'ok' | 'failed' | 'missing-h3';
    error?: string;
    cached?: boolean;
};

export type ContentFileDownload = (targetFile: string) => Promise<void>;

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

export function getContentInstallFiles(
    dirPath: string,
    content: TmdContent
): ContentInstallFiles {
    const contentId = formatContentId(content.id);
    const appName = `${contentId}.app`;
    const h3Name = isHashedContent(content) ? `${contentId}.h3` : null;

    return {
        contentId,
        appName,
        appFile: path.join(dirPath, appName),
        h3Name,
        h3File: h3Name ? path.join(dirPath, h3Name) : null,
    };
}

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

export function verifyContentInstallFiles({
    files,
    content,
    titleKey,
    signal,
}: {
    files: ContentInstallFiles;
    content: TmdContent;
    titleKey: Uint8Array;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    throwIfAborted(signal);
    if (isHashedContent(content)) {
        if (!files.h3File) {
            return Promise.resolve({
                contentId: files.contentId,
                status: 'failed',
                error: 'Missing H3 file path for hashed content',
            });
        }

        return verifyContentTree({
            appFile: files.appFile,
            h3File: files.h3File,
            content,
            titleKey,
            contentId: files.contentId,
            signal,
        });
    }

    return verifyContentHash({
        appFile: files.appFile,
        content,
        titleKey,
        contentId: files.contentId,
        signal,
    });
}

export async function ensureContentInstallFiles({
    files,
    content,
    titleKey,
    download,
    downloadApp,
    downloadH3,
    signal,
}: {
    files: ContentInstallFiles;
    content: TmdContent;
    titleKey: Uint8Array;
    download?: ContentFileDownload;
    downloadApp?: ContentFileDownload;
    downloadH3?: ContentFileDownload;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    throwIfAborted(signal);
    if (isHashedContent(content)) {
        if (!files.h3File || !downloadApp || !downloadH3) {
            return {
                contentId: files.contentId,
                status: 'failed',
                error: 'Missing hashed content install inputs',
            };
        }

        return ensureContentTree({
            appFile: files.appFile,
            h3File: files.h3File,
            content,
            titleKey,
            contentId: files.contentId,
            downloadApp,
            downloadH3,
            signal,
        });
    }

    if (!download) {
        return {
            contentId: files.contentId,
            status: 'failed',
            error: 'Missing content download input',
        };
    }

    return ensureContentHash({
        appFile: files.appFile,
        content,
        titleKey,
        contentId: files.contentId,
        download,
        signal,
    });
}

export async function assertExistingContentFileSize(
    appFile: string,
    expectedSize: number,
    contentId: string
): Promise<void> {
    const { size } = await stat(appFile);
    if (size !== expectedSize) {
        throw new Error(
            `Content size mismatch for ${contentId}: expected ${expectedSize.toString()} bytes, got ${size} bytes`
        );
    }
}

export function decryptHashedContent(
    encryptedContent: Uint8Array,
    titleKey: Uint8Array,
    iv: Uint8Array
): Uint8Array {
    const output = new Uint8Array(encryptedContent.length);

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
    buffer: Uint8Array,
    logicalOffset: number,
    length: number
): Uint8Array | null {
    if (logicalOffset < 0 || length < 0) {
        return null;
    }
    const output = new Uint8Array(length);
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

async function ensureContentTree({
    appFile,
    h3File,
    content,
    titleKey,
    contentId,
    downloadApp,
    downloadH3,
    signal,
}: {
    appFile: string;
    h3File: string;
    content: TmdContent;
    titleKey: Uint8Array;
    contentId: string;
    downloadApp: ContentFileDownload;
    downloadH3: ContentFileDownload;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    throwIfAborted(signal);
    const existing = await verifyContentTree({
        appFile,
        h3File,
        content,
        titleKey,
        contentId,
        signal,
    });

    if (existing.status === 'ok') {
        logExistingContentSkipped(contentId, content.size);
        return {
            ...existing,
            cached: true,
        };
    }

    logExistingContentInvalid(contentId, existing.error);
    throwIfAborted(signal);

    const h3Downloaded = await downloadH3(h3File)
        .then(() => true)
        .catch((error: unknown) => {
            if (isHttpErrorStatus(error, 404)) {
                return false;
            }

            throw error;
        });

    if (!h3Downloaded) {
        return {
            contentId,
            status: 'missing-h3',
        };
    }

    throwIfAborted(signal);
    await downloadApp(appFile);
    throwIfAborted(signal);

    const verification = await verifyContentTree({
        appFile,
        h3File,
        content,
        titleKey,
        contentId,
        signal,
    });

    return verification.status === 'ok'
        ? {
              ...verification,
              cached: false,
          }
        : verification;
}

async function verifyContentTree({
    appFile,
    h3File,
    content,
    titleKey,
    contentId,
    signal,
}: {
    appFile: string;
    h3File: string;
    content: TmdContent;
    titleKey: Uint8Array;
    contentId: string;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    try {
        throwIfAborted(signal);
        await assertExistingContentFileSize(
            appFile,
            getEncryptedContentFileSize(content),
            contentId
        );
        throwIfAborted(signal);
        await verifyEncryptedContentTreeFile({
            appFile,
            h3File,
            content,
            titleKey,
            signal,
        });

        return {
            contentId,
            status: 'ok',
        };
    } catch (error) {
        return {
            contentId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function ensureContentHash({
    appFile,
    content,
    titleKey,
    contentId,
    download,
    signal,
}: {
    appFile: string;
    content: TmdContent;
    titleKey: Uint8Array;
    contentId: string;
    download: ContentFileDownload;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    throwIfAborted(signal);
    const existing = await verifyContentHash({
        appFile,
        content,
        titleKey,
        contentId,
        signal,
    });

    if (existing.status === 'ok') {
        logExistingContentSkipped(contentId, content.size);
        return {
            ...existing,
            cached: true,
        };
    }

    logExistingContentInvalid(contentId, existing.error);
    throwIfAborted(signal);

    await download(appFile);
    throwIfAborted(signal);

    const verification = await verifyContentHash({
        appFile,
        content,
        titleKey,
        contentId,
        signal,
    });

    return verification.status === 'ok'
        ? {
              ...verification,
              cached: false,
          }
        : verification;
}

async function verifyContentHash({
    appFile,
    content,
    titleKey,
    contentId,
    signal,
}: {
    appFile: string;
    content: TmdContent;
    titleKey: Uint8Array;
    contentId: string;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    try {
        throwIfAborted(signal);
        await assertExistingContentFileSize(
            appFile,
            getEncryptedContentFileSize(content),
            contentId
        );
        throwIfAborted(signal);
        const actualHash = await hashDecryptedContentFile(
            appFile,
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
        return {
            contentId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function logExistingContentSkipped(contentId: string, size: number): void {
    logger.log(
        'download',
        `content ${contentId} (${size.toString()} bytes, cached)`
    );
}

function logExistingContentInvalid(
    contentId: string,
    error: string | undefined
): void {
    if (error?.includes('ENOENT')) {
        logger.log('download', `content not found, downloading: ${contentId}`);
        return;
    }
    logger.log(
        'download',
        `cached content invalid, redownloading: ${contentId}${error ? ` (${error})` : ''}`
    );
}

async function hashDecryptedContentFile(
    appFile: string,
    titleKey: Uint8Array,
    contentIndex: number,
    contentSize: number,
    signal?: AbortSignal
): Promise<Uint8Array> {
    throwIfAborted(signal);
    const decipher = createDecipheriv(
        'aes-128-cbc',
        Buffer.from(titleKey),
        Buffer.from(createContentIv(contentIndex))
    );
    decipher.setAutoPadding(false);

    const hash = createHash('sha1');
    let remaining = contentSize;

    for await (const chunk of readFileChunks(appFile, signal)) {
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

    return new Uint8Array(hash.digest());
}

async function hashFileWithSignal(
    filePath: string,
    signal?: AbortSignal
): Promise<Uint8Array> {
    const hash = createHash('sha1');
    for await (const chunk of readFileChunks(filePath, signal)) {
        throwIfAborted(signal);
        hash.update(chunk);
    }

    return new Uint8Array(hash.digest());
}

async function* readFileChunks(
    filePath: string,
    signal?: AbortSignal
): AsyncGenerator<Buffer> {
    const stream = createReadStream(filePath);
    const abort = () =>
        stream.destroy(
            signal?.reason instanceof Error ? signal.reason : undefined
        );
    signal?.addEventListener('abort', abort, { once: true });
    try {
        for await (const chunk of stream) {
            throwIfAborted(signal);
            yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

async function verifyEncryptedContentTreeFile({
    appFile,
    h3File,
    content,
    titleKey,
    signal,
}: {
    appFile: string;
    h3File: string;
    content: TmdContent;
    titleKey: Uint8Array;
    signal?: AbortSignal;
}): Promise<void> {
    throwIfAborted(signal);
    const [h3, h3Hash] = await Promise.all([
        readFile(h3File),
        hashFileWithSignal(h3File, signal),
    ]);
    throwIfAborted(signal);

    assertHashEquals(
        h3Hash,
        content.hash.slice(0, HASH_ENTRY_SIZE),
        'TMD H3 hash mismatch'
    );

    let pending = Buffer.alloc(0);
    let blockIndex = 0;

    for await (const chunk of readFileChunks(appFile, signal)) {
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
    encryptedBlock: Uint8Array,
    h3: Uint8Array,
    titleKey: Uint8Array,
    blockIndex: number
): void {
    const hashArea = decryptContentWithIv(
        encryptedBlock.slice(0, HASHED_BLOCK_DATA_OFFSET),
        titleKey,
        new Uint8Array(AES_BLOCK_SIZE)
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
    hashArea: Uint8Array,
    dataArea: Uint8Array,
    h3: Uint8Array,
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

function sha1(value: Uint8Array): Uint8Array {
    return new Uint8Array(createHash('sha1').update(value).digest());
}

function assertHashEquals(
    actual: Uint8Array,
    expected: Uint8Array,
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
