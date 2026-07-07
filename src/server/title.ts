import path from 'path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import forge from 'node-forge';
import {
    createContentIv,
    createTitleKeyIv,
    decryptContentWithBigIntIv,
    decryptContentWithIv,
    decryptTitleKey,
    encryptTitleKey,
    findGeneratedTitleKey,
} from './decryption.js';
import {
    DEFAULT_CERT_TITLE_ID,
    type DownloadOptions,
    WII_U_NUS_BASE_URL,
    downloadContent,
    downloadContentH3,
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
    getEncryptedContentFileSize,
    isHashedContent,
    type ContentInstallFiles,
    type ContentTreeVerification,
} from './formats/content.js';
import { inspectExeFsFile } from './formats/exefs.js';
import {
    looksLikeFst,
    parseTitleFstEntries,
    type TitleFstEntry,
} from './formats/fst.js';
import {
    findXmlStartByte,
    readMetaXml,
    readMetaXmlJson,
    type NUSTitleInformation,
} from './formats/meta.js';
import { inspectNcch } from './formats/ncch.js';
import { inspectSmdhMetadata } from './formats/smdh.js';
import {
    getTitleIdHex,
    getTitleIdNumber,
    readTmdCertificate,
    readTmdFromBuffer,
    readTmdHeader,
    TMD_TITLE_FILE,
    type Tmd,
    type TmdContent,
} from './formats/tmd.js';
import { getUserAppRoot } from './paths.js';
import {
    identifyWiiUTitle,
    replaceTitleKind,
    TitleKinds,
} from '../shared/titles.js';
import logger from '../shared/logger.js';
import { isHttpErrorStatus } from '../shared/download.js';
import { isFileNotFoundError, readOptionalFile } from '../shared/file.js';

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

type ResolvedTitleKey = {
    titleKey: Uint8Array;
    decryptedFst: Uint8Array;
    encryptedTitleKey: Uint8Array | null;
    titleKeyPassword: string | null;
};

export class TitleMetadataError extends Error {
    stage: string;

    constructor(stage: string, message: string) {
        super(message);
        this.name = 'TitleMetadataError';
        this.stage = stage;
    }
}

export function resolveTitleKey({
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

type FstEntry = TitleFstEntry;

export const TIK_TITLE_FILE = 'title.tik';
export const CERT_TITLE_FILE = 'title.cert';

const COMMON_KEY_SIZE = 16;

const THREE_DS_CONTENT_BASE_URLS = [
    'https://ccs.cdn.c.shop.nintendowifi.net/ccs/download/',
    'http://ccs.cdn.c.shop.nintendowifi.net/ccs/download/',
    'http://nus.cdn.c.shop.nintendowifi.net/ccs/download/',
] as const;

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
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9FbXJhbkFobTNkL2JkN2E3OTFkMDI5NzVkNzE4NmQwYzA1NTRmM2NmNmVhL3Jhdy8xYzM4MzM1ZjJhNzFhYjQyNDVkMjM3NjE4YzRmYWZlNjcwZWUzZTgyL3dpaXVjb21tb29ua2V5LnR4dA==',
    'aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9xd2VsbC80NWJhN2QyZjMwNWRlNzJhODFkYjlkNzUxOTA4MTE3YS9yYXcvMWMzODMzNWYyYTcxYWI0MjQ1ZDIzNzYxOGM0ZmFmZTY3MGVlM2U4Mi93aWl1Y29tbW9ua2V5LnR4dA==',
] as const;

const THREE_DS_P12_DOWNLOAD_URLS_BASE64 = [
    'aHR0cHM6Ly9naXRodWIuY29tL2xhcnNlbnYvTmludGVuZG9DZXJ0cy9yYXcvcmVmcy9oZWFkcy9tYXN0ZXIvY3RyLWNvbW1vbi0xLnAxMg==',
    'aHR0cHM6Ly93ZWIuYXJjaGl2ZS5vcmcvMjAyNjA3MDcyMDQxMzkvaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2xhcnNlbnYvTmludGVuZG9DZXJ0cy9yZWZzL2hlYWRzL21hc3Rlci9jdHItY29tbW9uLTEucDEy',
] as const;

const THREE_DS_CLIENT_CERT_PASSWORD = 'alpine';

let commonKeyPromise: Promise<Uint8Array> | null = null;
let defaultCertPromise: Promise<Uint8Array> | null = null;
let threeDSDownloadOptionsPromise: Promise<DownloadOptions> | null = null;

type NusMetadataOptions = {
    baseUrl: string;
    downloadOptions?: DownloadOptions;
};

export function getThreeDSP12DownloadUrls(): string[] {
    return THREE_DS_P12_DOWNLOAD_URLS_BASE64.map((encodedUrl) =>
        Buffer.from(encodedUrl, 'base64').toString('utf8')
    );
}

export async function readThreeDSDownloadOptions(): Promise<DownloadOptions> {
    if (!threeDSDownloadOptionsPromise) {
        threeDSDownloadOptionsPromise = readThreeDSP12DownloadOptions();
    }

    return threeDSDownloadOptionsPromise;
}

async function readThreeDSP12DownloadOptions(): Promise<DownloadOptions> {
    const filePath = path.join(getUserAppRoot(), 'ctr-common-1.p12');

    try {
        const p12 = await readFile(filePath);
        return readThreeDSP12DownloadOptionsFromBuffer(p12);
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            throw error;
        }
    }

    logger.warn(
        'metadata',
        [
            '3DS client certificate was not found in any configured location.',
            `Downloading a copy now and saving it to: ${filePath}`,
            'This is a one-time setup step. Future runs will use the saved file instead of downloading it again.',
        ].join('\n')
    );

    const errors: string[] = [];
    for (const url of getThreeDSP12DownloadUrls()) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const p12 = Buffer.from(await response.arrayBuffer());
            const options = readThreeDSP12DownloadOptionsFromBuffer(p12);

            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, p12);
            logger.log(
                'metadata',
                `Saved 3DS client certificate to ${filePath}`
            );

            return options;
        } catch (error) {
            errors.push(
                `${url}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    throw new Error(
        `3DS client certificate could not be loaded. ${errors.join('; ')}`
    );
}

function readThreeDSP12DownloadOptionsFromBuffer(
    p12: Buffer
): Promise<DownloadOptions> {
    const { cert, key } = readP12ClientCertificate(
        p12,
        THREE_DS_CLIENT_CERT_PASSWORD
    );

    return Promise.resolve({
        cert,
        key,
        allowSelfSignedCertificate: true,
    });
}

function readP12ClientCertificate(
    p12: Buffer,
    passphrase: string
): Pick<DownloadOptions, 'cert' | 'key'> {
    const asn1 = forge.asn1.fromDer(p12.toString('binary'));
    const parsed = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
    const keyBag = getP12Bag(parsed, forge.pki.oids.pkcs8ShroudedKeyBag);
    const certBag = getP12Bag(parsed, forge.pki.oids.certBag);

    if (!keyBag?.key) {
        throw new Error('3DS client certificate P12 is missing a private key');
    }
    if (!certBag?.cert) {
        throw new Error('3DS client certificate P12 is missing a certificate');
    }

    return {
        cert: forge.pki.certificateToPem(certBag.cert),
        key: forge.pki.privateKeyToPem(keyBag.key),
    };
}

function getP12Bag(
    p12: forge.pkcs12.Pkcs12Pfx,
    bagType: string
): forge.pkcs12.Bag | null {
    return p12.getBags({ bagType })[bagType]?.[0] ?? null;
}

export async function downloadNusBaseMetadata(
    titleId: string,
    options: NusMetadataOptions
): Promise<NusTitleMetadata | null> {
    const normalizedTitleId = replaceTitleKind(titleId, TitleKinds.Base);

    return downloadNusTitleMetadata(normalizedTitleId, options);
}

export async function downloadNusTitleMetadata(
    titleId: string,
    options: NusMetadataOptions
): Promise<NusTitleMetadata | null> {
    const baseUrl = options.baseUrl;
    const downloadOptions = options.downloadOptions;
    const tmdBytes = await downloadOptionalTitleFile(() =>
        downloadTmd(baseUrl, titleId, downloadOptions)
    );

    if (!tmdBytes) {
        return null;
    }

    const tik = await downloadOptionalTitleFile(() =>
        downloadTicket(baseUrl, titleId, downloadOptions)
    );

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
        if (tmd.header.systemType === '3ds') {
            return await downloadThreeDSNusTitleMetadata({
                baseUrl,
                downloadOptions,
                ticket,
                tmd,
                titleId,
            });
        }

        const commonKey = await readCommonKey();
        const encryptedFst = await downloadContent(
            baseUrl,
            titleId,
            fstContent.id,
            downloadOptions
        );
        const { titleKey, decryptedFst, titleKeyPassword } = resolveTitleKey({
            commonKey,
            encryptedFst,
            normalizedTitleId: titleId,
            ticket,
            tmd,
        });
        const meta = await enrichNusTitleMetadata({
            baseUrl,
            decryptedFst,
            downloadOptions,
            tmd,
            titleId,
            titleKey,
        });

        return {
            ...createBasicNusTitleMetadata(titleId, tmd),
            name: meta.info?.name ?? null,
            region: meta.info?.region ?? null,
            productCode: meta.info?.productCode ?? null,
            companyCode: meta.info?.companyCode ?? null,
            titleKey,
            titleKeyPassword,
            metaJson: meta.raw,
        };
    } catch (error) {
        logger.warn(
            'metadata',
            `failed to enrich metadata for ${titleId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return createBasicNusTitleMetadata(titleId, tmd);
    }
}

async function downloadThreeDSNusTitleMetadata({
    baseUrl,
    downloadOptions,
    ticket,
    tmd,
    titleId,
}: {
    baseUrl: string;
    downloadOptions?: DownloadOptions;
    ticket: Tik | null;
    tmd: Tmd;
    titleId: string;
}): Promise<NusTitleMetadata> {
    const resolved = await resolveThreeDSMetadataFromTitle(
        tmd,
        baseUrl,
        titleId,
        ticket,
        downloadOptions
    );

    return {
        ...createBasicNusTitleMetadata(titleId, tmd),
        name: resolved.metadata.name,
        region: resolved.metadata.region,
        productCode: resolved.metadata.productCode,
        companyCode: resolved.metadata.companyCode,
        titleKey: resolved.titleKey,
        titleKeyPassword: resolved.titleKeyPassword,
    };
}

async function downloadOptionalTitleFile(
    download: () => Promise<Uint8Array>
): Promise<Uint8Array | null> {
    try {
        return await download();
    } catch (error) {
        if (
            isHttpErrorStatus(error, 403) ||
            isHttpErrorStatus(error, 404) ||
            isHttpErrorStatus(error, 503)
        ) {
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

type NusMetadataEnrichment = {
    info: NUSTitleInformation | null;
    raw: Record<string, unknown> | null;
};

type ThreeDSContentMetadata = {
    name: string | null;
    publisher: string | null;
    region: string | null;
    productCode: string | null;
};

type ThreeDSResolvedMetadata = {
    metadata: NUSTitleInformation;
    titleKey: Uint8Array;
    titleKeyPassword: string | null;
};

async function enrichNusTitleMetadata({
    baseUrl,
    decryptedFst,
    downloadOptions,
    tmd,
    titleId,
    titleKey,
}: {
    baseUrl: string;
    decryptedFst: Uint8Array;
    downloadOptions?: DownloadOptions;
    tmd: Tmd;
    titleId: string;
    titleKey: Uint8Array;
}): Promise<NusMetadataEnrichment> {
    switch (tmd.header.systemType) {
        case '3ds':
            return {
                info: await extractThreeDSMetadataFromTitle(
                    tmd,
                    titleKey,
                    baseUrl,
                    titleId,
                    downloadOptions
                ),
                raw: null,
            };

        case 'wiiu': {
            const metaXml = await extractMetaXmlFromTitle(
                decryptedFst,
                tmd,
                titleKey,
                baseUrl,
                titleId,
                downloadOptions
            );
            return {
                info: metaXml ? readMetaXml(metaXml) : null,
                raw: metaXml ? readMetaXmlJson(metaXml) : null,
            };
        }

        default:
            return { info: null, raw: null };
    }
}

async function extractThreeDSMetadataFromTitle(
    tmd: Tmd,
    titleKey: Uint8Array,
    baseUrl: string,
    titleId: string,
    downloadOptions?: DownloadOptions
): Promise<NUSTitleInformation | null> {
    const failures: string[] = [];

    for (const content of tmd.contents) {
        const encryptedContent = await downloadOptionalThreeDSContent(
            baseUrl,
            titleId,
            content,
            downloadOptions
        );
        if (!encryptedContent) {
            failures.push(
                `${formatContentId(content.id)}: content unavailable`
            );
            continue;
        }

        const result = inspectThreeDSContentMetadataFromEncryptedContent(
            encryptedContent,
            titleKey,
            content,
            tmd.header.titleId
        );
        if (result.ok) {
            const { metadata } = result;
            return {
                name: metadata.name,
                region: metadata.region,
                productCode: metadata.productCode,
                companyCode: null,
                version: null,
                titleVersion: null,
            };
        }

        failures.push(`${formatContentId(content.id)}: ${result.reason}`);
    }

    throw new TitleMetadataError(
        'extract_3ds_metadata',
        failures.length > 0
            ? failures.join('; ')
            : 'TMD had no content entries to inspect'
    );
}

async function resolveThreeDSMetadataFromTitle(
    tmd: Tmd,
    baseUrl: string,
    titleId: string,
    ticket: Tik | null,
    downloadOptions?: DownloadOptions
): Promise<ThreeDSResolvedMetadata> {
    const failures: string[] = [];
    const ticketTitleKey = await resolveThreeDSTicketTitleKey(ticket);

    for (const content of tmd.contents) {
        const encryptedContent = await downloadOptionalThreeDSContent(
            baseUrl,
            titleId,
            content,
            downloadOptions
        );
        if (!encryptedContent) {
            failures.push(
                `${formatContentId(content.id)}: content unavailable`
            );
            continue;
        }

        if (ticketTitleKey) {
            const result = inspectThreeDSContentMetadataFromEncryptedContent(
                encryptedContent,
                ticketTitleKey,
                content,
                tmd.header.titleId
            );
            if (result.ok) {
                return {
                    metadata: createThreeDSNusMetadata(result.metadata),
                    titleKey: ticketTitleKey,
                    titleKeyPassword: null,
                };
            }

            failures.push(
                `${formatContentId(content.id)} ticket key: ${result.reason}`
            );
        }

        const generatedMatch = findGeneratedTitleKey(
            tmd.header.titleId,
            (candidate) =>
                inspectThreeDSContentMetadataFromEncryptedContent(
                    encryptedContent,
                    candidate.titleKey,
                    content,
                    tmd.header.titleId
                ).ok
        );

        if (generatedMatch) {
            const result = inspectThreeDSContentMetadataFromEncryptedContent(
                encryptedContent,
                generatedMatch.titleKey,
                content,
                tmd.header.titleId
            );
            if (result.ok) {
                return {
                    metadata: createThreeDSNusMetadata(result.metadata),
                    titleKey: generatedMatch.titleKey,
                    titleKeyPassword: generatedMatch.password,
                };
            }
        }

        failures.push(
            `${formatContentId(content.id)} generated keys: no match`
        );
    }

    throw new TitleMetadataError(
        'extract_3ds_metadata',
        failures.length > 0
            ? failures.join('; ')
            : 'TMD had no content entries to inspect'
    );
}

async function resolveThreeDSTicketTitleKey(
    ticket: Tik | null
): Promise<Uint8Array | null> {
    if (!ticket) {
        return null;
    }

    try {
        const commonKey = await readCommonKey();
        return decryptTitleKey(ticket.encryptedKey, commonKey, ticket.titleId);
    } catch (error) {
        logger.warn(
            'metadata',
            `failed to decrypt 3DS ticket title key: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

function createThreeDSNusMetadata(
    metadata: ThreeDSContentMetadata
): NUSTitleInformation {
    return {
        name: metadata.name,
        region: metadata.region,
        productCode: metadata.productCode,
        companyCode: null,
        version: null,
        titleVersion: null,
    };
}

async function downloadOptionalThreeDSContent(
    baseUrl: string,
    titleId: string,
    content: TmdContent,
    downloadOptions?: DownloadOptions
): Promise<Uint8Array | null> {
    const contentBaseUrls = [
        baseUrl,
        ...THREE_DS_CONTENT_BASE_URLS.filter(
            (candidate) => candidate !== baseUrl
        ),
    ];

    for (const contentBaseUrl of contentBaseUrls) {
        const encryptedContent = await downloadOptionalTitleFile(() =>
            downloadContent(
                contentBaseUrl,
                titleId,
                content.id,
                downloadOptions
            )
        );

        if (encryptedContent) {
            return encryptedContent;
        }
    }

    return null;
}

type ThreeDSContentMetadataReadResult =
    | {
          ok: true;
          metadata: ThreeDSContentMetadata;
      }
    | {
          ok: false;
          reason: string;
      };

function inspectThreeDSContentMetadataFromEncryptedContent(
    encryptedContent: Uint8Array,
    titleKey: Uint8Array,
    content: TmdContent,
    titleId: Uint8Array
): ThreeDSContentMetadataReadResult {
    const decrypt = (iv: Uint8Array) =>
        isHashedContent(content)
            ? decryptHashedContent(encryptedContent, titleKey, iv)
            : decryptContentWithIv(encryptedContent, titleKey, iv);
    const candidates: Array<[string, Uint8Array]> = [
        ['content index IV', createContentIv(content.index)],
        ['title ID IV', createTitleKeyIv(titleId)],
        ['zero IV', new Uint8Array(16)],
    ];
    const failures: string[] = [];

    for (const [label, iv] of candidates) {
        const result = inspectThreeDSContentMetadata(decrypt(iv));
        if (result.ok) {
            return result;
        }
        failures.push(`${label}: ${result.reason}`);
    }

    return {
        ok: false,
        reason: failures.join(', '),
    };
}

function inspectThreeDSContentMetadata(
    content: Uint8Array
): ThreeDSContentMetadataReadResult {
    const ncchResult = inspectNcch(content);
    if (!ncchResult.ok) {
        return ncchResult;
    }

    const { ncch } = ncchResult;
    if (!ncch.exefs) {
        return {
            ok: false,
            reason: 'NCCH has no ExeFS',
        };
    }

    const iconResult = inspectExeFsFile(ncch.exefs, 'icon');
    if (!iconResult.ok) {
        return iconResult;
    }

    const smdhResult = inspectSmdhMetadata(iconResult.file, ncch.productCode);
    if (!smdhResult.ok) {
        return smdhResult;
    }

    if (!ncch.productCode && !smdhResult.metadata) {
        return {
            ok: false,
            reason: 'NCCH/SMDH had no usable title metadata',
        };
    }

    return {
        ok: true,
        metadata: {
            name: smdhResult.metadata.name,
            publisher: smdhResult.metadata.publisher,
            region: smdhResult.metadata.region,
            productCode: ncch.productCode,
        },
    };
}

export async function getUpdateMetadata(
    baseTitleId: string,
    options: NusMetadataOptions
): Promise<ChildTitleMetadata> {
    return getChildTitleMetadata(
        baseTitleId,
        replaceTitleKind(baseTitleId, TitleKinds.Update),
        options
    );
}

export async function getDlcMetadata(
    baseTitleId: string,
    options: NusMetadataOptions
): Promise<ChildTitleMetadata> {
    return getChildTitleMetadata(
        baseTitleId,
        replaceTitleKind(baseTitleId, TitleKinds.DLC),
        options
    );
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
            WII_U_NUS_BASE_URL,
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
    downloadOptions?: DownloadOptions
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
        downloadOptions
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
    titleId: string,
    options: NusMetadataOptions
): Promise<ChildTitleMetadata> {
    const baseUrl = options.baseUrl;
    const tmdBytes = await downloadOptionalTitleFile(() =>
        downloadTmd(baseUrl, titleId, options.downloadOptions)
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

export function getDownloadableTitle(titleId: string): DownloadableTitle {
    const title = identifyWiiUTitle(titleId);
    if (!title) {
        throw new Error(`Invalid titleId: ${titleId}`);
    }

    const { kind } = title;
    if (
        kind !== TitleKinds.Base &&
        kind !== TitleKinds.Update &&
        kind !== TitleKinds.DLC
    ) {
        throw new Error(`Unsupported downloadable title kind: ${titleId}`);
    }

    return { titleId: title.titleId, kind };
}
