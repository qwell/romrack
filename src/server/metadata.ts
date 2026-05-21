import path from 'path';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { XMLParser } from 'fast-xml-parser';
import {
    createContentIv,
    createTitleKeyIv,
    decryptContentWithBigIntIv,
    decryptContentWithIv,
    decryptTitleKey,
    encryptTitleKey,
    findGeneratedTitleKey,
} from './decryption.js';
import { normalizeRegion } from '../shared/regions.js';
import { getUserAppRoot } from './paths.js';
import { getImmediatePathSizeBytes } from '../shared/file.js';
import { normalizeTitleName } from '../shared/titles.js';
import { mapConcurrent } from '../shared/shared.js';
import logger from '../shared/logger.js';

export type Tmd = {
    header: TmdHeader;
    contents: TmdContent[];
    certificates: TmdCertificates;
};

type TmdHeader = {
    titleId: Uint8Array;
    titleVersion: number;
    region: string;
    systemType: SYSTEM_TYPE;
    contentCount: number;
};

type TmdContent = {
    id: number;
    index: number;
    type: number;
    size: bigint;
    hash: Uint8Array;
};

type TmdCertificates = {
    certificate1: TmdCertificateFull | null;
    certificate2: TmdCertificateFull | null;
};

type TmdCertificateFull = {
    raw: Uint8Array;
    parsed: TmdCertificate | null;
};

type TmdCertificate = {
    signatureType: CertificateSignatureType;
    signature: Uint8Array;
    issuer: string;
    keyType: CertificateKeyType;
    name: string;
    keyId: number;
    publicKey: Uint8Array;
};

type CertificateSignatureType =
    | typeof CERT_SIGNATURE_RSA_4096
    | typeof CERT_SIGNATURE_RSA_2048
    | typeof CERT_SIGNATURE_ECC;

type CertificateKeyType =
    | typeof CERT_KEY_RSA_4096
    | typeof CERT_KEY_RSA_2048
    | typeof CERT_KEY_ECC;

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
    kind: 'Base' | 'Update' | 'DLC';
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
    verification: ContentTreeVerification[];
};

type DownloadableTitle = {
    titleId: string;
    kind: 'Base' | 'Update' | 'DLC';
};

export type ContentTreeVerification = {
    contentId: string;
    status: 'ok' | 'missing-h3' | 'failed';
    cached?: boolean;
    error?: string;
};

type DownloadedContentFile = {
    app: string | null;
    h3: string | null;
    verification: ContentTreeVerification;
};

type ResolvedTitleKey = {
    titleKey: Uint8Array;
    decryptedFst: Uint8Array;
    encryptedTitleKey: Uint8Array | null;
    titleKeyPassword: string | null;
};

type ContentInstallFiles = {
    contentId: string;
    appName: string;
    appFile: string;
    h3Name: string | null;
    h3File: string | null;
};

type ContentFileDownload = (targetFile: string) => Promise<void>;

export type TitleDownloadProgress = {
    completedFiles: number;
    totalFiles: number;
    currentFileName: string | null;
};

export type InstalledTitleValidation = {
    titleId: string | null;
    titleVersion: number | null;
    status: 'ok' | 'failed';
    error: string | null;
    verification: ContentTreeVerification[];
};

export type InstalledTitleValidationProgress = {
    currentFileName: string;
};

class TitleMetadataError extends Error {
    stage: string;

    constructor(stage: string, message: string) {
        super(message);
        this.name = 'TitleMetadataError';
        this.stage = stage;
    }
}

class HttpError extends Error {
    status: number;

    constructor(url: string, status: number) {
        super(`download failed for ${url}: HTTP ${status.toString()}`);
        this.name = 'HttpError';
        this.status = status;
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}

export type NUSTitleInformation = {
    name: string | null;
    region: string | null;
    productCode: string | null;
    companyCode: string | null;
    version: number | null;
    titleVersion: number | null;
};

type FstEntry = {
    name: string;
    path: string;
    fullPath: string;
    isDirectory: boolean;
    contentId: number;
    extractWithHash: boolean;
    fileOffset: number;
    shiftedFileOffset: number;
    fileLength: number;
};

const REGION_JPN = 0;
const REGION_USA = 1;
const REGION_EUR = 2;
const REGION_ALL = 3;
const REGION_KOR = 4;

const REGION_JPN_NAME = 'JPN';
const REGION_USA_NAME = 'USA';
const REGION_EUR_NAME = 'EUR';
const REGION_ALL_NAME = 'ALL';
const REGION_KOR_NAME = 'KOR';
const REGION_UNK_NAME = 'UNK';

type SYSTEM_TYPE =
    | typeof SYSTEM_TYPE_WIIU
    | typeof SYSTEM_TYPE_WII
    | typeof SYSTEM_TYPE_UNKNOWN;

const SYSTEM_TYPE_WIIU = 'wiiu';
const SYSTEM_TYPE_WII = 'wii';
const SYSTEM_TYPE_UNKNOWN = 'unknown';

export const TIK_TITLE_FILE = 'title.tik';
const TIK_TITLE_FILE_CDN = 'cetk';
export const TMD_TITLE_FILE = 'title.tmd';
export const CERT_TITLE_FILE = 'title.cert';

const NUS_BASE_URL = 'http://ccs.cdn.wup.shop.nintendo.net/ccs/download';
// const NUS_BASE_URL = 'http://ccs.cdn.c.shop.nintendowifi.net/ccs/download/';
const DEFAULT_CERT_TITLE_ID = '000500101000400a'; // OSv10
const TITLE_DOWNLOAD_CONCURRENCY = 8;

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

const CERT_SIGNATURE_RSA_4096 = 0x00010000;
const CERT_SIGNATURE_RSA_2048 = 0x00010001;
const CERT_SIGNATURE_ECC = 0x00010002;

const CERT_KEY_RSA_4096 = 0x00000000;
const CERT_KEY_RSA_2048 = 0x00000001;
const CERT_KEY_ECC = 0x00000002;

const TMD_TITLE_ID_OFFSET = 0x18c;
const TMD_TITLE_ID_SIZE = 8;
const TMD_VERSION_OFFSET = 0x1dc;
const TMD_VERSION_SIZE = 2;
const TMD_REGION_OFFSET = 0x19c;
const TMD_REGION_SIZE = 2;
const TMD_CONTENT_COUNT_OFFSET = 0x1de;
const TMD_CONTENT_COUNT_SIZE = 2;
const TMD_CONTENT_OFFSET = 0xb04;
const TMD_CONTENT_SIZE = 0x30;
const TMD_CERTIFICATE_1_SIZE = 0x400;
const TMD_CERTIFICATE_2_SIZE = 0x300;

const FST_MAGIC = 'FST';
const FST_ENTRY_SIZE = 0x10;
const FST_CHANGE_OFFSET_FLAG = 0x0004;

const HASHED_BLOCK_SIZE = 0x10000;
const HASHED_BLOCK_DATA_OFFSET = 0x400;
const HASHED_BLOCK_DATA_SIZE = 0xfc00;
const HASH_ENTRY_SIZE = 0x14;
const HASH_ENTRIES_PER_LEVEL = 0x10;
const HASH_H0_START = 0x000;
const HASH_H1_START = 0x140;
const HASH_H2_START = 0x280;
const HASH_H2_END = 0x3c0;
const AES_BLOCK_SIZE = 0x10;

const META_XML_PARSER = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
});

const COMMON_KEY_DOWNLOAD_URLS_BASE64 = [
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9FbXJhbkFobTNkL2JkN2E3OTFkMDI5NzVkNzE4NmQwYzA1NTRmM2NmNmVhL3Jhdy8xYzM4MzM1ZjJhNzFhYjQyNDVkMjM3NjE4YzRmYWZlNjcwZWUzZTgyL3dpaXVjb21tb25rZXkudHh0',
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9xd2VsbC80NWJhN2QyZjMwNWRlNzJhODFkYjlkNzUxOTA4MTE3YS9yYXcvMWMzODMzNWYyYTcxYWI0MjQ1ZDIzNzYxOGM0ZmFmZTY3MGVlM2U4Mi93aWl1Y29tbW9ua2V5LnR4dA==',
] as const;

let commonKeyPromise: Promise<Uint8Array> | null = null;
let defaultCertPromise: Promise<Uint8Array> | null = null;

// -- Public API --

export async function downloadNusTitleMetadata(
    titleId: string
): Promise<NusTitleMetadata | null> {
    const baseUrl = NUS_BASE_URL;
    const normalizedTitleId = replaceTitlePrefix(titleId, 'base');
    const commonKey = await readCommonKey().catch((error: unknown) => {
        throw new TitleMetadataError(
            'read_common_key',
            error instanceof Error ? error.message : 'Failed to read common key'
        );
    });

    const [tik, tmdBytes] = await Promise.all([
        downloadTicket(baseUrl, normalizedTitleId).catch((error: unknown) => {
            if (isHttpErrorStatus(error, 404)) {
                return null;
            }
            throw new TitleMetadataError(
                'download_ticket',
                error instanceof Error
                    ? error.message
                    : `Failed to download ticket for ${normalizedTitleId}`
            );
        }),
        downloadTmd(baseUrl, normalizedTitleId).catch((error: unknown) => {
            throw new TitleMetadataError(
                'download_tmd',
                error instanceof Error
                    ? error.message
                    : `Failed to download TMD for ${normalizedTitleId}`
            );
        }),
    ]);

    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));
    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${normalizedTitleId}`
        );
    }

    const ticket = tik ? readTikFromBuffer(Buffer.from(tik)) : null;
    const fstContent = tmd.contents[0];
    if (!fstContent) {
        throw new TitleMetadataError(
            'missing_fst_content',
            `TMD has no first content entry for ${normalizedTitleId}`
        );
    }
    const encryptedFst = await downloadContent(
        baseUrl,
        normalizedTitleId,
        fstContent.id
    ).catch((error: unknown) => {
        throw new TitleMetadataError(
            'download_fst_content',
            error instanceof Error
                ? error.message
                : `Failed to download FST content for ${normalizedTitleId}`
        );
    });

    const { titleKey, decryptedFst, titleKeyPassword } = resolveTitleKey({
        commonKey,
        encryptedFst,
        normalizedTitleId,
        ticket,
        tmd,
    });

    const metaXml = await extractMetaXmlFromTitle(
        decryptedFst,
        tmd,
        titleKey,
        baseUrl,
        normalizedTitleId
    );
    if (!metaXml) {
        throw new TitleMetadataError(
            'extract_meta_xml',
            `Failed to extract meta.xml for ${normalizedTitleId}`
        );
    }
    const metaJson = metaXml ? readMetaXmlJson(metaXml) : null;
    const meta = metaXml ? readMetaXml(metaXml) : null;
    if (!metaJson) {
        throw new TitleMetadataError(
            'parse_meta_xml',
            `Failed to parse meta.xml for ${normalizedTitleId}`
        );
    }

    return {
        titleId: normalizedTitleId,
        titleVersion: tmd.header.titleVersion,
        name: meta?.name ?? null,
        region: meta?.region ?? null,
        productCode: meta?.productCode ?? null,
        companyCode: meta?.companyCode ?? null,
        titleKey,
        titleKeyPassword,
        metaJson,
    };
}

export async function getUpdateMetadata(
    baseTitleId: string
): Promise<ChildTitleMetadata> {
    return getChildTitleMetadata(
        baseTitleId,
        replaceTitlePrefix(baseTitleId, 'update')
    );
}

export async function getDlcMetadata(
    baseTitleId: string
): Promise<ChildTitleMetadata> {
    return getChildTitleMetadata(
        baseTitleId,
        replaceTitlePrefix(baseTitleId, 'dlc')
    );
}

export async function generateTitleInstallFiles(
    titleId: string,
    romRoot: string,
    options: {
        onProgress?: (progress: TitleDownloadProgress) => void;
        signal?: AbortSignal;
    } = {}
): Promise<GeneratedTitleInstallFiles> {
    const baseUrl = NUS_BASE_URL;
    const { titleId: normalizedTitleId, kind } =
        normalizeDownloadableTitleId(titleId);
    const commonKey = await readCommonKey();
    throwIfAborted(options.signal);
    const tmdBytes = await downloadTmd(
        baseUrl,
        normalizedTitleId,
        options.signal
    );
    throwIfAborted(options.signal);
    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));

    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${normalizedTitleId}`
        );
    }

    const fstContent = tmd.contents[0];
    if (!fstContent) {
        throw new TitleMetadataError(
            'missing_fst_content',
            `TMD has no first content entry for ${normalizedTitleId}`
        );
    }

    const encryptedFst = await downloadContent(
        baseUrl,
        normalizedTitleId,
        fstContent.id,
        options.signal
    );
    throwIfAborted(options.signal);
    const ticketBytes = await downloadTicket(
        baseUrl,
        normalizedTitleId,
        options.signal
    ).catch((error: unknown) => {
        if (isHttpErrorStatus(error, 404)) {
            return null;
        }

        throw error;
    });
    const ticket = ticketBytes
        ? readTikFromBuffer(Buffer.from(ticketBytes))
        : null;
    const { encryptedTitleKey, titleKey, decryptedFst, titleKeyPassword } =
        resolveTitleKey({
            commonKey,
            encryptedFst,
            normalizedTitleId,
            ticket,
            tmd,
        });

    if (
        encryptedTitleKey === null ||
        titleKey === null ||
        decryptedFst === null
    ) {
        throw new TitleMetadataError(
            'resolve_title_key',
            `Failed to produce an encrypted title key for ${normalizedTitleId}`
        );
    }

    const metaXml = await extractMetaXmlFromTitle(
        decryptedFst,
        tmd,
        titleKey,
        baseUrl,
        normalizedTitleId,
        options.signal
    );
    const meta = metaXml ? readMetaXml(metaXml) : null;
    const outputDir = path.join(
        romRoot,
        `${safeDirectoryName(meta?.name ?? normalizedTitleId)} [${kind}] [${normalizedTitleId}]`
    );
    const tmdFile = path.join(outputDir, TMD_TITLE_FILE);
    const certFile = path.join(outputDir, CERT_TITLE_FILE);
    const files = {
        tmd: TMD_TITLE_FILE,
        tik: TIK_TITLE_FILE,
        cert: CERT_TITLE_FILE,
        app: [] as string[],
        h3: [] as string[],
    };
    const verification: ContentTreeVerification[] = [];
    await mkdir(outputDir, { recursive: true });

    await Promise.all([
        writeFile(tmdFile, tmdBytes),
        writeGeneratedTik(outputDir, {
            titleId: tmd.header.titleId,
            encryptedTitleKey,
            titleVersion: tmd.header.titleVersion,
        }),
        writeFile(
            certFile,
            await createGeneratedCert(tmd, {
                ticketBytes: ticketBytes ?? undefined,
            })
        ),
    ]);

    const totalFiles = tmd.contents.length;
    let completedFiles = 0;

    const downloadedContentFiles = await mapConcurrent(
        tmd.contents,
        TITLE_DOWNLOAD_CONCURRENCY,
        async (content) => {
            throwIfAborted(options.signal);
            const files = getContentInstallFiles(outputDir, content);
            options.onProgress?.({
                completedFiles,
                totalFiles,
                currentFileName: files.appName,
            });

            const downloadedContentFile = await downloadTitleContentFile({
                content,
                outputDir,
                titleKey,
                baseUrl,
                titleId: normalizedTitleId,
                signal: options.signal,
            });

            throwIfAborted(options.signal);
            completedFiles += 1;

            options.onProgress?.({
                completedFiles,
                totalFiles,
                currentFileName:
                    downloadedContentFile.app ?? downloadedContentFile.h3,
            });

            return downloadedContentFile;
        }
    );

    for (const downloadedContentFile of downloadedContentFiles) {
        if (downloadedContentFile.app) {
            files.app.push(downloadedContentFile.app);
        }
        if (downloadedContentFile.h3) {
            files.h3.push(downloadedContentFile.h3);
        }
        verification.push(downloadedContentFile.verification);
    }

    const name = normalizeTitleName(meta?.name ?? normalizedTitleId);
    const sizeBytes = await getImmediatePathSizeBytes(outputDir);

    logger.log(
        'metadata',
        `finished downloading: [${normalizedTitleId}] ${name} ${kind}`
    );

    return {
        titleId: normalizedTitleId,
        kind,
        name,
        titleVersion: tmd.header.titleVersion,
        titleKey: Buffer.from(titleKey).toString('hex'),
        titleKeyPassword,
        outputDir,
        sizeBytes,
        files,
        verification,
    };
}

export async function validateTitleInstallFiles(
    dirPath: string,
    onProgress?: (progress: InstalledTitleValidationProgress) => void
): Promise<InstalledTitleValidation> {
    const tmd = await readTmd(dirPath);
    if (!tmd) {
        return createFailedInstalledValidation(
            null,
            null,
            `Missing or invalid ${TMD_TITLE_FILE}`
        );
    }

    const titleId = getTitleIdHex(tmd.header.titleId);
    const titleVersion = tmd.header.titleVersion;
    const ticket = await readTikHeader(dirPath);
    if (!ticket) {
        return createFailedInstalledValidation(
            titleId,
            titleVersion,
            `Missing or invalid ${TIK_TITLE_FILE}`
        );
    }

    let titleKey: Uint8Array;
    try {
        titleKey = decryptTitleKey(
            ticket.encryptedKey,
            await readCommonKey(),
            ticket.titleId
        );
    } catch (error) {
        return createFailedInstalledValidation(
            titleId,
            titleVersion,
            error instanceof Error ? error.message : String(error)
        );
    }

    const verification: ContentTreeVerification[] = [];
    for (const content of tmd.contents) {
        const files = getContentInstallFiles(dirPath, content);
        onProgress?.({ currentFileName: files.appName });
        verification.push(
            await verifyInstalledContent({
                dirPath,
                content,
                files,
                titleKey,
            })
        );
    }

    return {
        titleId,
        titleVersion,
        status: verification.every((result) => result.status === 'ok')
            ? 'ok'
            : 'failed',
        error: null,
        verification,
    };
}

export async function validateTitleInstallFileSizes(
    dirPath: string
): Promise<InstalledTitleValidation> {
    const tmd = await readTmd(dirPath);
    if (!tmd) {
        return createFailedInstalledValidation(
            null,
            null,
            `Missing or invalid ${TMD_TITLE_FILE}`
        );
    }

    const titleId = getTitleIdHex(tmd.header.titleId);
    const titleVersion = tmd.header.titleVersion;
    const verification: ContentTreeVerification[] = [];

    for (const content of tmd.contents) {
        verification.push(
            await verifyInstalledContentFileSize(dirPath, content)
        );
    }

    return {
        titleId,
        titleVersion,
        status: verification.every((result) => result.status === 'ok')
            ? 'ok'
            : 'failed',
        error: null,
        verification,
    };
}

async function verifyInstalledContentFileSize(
    dirPath: string,
    content: TmdContent
): Promise<ContentTreeVerification> {
    const files = getContentInstallFiles(dirPath, content);
    const expectedSize = getEncryptedContentFileSize(content);

    try {
        await assertExistingContentFileSize(
            files.appFile,
            expectedSize,
            files.contentId
        );

        if (isHashedContent(content)) {
            if (!files.h3File) {
                return {
                    contentId: files.contentId,
                    status: 'failed',
                    error: 'Missing H3 file path for hashed content',
                };
            }

            await stat(files.h3File);
        }

        return {
            contentId: files.contentId,
            status: 'ok',
        };
    } catch (error) {
        return {
            contentId: files.contentId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function createFailedInstalledValidation(
    titleId: string | null,
    titleVersion: number | null,
    error: string
): InstalledTitleValidation {
    return {
        titleId,
        titleVersion,
        status: 'failed',
        error,
        verification: [],
    };
}

function verifyInstalledContent({
    dirPath,
    content,
    files,
    titleKey,
}: {
    dirPath: string;
    content: TmdContent;
    files?: ContentInstallFiles;
    titleKey: Uint8Array;
}): Promise<ContentTreeVerification> {
    return verifyContentInstallFiles({
        files: files ?? getContentInstallFiles(dirPath, content),
        content,
        titleKey,
    });
}

async function downloadTitleContentFile({
    content,
    outputDir,
    titleKey,
    baseUrl,
    titleId,
    signal,
}: {
    content: TmdContent;
    outputDir: string;
    titleKey: Uint8Array;
    baseUrl: string;
    titleId: string;
    signal?: AbortSignal;
}): Promise<DownloadedContentFile> {
    throwIfAborted(signal);
    const files = getContentInstallFiles(outputDir, content);

    if (!isHashedContent(content)) {
        const verification = await ensureContentInstallFiles({
            files,
            content,
            titleKey,
            signal,
            download: (targetFile) =>
                downloadContentToFile(
                    baseUrl,
                    titleId,
                    content.id,
                    targetFile,
                    signal
                ),
        });

        return {
            app: verification.status === 'ok' ? files.appName : null,
            h3: null,
            verification,
        };
    }

    const verification = await ensureContentInstallFiles({
        files,
        content,
        titleKey,
        signal,
        downloadApp: (targetFile) =>
            downloadContentToFile(
                baseUrl,
                titleId,
                content.id,
                targetFile,
                signal
            ),
        downloadH3: (targetFile) =>
            downloadContentH3ToFile(
                baseUrl,
                titleId,
                content.id,
                targetFile,
                signal
            ),
    });

    return {
        app: verification.status === 'ok' ? files.appName : null,
        h3: verification.status === 'ok' ? files.h3Name : null,
        verification,
    };
}

export function readMetaXml(buffer: Uint8Array): NUSTitleInformation | null {
    const menu = readMetaXmlJson(buffer);
    const productCode = getMenuString(menu, 'product_code');
    const companyCode = getMenuString(menu, 'company_code');
    const name = getMenuString(menu, 'longname_en');
    const region = normalizeRegion(getMenuString(menu, 'region'), productCode);
    const version = parseMetaUnsignedInt(getMenuString(menu, 'version'));
    const titleVersion = parseMetaUnsignedInt(
        getMenuString(menu, 'title_version')
    );

    if (
        !productCode &&
        !companyCode &&
        !name &&
        !region &&
        version === null &&
        titleVersion === null
    ) {
        return null;
    }

    return { productCode, companyCode, name, region, version, titleVersion };
}

export function readMetaXmlJson(
    buffer: Uint8Array
): Record<string, unknown> | null {
    try {
        const xml = Buffer.from(buffer)
            .toString('utf8')
            .replace(/^\uFEFF/, '');
        const normalized = normalizeXmlText(xml);
        if (!normalized) {
            return null;
        }
        const parsed = META_XML_PARSER.parse(normalized) as {
            menu?: Record<string, unknown>;
        };
        return parsed.menu ?? null;
    } catch (error) {
        logger.warn('metadata', 'failed to parse meta.xml:', String(error));
        return null;
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
    try {
        const buffer = await readFile(path.join(dirPath, TIK_TITLE_FILE));
        return readTikFromBuffer(buffer);
    } catch (error) {
        logger.warn(
            'metadata',
            `failed to read ${TIK_TITLE_FILE} from ${dirPath}:`,
            String(error)
        );
        return null;
    }
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

export function readTmdFromBuffer(buffer: Buffer): Tmd | null {
    const header = readTmdHeader(buffer.subarray(0, TMD_CONTENT_OFFSET));
    if (!header) {
        return null;
    }
    const contents = readTmdContents(
        buffer.subarray(TMD_CONTENT_OFFSET),
        header.contentCount
    );
    const certificateOffset =
        TMD_CONTENT_OFFSET + header.contentCount * TMD_CONTENT_SIZE;
    const certificates = readTmdCertificates(
        buffer.subarray(certificateOffset)
    );
    return { header, contents, certificates };
}

export async function readTmd(dirPath: string): Promise<Tmd | null> {
    try {
        const buffer = await readFile(path.join(dirPath, TMD_TITLE_FILE));
        return readTmdFromBuffer(buffer);
    } catch (error) {
        logger.warn(
            'metadata',
            `failed to read ${TMD_TITLE_FILE} from ${dirPath}:`,
            String(error)
        );
        return null;
    }
}

export function readTmdHeader(buffer: Buffer): TmdHeader | null {
    if (buffer.length < TMD_CONTENT_COUNT_OFFSET + TMD_CONTENT_COUNT_SIZE) {
        return null;
    }
    const titleId = new Uint8Array(
        buffer.subarray(
            TMD_TITLE_ID_OFFSET,
            TMD_TITLE_ID_OFFSET + TMD_TITLE_ID_SIZE
        )
    );
    const systemType = getSystemType(titleId);
    if (!isWiiU(systemType)) {
        return null;
    }
    return {
        titleId,
        titleVersion: buffer.readUintBE(TMD_VERSION_OFFSET, TMD_VERSION_SIZE),
        region: getRegionName(
            buffer.readUintBE(TMD_REGION_OFFSET, TMD_REGION_SIZE)
        ),
        systemType,
        contentCount: buffer.readUIntBE(
            TMD_CONTENT_COUNT_OFFSET,
            TMD_CONTENT_COUNT_SIZE
        ),
    };
}

export function readTmdCertificate(buffer: Buffer): TmdCertificate | null {
    if (buffer.length < 4) {
        return null;
    }
    const signatureType = buffer.readUInt32BE(0);
    if (!isValidCertificateSignatureType(signatureType)) {
        return null;
    }
    const signatureSize = getCertificateSignatureSize(signatureType);
    const signatureOffset = 0x04;
    const issuerOffset = 0x40 + signatureSize;
    const keyTypeOffset = 0x80 + signatureSize;
    const nameOffset = 0x84 + signatureSize;
    const keyIdOffset = 0x0c4 + signatureSize;
    const publicKeyOffset = 0x0c8 + signatureSize;

    if (buffer.length < publicKeyOffset) {
        return null;
    }
    const keyType = buffer.readUInt32BE(keyTypeOffset);
    if (!isCertificateKeyType(keyType)) {
        return null;
    }
    const publicKeySize = getCertificatePublicKeySize(keyType);
    if (buffer.length < publicKeyOffset + publicKeySize) {
        return null;
    }
    return {
        signatureType,
        signature: new Uint8Array(
            buffer.subarray(signatureOffset, signatureOffset + signatureSize)
        ),
        issuer: buffer
            .toString('ascii', issuerOffset, issuerOffset + 64)
            .replace(/\0.*$/, ''),
        keyType,
        name: buffer
            .toString('ascii', nameOffset, nameOffset + 64)
            .replace(/\0.*$/, ''),
        keyId: buffer.readUInt32BE(keyIdOffset),
        publicKey: new Uint8Array(
            buffer.subarray(publicKeyOffset, publicKeyOffset + publicKeySize)
        ),
    };
}

export function getTitleIdHex(value: Uint8Array): string {
    return Buffer.from(value).toString('hex');
}

export function getTitleIdNumber(value: Uint8Array): bigint {
    return Buffer.from(value).readBigUInt64BE(0);
}

export async function readCommonKey(): Promise<Uint8Array> {
    const commonKeyPath = path.join(getUserAppRoot(), 'common.key');

    if (!commonKeyPromise) {
        const pending = (async () => {
            try {
                const commonKey = parseCommonKey(
                    await readFile(commonKeyPath),
                    commonKeyPath
                );
                logger.log(
                    'metadata',
                    `Loaded common key from ${commonKeyPath}`
                );
                return commonKey;
            } catch (error) {
                if (isNodeError(error) && error.code === 'ENOENT') {
                    return downloadCommonKey(commonKeyPath);
                }

                throw new Error(
                    `common key not found or invalid at ${commonKeyPath}. ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    { cause: error }
                );
            }
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

function resolveTitleKey({
    commonKey,
    encryptedFst,
    normalizedTitleId,
    ticket,
    tmd,
}: {
    commonKey: Uint8Array;
    encryptedFst: Uint8Array;
    normalizedTitleId: string;
    ticket: Tik | null;
    tmd: Tmd;
}): ResolvedTitleKey {
    const ticketTitleKey =
        ticket !== null
            ? decryptTitleKey(ticket.encryptedKey, commonKey, ticket.titleId)
            : null;
    const ticketDecryptedFst =
        ticketTitleKey !== null
            ? decryptContentWithBigIntIv(encryptedFst, ticketTitleKey, 0)
            : null;

    if (
        ticket !== null &&
        ticketTitleKey !== null &&
        ticketDecryptedFst !== null &&
        looksLikeFst(ticketDecryptedFst)
    ) {
        return {
            titleKey: ticketTitleKey,
            decryptedFst: ticketDecryptedFst,
            encryptedTitleKey: ticket.encryptedKey,
            titleKeyPassword: null,
        };
    }

    const generatedMatch = findGeneratedTitleKey(
        tmd.header.titleId,
        (candidate) =>
            looksLikeFst(
                decryptContentWithBigIntIv(encryptedFst, candidate.titleKey, 0)
            )
    );

    if (!generatedMatch) {
        throw new TitleMetadataError(
            'resolve_title_key',
            `No usable title key produced an FST for ${normalizedTitleId}`
        );
    }

    return {
        titleKey: generatedMatch.titleKey,
        decryptedFst: decryptContentWithBigIntIv(
            encryptedFst,
            generatedMatch.titleKey,
            0
        ),
        encryptedTitleKey: encryptTitleKey(
            generatedMatch.titleKey,
            commonKey,
            tmd.header.titleId
        ),
        titleKeyPassword: generatedMatch.password,
    };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

function getContentInstallFiles(
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

function verifyContentInstallFiles({
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

async function ensureContentInstallFiles({
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

async function assertExistingContentFileSize(
    appFile: string,
    expectedSize: bigint,
    contentId: string
): Promise<void> {
    const { size } = await stat(appFile);
    if (BigInt(size) !== expectedSize) {
        throw new Error(
            `Content size mismatch for ${contentId}: expected ${expectedSize.toString()} bytes, got ${size} bytes`
        );
    }
}

function getEncryptedContentFileSize(content: TmdContent): bigint {
    if (isHashedContent(content)) {
        return content.size;
    }

    const blockSize = BigInt(AES_BLOCK_SIZE);
    return ((content.size + blockSize - 1n) / blockSize) * blockSize;
}

function logExistingContentSkipped(contentId: string, size: bigint): void {
    logger.log(
        'metadata',
        `content ${contentId} (${size.toString()} bytes, cached)`
    );
}

function logExistingContentInvalid(
    contentId: string,
    error: string | undefined
): void {
    if (error?.includes('ENOENT')) {
        logger.log('metadata', `content not found, downloading: ${contentId}`);
        return;
    }
    logger.log(
        'metadata',
        `cached content invalid, redownloading: ${contentId}${error ? ` (${error})` : ''}`
    );
}

async function hashDecryptedContentFile(
    appFile: string,
    titleKey: Uint8Array,
    contentIndex: number,
    contentSize: bigint,
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
        const hashLength = Number(
            remaining < BigInt(decrypted.length)
                ? remaining
                : BigInt(decrypted.length)
        );

        if (hashLength > 0) {
            hash.update(decrypted.subarray(0, hashLength));
            remaining -= BigInt(hashLength);
        }
    }

    throwIfAborted(signal);
    const final = decipher.final();
    const finalHashLength = Number(
        remaining < BigInt(final.length) ? remaining : BigInt(final.length)
    );
    if (finalHashLength > 0) {
        hash.update(final.subarray(0, finalHashLength));
        remaining -= BigInt(finalHashLength);
    }

    if (remaining !== 0n) {
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
        new Uint8Array(16)
    );
    const h0Index = blockIndex % HASH_ENTRIES_PER_LEVEL;
    const dataIv = hashArea.slice(
        HASH_H0_START + h0Index * HASH_ENTRY_SIZE,
        HASH_H0_START + h0Index * HASH_ENTRY_SIZE + 0x10
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

export async function downloadTicket(
    baseUrl: string,
    titleId: string,
    signal?: AbortSignal
): Promise<Uint8Array> {
    return downloadBinary(getTicketUrl(baseUrl, titleId), 'ticket', signal);
}

export async function downloadTmd(
    baseUrl: string,
    titleId: string,
    signal?: AbortSignal
): Promise<Uint8Array> {
    return downloadBinary(getTmdUrl(baseUrl, titleId), 'tmd', signal);
}

export async function downloadContent(
    baseUrl: string,
    titleId: string,
    contentId: number,
    signal?: AbortSignal
): Promise<Uint8Array> {
    return downloadBinary(
        getContentUrl(baseUrl, titleId, contentId),
        `content ${formatContentId(contentId)}`,
        signal
    );
}

export async function downloadContentH3(
    baseUrl: string,
    titleId: string,
    contentId: number,
    signal?: AbortSignal
): Promise<Uint8Array> {
    return downloadBinary(
        getContentH3Url(baseUrl, titleId, contentId),
        `content ${formatContentId(contentId)}.h3`,
        signal
    );
}

async function downloadContentToFile(
    baseUrl: string,
    titleId: string,
    contentId: number,
    targetFile: string,
    signal?: AbortSignal
): Promise<void> {
    return downloadBinaryToFile(
        getContentUrl(baseUrl, titleId, contentId),
        targetFile,
        `content ${formatContentId(contentId)}`,
        signal
    );
}

async function downloadContentH3ToFile(
    baseUrl: string,
    titleId: string,
    contentId: number,
    targetFile: string,
    signal?: AbortSignal
): Promise<void> {
    return downloadBinaryToFile(
        getContentH3Url(baseUrl, titleId, contentId),
        targetFile,
        `content ${formatContentId(contentId)}.h3`,
        signal
    );
}

export function getTicketUrl(baseUrl: string, titleId: string): string {
    return buildDownloadUrl(baseUrl, titleId, TIK_TITLE_FILE_CDN);
}

export function getTmdUrl(baseUrl: string, titleId: string): string {
    return buildDownloadUrl(baseUrl, titleId, 'tmd');
}

export function getContentUrl(
    baseUrl: string,
    titleId: string,
    contentId: number
): string {
    return buildDownloadUrl(baseUrl, titleId, formatContentId(contentId));
}

export function getContentH3Url(
    baseUrl: string,
    titleId: string,
    contentId: number
): string {
    return buildDownloadUrl(
        baseUrl,
        titleId,
        `${formatContentId(contentId)}.h3`
    );
}

// -- Internal --

async function extractMetaXmlFromTitle(
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

function decryptHashedContent(
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
        if (encryptedBlock.length === 0) continue;

        // Decrypt the hash area (first 0x400 bytes) using the block IV
        const decryptedHashArea = decryptContentWithIv(
            encryptedBlock.slice(0, HASHED_BLOCK_DATA_OFFSET),
            titleKey,
            iv
        );

        // The data IV is the first 16 bytes of the decrypted hash area (H0[0])
        const dataIv = decryptedHashArea.slice(0x00, 0x10);

        // Decrypt the data area (0x400 onward) using the data IV
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

function extractHashedContentSlice(
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

function parseFstEntries(decryptedFst: Uint8Array, tmd: Tmd): FstEntry[] {
    if (!looksLikeFst(decryptedFst)) {
        return [];
    }
    const buffer = Buffer.from(decryptedFst);
    const totalContentCount = buffer.readUInt32BE(8);
    const baseOffset = 0x20 + totalContentCount * 0x20;

    if (buffer.length < baseOffset + FST_ENTRY_SIZE) {
        return [];
    }
    const totalEntries = buffer.readUInt32BE(baseOffset + 8);
    const nameOffsetBase = baseOffset + totalEntries * 0x10;
    const directoryStack: Array<{ name: string; nextOffset: number }> = [];
    const entries: FstEntry[] = [];

    for (let i = 0; i < totalEntries; i += 1) {
        while (
            directoryStack.length > 0 &&
            directoryStack[directoryStack.length - 1].nextOffset === i
        ) {
            directoryStack.pop();
        }

        const offset = baseOffset + i * FST_ENTRY_SIZE;
        if (offset + FST_ENTRY_SIZE > buffer.length) {
            break;
        }

        const type = buffer[offset];
        const isDirectory = (type & 0x01) === 0x01;
        const nameOffset = buffer.readUInt32BE(offset) & 0x00ff_ffff;
        const name = readNullTerminatedString(
            buffer,
            nameOffsetBase + nameOffset
        );
        const fileOffset = buffer.readUInt32BE(offset + 4);
        const fileLength = buffer.readUInt32BE(offset + 8);
        const flags = buffer.readUInt16BE(offset + 12);
        const contentId = buffer.readUInt16BE(offset + 14);
        const content = tmd.contents[contentId];
        const dirPath = directoryStack
            .map((e) => e.name)
            .filter((n) => n.length > 0)
            .join('/');
        const fullPath = [dirPath, name].filter((n) => n.length > 0).join('/');

        entries.push({
            name,
            path: dirPath,
            fullPath,
            isDirectory,
            contentId,
            extractWithHash: content !== undefined && isHashedContent(content),
            fileOffset,
            shiftedFileOffset:
                (flags & FST_CHANGE_OFFSET_FLAG) === 0
                    ? fileOffset << 5
                    : fileOffset,
            fileLength,
        });

        if (isDirectory) {
            directoryStack.push({ name, nextOffset: fileLength });
        }
    }

    return entries;
}

function readTmdContents(buffer: Buffer, contentCount: number): TmdContent[] {
    if (buffer.length < contentCount * TMD_CONTENT_SIZE) {
        throw new Error('Invalid TMD content table size');
    }
    const contents: TmdContent[] = [];
    for (let i = 0; i < contentCount; i += 1) {
        const offset = i * TMD_CONTENT_SIZE;
        contents.push(
            readTmdContent(buffer.subarray(offset, offset + TMD_CONTENT_SIZE))
        );
    }
    return contents;
}

function readTmdContent(buffer: Buffer): TmdContent {
    const hashSize = 32;
    if (buffer.length < hashSize + 16) {
        throw new Error('Invalid TMD content buffer size');
    }
    return {
        id: buffer.readUInt32BE(0),
        index: buffer.readUInt16BE(4),
        type: buffer.readUInt16BE(6),
        size: buffer.readBigUInt64BE(8),
        hash: new Uint8Array(buffer.subarray(16, 16 + hashSize)),
    };
}

function readTmdCertificates(buffer: Buffer): TmdCertificates {
    if (buffer.length < TMD_CERTIFICATE_1_SIZE + TMD_CERTIFICATE_2_SIZE) {
        return { certificate1: null, certificate2: null };
    }
    const cert1Raw = new Uint8Array(buffer.subarray(0, TMD_CERTIFICATE_1_SIZE));
    const cert2Raw = new Uint8Array(
        buffer.subarray(
            TMD_CERTIFICATE_1_SIZE,
            TMD_CERTIFICATE_1_SIZE + TMD_CERTIFICATE_2_SIZE
        )
    );
    return {
        certificate1: {
            raw: cert1Raw,
            parsed: readTmdCertificate(Buffer.from(cert1Raw)),
        },
        certificate2: {
            raw: cert2Raw,
            parsed: readTmdCertificate(Buffer.from(cert2Raw)),
        },
    };
}

function getCertificatePublicKeySize(keyType: CertificateKeyType): number {
    switch (keyType) {
        case CERT_KEY_RSA_4096:
            return 0x238;
        case CERT_KEY_RSA_2048:
            return 0x138;
        case CERT_KEY_ECC:
            return 0x78;
    }
}

function getCertificateSignatureSize(
    signatureType: CertificateSignatureType
): number {
    switch (signatureType) {
        case CERT_SIGNATURE_RSA_4096:
            return 0x200;
        case CERT_SIGNATURE_RSA_2048:
            return 0x100;
        case CERT_SIGNATURE_ECC:
            return 0x3c;
    }
}

function isValidCertificateSignatureType(
    value: number
): value is CertificateSignatureType {
    return (
        value === CERT_SIGNATURE_RSA_4096 ||
        value === CERT_SIGNATURE_RSA_2048 ||
        value === CERT_SIGNATURE_ECC
    );
}

function isCertificateKeyType(value: number): value is CertificateKeyType {
    return (
        value === CERT_KEY_RSA_4096 ||
        value === CERT_KEY_RSA_2048 ||
        value === CERT_KEY_ECC
    );
}

function getRegionName(region: number): string {
    switch (region) {
        case REGION_JPN:
            return REGION_JPN_NAME;
        case REGION_USA:
            return REGION_USA_NAME;
        case REGION_EUR:
            return REGION_EUR_NAME;
        case REGION_ALL:
            return REGION_ALL_NAME;
        case REGION_KOR:
            return REGION_KOR_NAME;
        default:
            return REGION_UNK_NAME;
    }
}

function getSystemType(titleId: Uint8Array): SYSTEM_TYPE {
    if (!titleId || titleId.length < 2) {
        return SYSTEM_TYPE_UNKNOWN;
    }
    if (titleId[0] === 0x00 && titleId[1] === 0x05) {
        return SYSTEM_TYPE_WIIU;
    }
    if (titleId[0] === 0x00 && titleId[1] === 0x01) {
        return SYSTEM_TYPE_WII;
    }
    return SYSTEM_TYPE_UNKNOWN;
}

function isWiiU(systemType: SYSTEM_TYPE): boolean {
    return systemType === SYSTEM_TYPE_WIIU;
}

function looksLikeFst(value: Uint8Array | null): boolean {
    return (
        value !== null &&
        value.length >= 3 &&
        Buffer.from(value.subarray(0, 3)).toString('ascii') === FST_MAGIC
    );
}

function isHashedContent(content: TmdContent): boolean {
    return (content.type & 0x2003) === 0x2003;
}

function startsWithXml(buffer: Uint8Array | null): boolean {
    if (!buffer || buffer.length === 0) return false;
    const text = Buffer.from(
        buffer.subarray(0, Math.min(buffer.length, 16))
    ).toString('latin1');
    return text.includes('<?xml') || text.includes('<menu');
}

function findXmlStartByte(buffer: Uint8Array): number {
    const source = Buffer.from(buffer);
    const xmlIndex = source.indexOf(Buffer.from('<?xml'));
    if (xmlIndex >= 0) return xmlIndex;
    const menuIndex = source.indexOf(Buffer.from('<menu'));
    return menuIndex >= 0 ? menuIndex : -1;
}

function normalizeXmlText(xml: string): string | null {
    return xml.startsWith('<?xml') || xml.startsWith('<menu') ? xml : null;
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

function readNullTerminatedString(buffer: Buffer, offset: number): string {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) {
        end += 1;
    }
    return buffer.toString('utf8', offset, end);
}

function getMenuString(
    menu: Record<string, unknown> | null,
    key: string
): string | null {
    const value = menu?.[key];
    if (typeof value !== 'string') return null;
    return value.length > 0 ? value : null;
}

function parseMetaUnsignedInt(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function safeDirectoryName(value: string): string {
    const invalid = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
    const normalized = normalizeTitleName(value);
    return (
        [...normalized]
            .filter((char) => !invalid.has(char) && char.charCodeAt(0) >= 32)
            .join('')
            .replace(/\s+/g, ' ')
            .trim() || 'Unknown'
    );
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

    try {
        const tmdBytes = await downloadTmd(baseUrl, titleId);
        const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));

        return {
            titleId: baseTitleId,
            childTitleId: titleId,
            exists: tmd !== null,
            titleVersion: tmd?.header.titleVersion ?? null,
        };
    } catch (error) {
        if (isHttpErrorStatus(error, 404)) {
            return {
                titleId: baseTitleId,
                childTitleId: titleId,
                exists: false,
                titleVersion: null,
            };
        }

        throw error;
    }
}

function replaceTitlePrefix(
    titleId: string,
    nextKind: 'base' | 'update' | 'dlc' | 'demo'
): string {
    const normalizedTitleId = titleId.toLowerCase();

    if (!/^[0-9a-f]{16}$/.test(normalizedTitleId)) {
        throw new Error(`Invalid titleId: ${titleId}`);
    }

    let normalizedPrefix: string;
    switch (nextKind) {
        case 'base':
            normalizedPrefix = '00050000';
            break;
        case 'update':
            normalizedPrefix = '0005000e';
            break;
        case 'dlc':
            normalizedPrefix = '0005000c';
            break;
        case 'demo':
            normalizedPrefix = '00050002';
            break;
    }

    if (!/^[0-9a-f]{8}$/.test(normalizedPrefix)) {
        throw new Error(`Invalid title kind: ${nextKind}`);
    }

    return `${normalizedPrefix}${normalizedTitleId.slice(8)}`;
}

function normalizeDownloadableTitleId(titleId: string): DownloadableTitle {
    const normalizedTitleId = titleId.toLowerCase();

    if (!/^[0-9a-f]{16}$/.test(normalizedTitleId)) {
        throw new Error(`Invalid titleId: ${titleId}`);
    }

    switch (normalizedTitleId.slice(0, 8)) {
        case '00050000':
            return { titleId: normalizedTitleId, kind: 'Base' };
        case '0005000e':
            return { titleId: normalizedTitleId, kind: 'Update' };
        case '0005000c':
            return { titleId: normalizedTitleId, kind: 'DLC' };
        default:
            throw new Error(
                `Unsupported downloadable title kind: ${normalizedTitleId}`
            );
    }
}

function buildDownloadUrl(
    baseUrl: string,
    titleId: string,
    suffix: string
): string {
    const normalizedTitleId = titleId.replace(/^\/+|\/+$/g, '');
    return new URL(
        `${normalizedTitleId}/${suffix}`,
        ensureTrailingSlash(baseUrl)
    ).toString();
}

function formatContentId(contentId: number): string {
    if (
        !Number.isInteger(contentId) ||
        contentId < 0 ||
        contentId > 0xffffffff
    ) {
        throw new Error(`contentId must be a uint32, got ${contentId}`);
    }
    return contentId.toString(16).toUpperCase().padStart(8, '0');
}

async function downloadBinary(
    url: string,
    label = 'file',
    signal?: AbortSignal
): Promise<Uint8Array> {
    logger.log('metadata', `downloading ${label}: ${url}`);
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new HttpError(url, response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    logger.log(
        'metadata',
        `downloaded ${label}: ${url} (${bytes.length} bytes)`
    );
    return bytes;
}

async function downloadBinaryToFile(
    url: string,
    targetFile: string,
    label = 'file',
    signal?: AbortSignal
): Promise<void> {
    logger.log('metadata', `downloading ${label}: ${url}`);
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new HttpError(url, response.status);
    }
    if (!response.body) {
        throw new Error(`download failed for ${url}: empty response body`);
    }

    const tempFile = `${targetFile}.${process.pid}.${randomUUID()}.download`;

    try {
        await pipeline(
            Readable.fromWeb(response.body),
            createWriteStream(tempFile),
            { signal }
        );
        await rename(tempFile, targetFile);
    } catch (error) {
        await rm(tempFile, { force: true });
        throw error;
    }

    const { size } = await stat(targetFile);
    logger.log(
        'metadata',
        `downloaded ${label}: ${url} (${size.toString()} bytes)`
    );
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

function isHttpErrorStatus(error: unknown, status: number): boolean {
    return error instanceof HttpError && error.status === status;
}
