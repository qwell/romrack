import path from 'path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import {
    createContentIv,
    createTitleKeyIv,
    decryptContentWithIv,
} from './decryption.js';
import {
    DEFAULT_CERT_TITLE_ID,
    NUS_BASE_URL,
    downloadContent,
    downloadContentH3,
    downloadContentH3ToFile,
    downloadContentToFile,
    downloadTicket,
    downloadTmd,
    getContentH3Url,
    getContentUrl,
    getTicketUrl,
    getTmdUrl,
} from './download-title.js';
import {
    formatContentId,
    decryptHashedContent,
    extractHashedContentSlice,
    getContentInstallFiles,
    getContentH3FileSize,
    getEncryptedContentFileSize,
    isHashedContent,
    type ContentInstallFiles,
    type ContentTreeVerification,
} from './nus/content.js';
import { parseTitleFstEntries, type TitleFstEntry } from './nus/fst.js';
import {
    findXmlStartByte,
    readMetaXml,
    readMetaXmlJson,
    type NUSTitleInformation,
} from './nus/meta.js';
import {
    getTitleIdHex,
    getTitleIdNumber,
    readTmdCertificate,
    readTmdFromBuffer,
    readTmdHeader,
    TMD_TITLE_FILE,
    type Tmd,
    type TmdContent,
} from './nus/tmd.js';
import { getUserAppRoot } from './paths.js';
import {
    classifyTitleId,
    normalizeTitleId,
    replaceTitleKind,
    TitleKinds,
} from '../shared/titles.js';
import logger from '../shared/logger.js';
import { resolveTitleKey } from './install-title.js';
import { isHttpErrorStatus } from '../shared/download.js';
import { readOptionalFile } from '../shared/file.js';

export {
    downloadContent,
    downloadContentH3,
    downloadTicket,
    downloadTmd,
    formatContentId,
    getContentInstallFiles,
    getContentH3Url,
    getContentUrl,
    getEncryptedContentFileSize,
    getTicketUrl,
    getTmdUrl,
    getTitleIdHex,
    getTitleIdNumber,
    readTmdCertificate,
    readTmdFromBuffer,
    readTmdHeader,
    readMetaXml,
    readMetaXmlJson,
    type NUSTitleInformation,
    type ContentTreeVerification,
    isHashedContent,
    type ContentInstallFiles,
    type Tmd,
    type TmdContent,
};

export type Tik = {
    titleId: Uint8Array;
    titleVersion: number | null;
    encryptedKey: Uint8Array;
    cert0: Uint8Array | null;
    cert1: Uint8Array | null;
};

export type GeneratedTikInput = {
    titleId: Uint8Array;
    encryptedTitleKey: Uint8Array;
    titleVersion: number;
};

export type NusTitleMetadata = {
    titleId: string;
    titleVersion: number;
    name: string | null;
    region: string | null;
    productCode: string | null;
    companyCode: string | null;
    titleKey: Uint8Array | null;
    titleKeyPassword: string | null;
    metaJson: Record<string, unknown> | null;
};

export type ChildTitleMetadata = {
    titleId: string;
    childTitleId: string;
    exists: boolean;
    titleVersion: number | null;
};

export type GeneratedTitleInstallFiles = {
    titleId: string;
    kind: DownloadableTitleKind;
    name: string;
    titleVersion: number;
    titleKey: string;
    titleKeyPassword: string | null;
    outputDir: string;
    sizeBytes: number;
    files: {
        tmd: string;
        tik: string;
        cert: string;
        app: string[];
        h3: string[];
    };
};

export type DownloadableTitle = {
    titleId: string;
    kind: DownloadableTitleKind;
};

export type DownloadableTitleKind =
    | TitleKinds.Base
    | TitleKinds.Update
    | TitleKinds.DLC;

export function formatInstallDirectoryKind(
    kind: DownloadableTitle['kind']
): string {
    return kind === TitleKinds.Base ? 'Game' : kind;
}

type DownloadedContentFile = {
    app: string | null;
    h3: string | null;
    cachedFiles: number;
};

export type TitleDownloadProgress = {
    outputDir: string;
    completedFiles: number;
    totalFiles: number;
    currentFileName: string | null;
    currentFileSizeBytes: number;
};

type InstalledTitleCheckResult = {
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    error: string | null;
    failedFileCount: number;
    totalFileCount: number;
};

export type InstalledTitleVerification = InstalledTitleCheckResult & {
    verification: ContentTreeVerification[];
};

export type InstalledTitleValidation = InstalledTitleCheckResult;

export type InstalledTitleVerificationProgress = {
    currentFileName: string;
    currentFileSizeBytes: number;
};

export class TitleMetadataError extends Error {
    stage: string;

    constructor(stage: string, message: string) {
        super(message);
        this.name = 'TitleMetadataError';
        this.stage = stage;
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}

type FstEntry = TitleFstEntry;

export const TIK_TITLE_FILE = 'title.tik';
export const CERT_TITLE_FILE = 'title.cert';

const COMMON_KEY_SIZE = 16;

const TIK_TITLE_ID_OFFSET = 0x1dc;
const TIK_TITLE_ID_SIZE = 8;
const TIK_VERSION_OFFSET = 0x1e6;
const TIK_VERSION_SIZE = 2;
const TIK_ENCRYPTED_KEY_OFFSET = 0x1bf;
const TIK_ENCRYPTED_KEY_SIZE = 16;
const TIK_CERT_1_OFFSET = 0x350;
const TIK_CERT_1_SIZE = 0x300;
const TIK_CERT_0_OFFSET = 0x650;
const TIK_CERT_0_SIZE = 0x400;

const GENERATED_TIK_TEMPLATE_SIZE = TIK_VERSION_OFFSET + TIK_VERSION_SIZE;
const GENERATED_TIK_TEMPLATE = new Uint8Array([
    0x00, 0x01, 0x00, 0x04, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed,
    0x15, 0xab, 0xe1, 0x1a, 0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a,
    0xd1, 0x5e, 0xa5, 0xed, 0x15, 0xab, 0xe1, 0x1a, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x52, 0x6f, 0x6f, 0x74,
    0x2d, 0x43, 0x41, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x33, 0x2d,
    0x58, 0x53, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x63, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce,
    0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce,
    0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce,
    0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce,
    0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce, 0xfe, 0xed, 0xfa, 0xce,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const TITLE_CERT_AUTHORITY_OFFSET = 0x350;
const TITLE_CERT_AUTHORITY_SIZE = 0x300;

const COMMON_KEY_DOWNLOAD_URLS_BASE64 = [
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9FbXJhbkFobTNkL2JkN2E3OTFkMDI5NzVkNzE4NmQwYzA1NTRmM2NmNmVhL3Jhdy8xYzM4MzM1ZjJhNzFhYjQyNDVkMjM3NjE4YzRmYWZlNjcwZWUzZTgyL3dpaXVjb21tb25rZXkudHh0',
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9xd2VsbC80NWJhN2QyZjMwNWRlNzJhODFkYjlkNzUxOTA4MTE3YS9yYXcvMWMzODMzNWYyYTcxYWI0MjQ1ZDIzNzYxOGM0ZmFmZTY3MGVlM2U4Mi93aWl1Y29tbW9ua2V5LnR4dA==',
] as const;

let commonKeyPromise: Promise<Uint8Array> | null = null;
let defaultCertPromise: Promise<Uint8Array> | null = null;

export async function downloadNusBaseMetadata(
    titleId: string
): Promise<NusTitleMetadata | null> {
    const normalizedTitleId = replaceTitleKind(titleId, TitleKinds.Base);

    return downloadNusTitleMetadata(normalizedTitleId);
}

export async function downloadNusTitleMetadata(
    titleId: string
): Promise<NusTitleMetadata | null> {
    const baseUrl = NUS_BASE_URL;
    const [tik, tmdBytes] = await Promise.all([
        downloadTicket(baseUrl, titleId).catch((error: unknown) => {
            logger.warn(
                'metadata',
                `failed to download ticket for ${titleId}: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
        }),
        downloadOptionalTitleFile(() => downloadTmd(baseUrl, titleId)),
    ]);

    if (!tmdBytes) {
        return null;
    }

    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));
    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${titleId}`
        );
    }

    const ticket = tik ? readTikFromBuffer(Buffer.from(tik)) : null;
    const fstContent = tmd.contents[0];
    if (!fstContent) {
        logger.warn(
            'metadata',
            `TMD has no first content entry for ${titleId}`
        );
        return createBasicNusTitleMetadata(titleId, tmd);
    }

    try {
        const commonKey = await readCommonKey();
        const encryptedFst = await downloadContent(
            baseUrl,
            titleId,
            fstContent.id
        );
        const { titleKey, decryptedFst, titleKeyPassword } = resolveTitleKey({
            commonKey,
            encryptedFst,
            normalizedTitleId: titleId,
            ticket,
            tmd,
        });
        const metaXml = await extractMetaXmlFromTitle(
            decryptedFst,
            tmd,
            titleKey,
            baseUrl,
            titleId
        );
        const metaJson = metaXml ? readMetaXmlJson(metaXml) : null;
        const meta = metaXml ? readMetaXml(metaXml) : null;

        return {
            ...createBasicNusTitleMetadata(titleId, tmd),
            name: meta?.name ?? null,
            region: meta?.region ?? null,
            productCode: meta?.productCode ?? null,
            companyCode: meta?.companyCode ?? null,
            titleKey,
            titleKeyPassword,
            metaJson,
        };
    } catch (error) {
        logger.warn(
            'metadata',
            `failed to enrich metadata for ${titleId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return createBasicNusTitleMetadata(titleId, tmd);
    }
}

async function downloadOptionalTitleFile(
    download: () => Promise<Uint8Array>
): Promise<Uint8Array | null> {
    try {
        return await download();
    } catch (error) {
        if (isHttpErrorStatus(error, 404)) {
            return null;
        }
        throw error;
    }
}

function createBasicNusTitleMetadata(
    titleId: string,
    tmd: Tmd
): NusTitleMetadata {
    return {
        titleId,
        titleVersion: tmd.header.titleVersion,
        name: null,
        region: null,
        productCode: null,
        companyCode: null,
        titleKey: null,
        titleKeyPassword: null,
        metaJson: null,
    };
}

export async function getUpdateMetadata(
    baseTitleId: string
): Promise<ChildTitleMetadata> {
    return getChildTitleMetadata(
        baseTitleId,
        replaceTitleKind(baseTitleId, TitleKinds.Update)
    );
}

export async function getDlcMetadata(
    baseTitleId: string
): Promise<ChildTitleMetadata> {
    return getChildTitleMetadata(
        baseTitleId,
        replaceTitleKind(baseTitleId, TitleKinds.DLC)
    );
}

export async function downloadTitleContentFile({
    content,
    outputDir,
    baseUrl,
    titleId,
    onFileStart,
    onFileComplete,
    signal,
}: {
    content: TmdContent;
    outputDir: string;
    baseUrl: string;
    titleId: string;
    onFileStart?: (fileName: string, fileSizeBytes: number) => void;
    onFileComplete?: (fileName: string, fileSizeBytes: number) => void;
    signal?: AbortSignal;
}): Promise<DownloadedContentFile> {
    throwIfAborted(signal);
    const files = getContentInstallFiles(outputDir, content);
    const appSizeBytes = Number(getEncryptedContentFileSize(content));

    if (!isHashedContent(content)) {
        const cached = await hasExpectedFileSize(files.appFile, appSizeBytes);
        if (!cached) {
            onFileStart?.(files.appName, appSizeBytes);
            await downloadContentToFile(
                baseUrl,
                titleId,
                content.id,
                files.appFile,
                signal
            );
            onFileComplete?.(files.appName, appSizeBytes);
        }

        return {
            app: files.appName,
            h3: null,
            cachedFiles: cached ? 1 : 0,
        };
    }

    const h3SizeBytes = getContentH3FileSize(content);
    if (!files.h3File || !files.h3Name) {
        return {
            app: null,
            h3: null,
            cachedFiles: 0,
        };
    }

    const appCached = await hasExpectedFileSize(files.appFile, appSizeBytes);
    const h3Cached = await hasExpectedFileSize(files.h3File, h3SizeBytes);
    if (!h3Cached) {
        onFileStart?.(files.h3Name, h3SizeBytes);
        const h3Downloaded = await downloadContentH3ToFile(
            baseUrl,
            titleId,
            content.id,
            files.h3File,
            signal
        )
            .then(() => true)
            .catch((error: unknown) => {
                if (isHttpErrorStatus(error, 404)) {
                    return false;
                }
                throw error;
            });
        if (!h3Downloaded) {
            return {
                app: null,
                h3: null,
                cachedFiles: Number(appCached),
            };
        }
        onFileComplete?.(files.h3Name, h3SizeBytes);
    }

    if (!appCached) {
        onFileStart?.(files.appName, appSizeBytes);
        await downloadContentToFile(
            baseUrl,
            titleId,
            content.id,
            files.appFile,
            signal
        );
        onFileComplete?.(files.appName, appSizeBytes);
    }

    return {
        app: files.appName,
        h3: files.h3Name,
        cachedFiles: Number(appCached) + Number(h3Cached),
    };
}

async function hasExpectedFileSize(
    filePath: string,
    expectedSize: number
): Promise<boolean> {
    try {
        const file = await stat(filePath);
        return file.size === expectedSize;
    } catch {
        return false;
    }
}

export function readTikFromBuffer(buffer: Buffer): Tik | null {
    if (buffer.length < TIK_VERSION_OFFSET + TIK_VERSION_SIZE) {
        return null;
    }
    return {
        titleId: new Uint8Array(
            buffer.subarray(
                TIK_TITLE_ID_OFFSET,
                TIK_TITLE_ID_OFFSET + TIK_TITLE_ID_SIZE
            )
        ),
        titleVersion: buffer.readUintBE(TIK_VERSION_OFFSET, TIK_VERSION_SIZE),
        encryptedKey: new Uint8Array(
            buffer.subarray(
                TIK_ENCRYPTED_KEY_OFFSET,
                TIK_ENCRYPTED_KEY_OFFSET + TIK_ENCRYPTED_KEY_SIZE
            )
        ),
        cert0:
            buffer.length >= TIK_CERT_0_OFFSET + TIK_CERT_0_SIZE
                ? new Uint8Array(
                      buffer.subarray(
                          TIK_CERT_0_OFFSET,
                          TIK_CERT_0_OFFSET + TIK_CERT_0_SIZE
                      )
                  )
                : null,
        cert1:
            buffer.length >= TIK_CERT_1_OFFSET + TIK_CERT_1_SIZE
                ? new Uint8Array(
                      buffer.subarray(
                          TIK_CERT_1_OFFSET,
                          TIK_CERT_1_OFFSET + TIK_CERT_1_SIZE
                      )
                  )
                : null,
    };
}

export async function readTikHeader(dirPath: string): Promise<Tik | null> {
    const buffer = await readOptionalFile(path.join(dirPath, TIK_TITLE_FILE));
    return buffer ? readTikFromBuffer(buffer) : null;
}

export function createGeneratedTik({
    titleId,
    encryptedTitleKey,
    titleVersion,
}: GeneratedTikInput): Uint8Array {
    assertByteLength(titleId, TIK_TITLE_ID_SIZE, 'titleId');
    assertByteLength(
        encryptedTitleKey,
        TIK_ENCRYPTED_KEY_SIZE,
        'encryptedTitleKey'
    );
    assertUint16(titleVersion, 'titleVersion');

    if (GENERATED_TIK_TEMPLATE.length < GENERATED_TIK_TEMPLATE_SIZE) {
        throw new Error(
            `Generated ticket template too small: got ${GENERATED_TIK_TEMPLATE.length}, need ${GENERATED_TIK_TEMPLATE_SIZE}`
        );
    }

    const ticket = Buffer.from(GENERATED_TIK_TEMPLATE);
    Buffer.from(encryptedTitleKey).copy(ticket, TIK_ENCRYPTED_KEY_OFFSET);
    Buffer.from(titleId).copy(ticket, TIK_TITLE_ID_OFFSET);
    ticket.writeUInt16BE(titleVersion, TIK_VERSION_OFFSET);

    return new Uint8Array(ticket);
}

export async function writeGeneratedTik(
    dirPath: string,
    input: GeneratedTikInput
): Promise<void> {
    await writeFile(
        path.join(dirPath, TIK_TITLE_FILE),
        createGeneratedTik(input)
    );
}

export type GeneratedCertOptions = {
    ticketBytes?: Uint8Array | null;
};

export async function createGeneratedCert(
    tmd: Tmd,
    options: GeneratedCertOptions = {}
): Promise<Uint8Array> {
    const { certificate1, certificate2 } = tmd.certificates;

    if (!certificate1 || !certificate2) {
        throw new TitleMetadataError(
            'generate_cert',
            'TMD is missing certificate data'
        );
    }

    const authorityCert = await resolveTitleCertAuthority(options);

    return new Uint8Array(
        Buffer.concat([
            Buffer.from(certificate1.raw),
            Buffer.from(certificate2.raw),
            Buffer.from(authorityCert),
        ])
    );
}

export async function readTmd(dirPath: string): Promise<Tmd | null> {
    const buffer = await readOptionalFile(path.join(dirPath, TMD_TITLE_FILE));
    return buffer ? readTmdFromBuffer(buffer) : null;
}

export async function readCommonKey(): Promise<Uint8Array> {
    const commonKeyPath = path.join(getUserAppRoot(), 'common.key');

    if (!commonKeyPromise) {
        const pending = (async () => {
            const raw = await readOptionalFile(commonKeyPath);
            if (!raw) {
                return downloadCommonKey(commonKeyPath);
            }
            const commonKey = parseCommonKey(raw, commonKeyPath);
            logger.log('metadata', `Loaded common key from ${commonKeyPath}`);
            return commonKey;
        })();
        pending.catch(() => {
            if (commonKeyPromise === pending) {
                commonKeyPromise = null;
            }
        });
        commonKeyPromise = pending;
    }
    return commonKeyPromise;
}

function extractTitleCertAuthority(ticket: Uint8Array): Uint8Array | null {
    const end = TITLE_CERT_AUTHORITY_OFFSET + TITLE_CERT_AUTHORITY_SIZE;

    if (ticket.length < end) {
        return null;
    }

    return new Uint8Array(ticket.subarray(TITLE_CERT_AUTHORITY_OFFSET, end));
}

async function resolveTitleCertAuthority(
    options: GeneratedCertOptions
): Promise<Uint8Array> {
    if (options.ticketBytes) {
        const ticketCert = extractTitleCertAuthority(options.ticketBytes);
        if (ticketCert) {
            return ticketCert;
        }
    }

    return readDefaultCert();
}

async function readDefaultCert(): Promise<Uint8Array> {
    if (!defaultCertPromise) {
        const pending = downloadTicket(
            NUS_BASE_URL,
            DEFAULT_CERT_TITLE_ID
        ).then((ticket) => {
            if (
                ticket.length <
                TITLE_CERT_AUTHORITY_OFFSET + TITLE_CERT_AUTHORITY_SIZE
            ) {
                throw new TitleMetadataError(
                    'download_default_cert',
                    `Default cetk too small: got ${ticket.length}`
                );
            }

            return new Uint8Array(
                ticket.subarray(
                    TITLE_CERT_AUTHORITY_OFFSET,
                    TITLE_CERT_AUTHORITY_OFFSET + TITLE_CERT_AUTHORITY_SIZE
                )
            );
        });
        pending.catch(() => {
            if (defaultCertPromise === pending) {
                defaultCertPromise = null;
            }
        });
        defaultCertPromise = pending;
    }

    return defaultCertPromise;
}

async function downloadCommonKey(filePath: string): Promise<Uint8Array> {
    logger.warn(
        'metadata',
        [
            'Wii U common key was not found in any configured location.',
            `Downloading a copy now and saving it to: ${filePath}`,
            'This is a one-time setup step. Future runs will use the saved file instead of downloading it again.',
        ].join('\n')
    );

    const errors: string[] = [];

    for (const [
        index,
        encodedUrl,
    ] of COMMON_KEY_DOWNLOAD_URLS_BASE64.entries()) {
        const url = Buffer.from(encodedUrl, 'base64').toString('utf8');

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const body = new Uint8Array(await response.arrayBuffer());
            const commonKey = parseCommonKey(body, url);

            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, body);
            logger.log('metadata', `Saved common key to ${filePath}`);

            return commonKey;
        } catch (error) {
            errors.push(
                `source ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    throw new Error(
        `common key not found. Failed to download common key. ${errors.join(
            '; '
        )}`
    );
}

function parseCommonKey(raw: Uint8Array, filePath: string): Uint8Array {
    if (raw.length === COMMON_KEY_SIZE) {
        return new Uint8Array(raw);
    }

    const text = Buffer.from(raw).toString('utf8').trim();
    const normalizedText = text.replace(/\s+/g, '');

    const byteLiteralKey = parseCommonKeyByteLiterals(text);
    if (byteLiteralKey) {
        return assertCommonKeyLength(byteLiteralKey, filePath, 'byte literals');
    }

    if (/^[\da-fA-F]+$/.test(normalizedText)) {
        return assertCommonKeyLength(
            new Uint8Array(Buffer.from(normalizedText, 'hex')),
            filePath,
            'hex'
        );
    }

    throw new Error(
        `common key at ${filePath} must be raw binary, hex, or comma-separated byte literals`
    );
}

function parseCommonKeyByteLiterals(text: string): Uint8Array | null {
    const tokens = text
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

    if (
        tokens.length === 0 ||
        !tokens.every((token) => /^0x[\da-fA-F]{1,2}$/.test(token))
    ) {
        return null;
    }

    return new Uint8Array(
        tokens.map((token) => Number.parseInt(token.slice(2), 16))
    );
}

function assertCommonKeyLength(
    commonKey: Uint8Array,
    filePath: string,
    format: string
): Uint8Array {
    if (commonKey.length !== COMMON_KEY_SIZE) {
        throw new Error(
            `common key at ${filePath} decoded from ${format} must be ${COMMON_KEY_SIZE} bytes, got ${commonKey.length}`
        );
    }

    return commonKey;
}

export async function extractMetaXmlFromTitle(
    decryptedFst: Uint8Array,
    tmd: Tmd,
    titleKey: Uint8Array,
    baseUrl: string,
    titleId: string,
    signal?: AbortSignal
): Promise<Uint8Array | null> {
    const entries = parseFstEntries(decryptedFst, tmd);
    const metaEntry =
        entries.find((entry) => entry.fullPath === 'meta/meta.xml') ??
        entries.find((entry) => entry.name === 'meta.xml');

    if (!metaEntry || metaEntry.isDirectory) {
        return null;
    }
    const content = tmd.contents[metaEntry.contentId];
    if (!content) {
        return null;
    }

    const encryptedContent = await downloadContent(
        baseUrl,
        titleId,
        content.id,
        signal
    );
    const decryptedContent = decryptTitleContent(
        encryptedContent,
        titleKey,
        content.index,
        metaEntry.extractWithHash,
        tmd.header.titleId,
        metaEntry
    );
    if (!decryptedContent) {
        return null;
    }
    const extracted = extractFileFromContent(decryptedContent, metaEntry);
    if (!extracted) {
        return null;
    }
    const xmlStart = findXmlStartByte(extracted);
    if (xmlStart < 0) {
        return null;
    }
    return extracted.slice(xmlStart);
}

function decryptTitleContent(
    encryptedContent: Uint8Array,
    titleKey: Uint8Array,
    contentIndex: number,
    extractWithHash: boolean,
    titleId: Uint8Array,
    entry: FstEntry
): Uint8Array | null {
    const decrypt = (iv: Uint8Array) =>
        extractWithHash
            ? decryptHashedContent(encryptedContent, titleKey, iv)
            : decryptContentWithIv(encryptedContent, titleKey, iv);

    const candidates = [
        createContentIv(contentIndex),
        createTitleKeyIv(titleId),
        new Uint8Array(16),
    ];

    for (const iv of candidates) {
        const decrypted = decrypt(iv);
        if (startsWithXml(extractFileFromContent(decrypted, entry))) {
            return decrypted;
        }
    }

    return null;
}

function extractFileFromContent(
    decryptedContent: Uint8Array,
    entry: FstEntry
): Uint8Array | null {
    return entry.extractWithHash
        ? extractHashedContentSlice(
              decryptedContent,
              entry.shiftedFileOffset,
              entry.fileLength
          )
        : sliceRange(
              decryptedContent,
              entry.shiftedFileOffset,
              entry.fileLength
          );
}

function parseFstEntries(decryptedFst: Uint8Array, tmd: Tmd): FstEntry[] {
    return parseTitleFstEntries(decryptedFst, tmd);
}

function startsWithXml(buffer: Uint8Array | null): boolean {
    if (!buffer || buffer.length === 0) {
        return false;
    }
    const text = Buffer.from(
        buffer.subarray(0, Math.min(buffer.length, 16))
    ).toString('latin1');
    return text.includes('<?xml') || text.includes('<menu');
}

function sliceRange(
    buffer: Uint8Array,
    offset: number,
    length: number
): Uint8Array | null {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
        return null;
    }
    return buffer.slice(offset, offset + length);
}

function assertByteLength(
    value: Uint8Array,
    expectedLength: number,
    name: string
): void {
    if (value.length !== expectedLength) {
        throw new Error(
            `${name} must be ${expectedLength} bytes, got ${value.length}`
        );
    }
}

function assertUint16(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new Error(`${name} must be a uint16, got ${value}`);
    }
}

async function getChildTitleMetadata(
    baseTitleId: string,
    titleId: string
): Promise<ChildTitleMetadata> {
    const baseUrl = NUS_BASE_URL;
    const tmdBytes = await downloadOptionalTitleFile(() =>
        downloadTmd(baseUrl, titleId)
    );
    if (!tmdBytes) {
        return {
            titleId: baseTitleId,
            childTitleId: titleId,
            exists: false,
            titleVersion: null,
        };
    }
    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));
    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${titleId}`
        );
    }

    return {
        titleId: baseTitleId,
        childTitleId: titleId,
        exists: true,
        titleVersion: tmd.header.titleVersion,
    };
}

export function normalizeDownloadableTitleId(
    titleId: string
): DownloadableTitle {
    const normalizedTitleId = normalizeTitleId(titleId);

    if (normalizedTitleId.length !== 16) {
        throw new Error(`Invalid titleId: ${titleId}`);
    }

    const { kind } = classifyTitleId(normalizedTitleId);
    if (
        kind !== TitleKinds.Base &&
        kind !== TitleKinds.Update &&
        kind !== TitleKinds.DLC
    ) {
        throw new Error(
            `Unsupported downloadable title kind: ${normalizedTitleId}`
        );
    }

    return { titleId: normalizedTitleId, kind };
}
