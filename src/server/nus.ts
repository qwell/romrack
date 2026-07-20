import path from 'path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import forge from 'node-forge';
import {
    createTitleKeyIv,
    decryptContentWithBigIntIv,
    decryptContentWithIv,
    decryptTitleKey,
    deriveThreeDSNormalKey,
    encryptTitleKey,
    findGeneratedTitleKey,
} from './decryption.js';
import {
    downloadBytes,
    downloadFile,
    type DownloadOptions,
} from './download.js';
import {
    createContentIv,
    formatContentId,
    decryptHashedContent,
    extractHashedContentSlice,
    isHashedContent,
} from './formats/content.js';
import { inspectExeFsFile } from './formats/exefs.js';
import {
    looksLikeFst,
    parseTitleFstEntries,
    type TitleFstEntry,
} from './formats/wiiu-fst.js';
import {
    findXmlStartByte,
    readMetaXml,
    readMetaXmlJson,
    type MetaXmlInformation,
} from './formats/meta.js';
import { inspectNcch } from './formats/ncch.js';
import {
    inspectSmdhMetadata,
    SMDH_TITLE_ENGLISH_INDEX,
} from './formats/smdh.js';
import { readTmdFromBuffer, type Tmd, type TmdContent } from './formats/tmd.js';
import {
    createTikFromTemplate,
    readTik,
    readTikAuthorityCertificate,
    type GeneratedTikInput,
    type Tik,
} from './formats/tik.js';
import { getUserAppRoot } from './paths.js';
import { loadKeys } from './keys.js';
import {
    identifyWiiUTitle,
    replaceTitleKind,
    TitleKinds,
} from '../shared/titles.js';
import logger from '../shared/logger.js';
import { isHttpErrorStatus } from '../shared/download.js';
import { isFileNotFoundError } from '../shared/file.js';
import { normalizeRegion } from '../shared/regions.js';
import { formatLogError, getPreferredValue } from '../shared/utils.js';

export { type DownloadOptions } from './download.js';

type NUSTitleInformation = MetaXmlInformation;

export const WII_U_NUS_BASE_URL =
    'http://ccs.cdn.wup.shop.nintendo.net/ccs/download';
export const THREE_DS_NUS_BASE_URL =
    'https://ccs.c.shop.nintendowifi.net/ccs/download/';
export const WIIU_META_XML_PATHS = ['meta/meta.xml', 'meta.xml'] as const;

export const DEFAULT_CERT_TITLE_ID = '000500101000400a'; // OSv10

const TIK_TITLE_FILE_CDN = 'cetk';

export async function downloadTicket(
    baseUrl: string,
    titleId: string,
    options?: DownloadOptions
): Promise<Buffer> {
    return downloadBytes(getTicketUrl(baseUrl, titleId), 'ticket', options);
}

export async function downloadOptionalTicket(
    baseUrl: string,
    titleId: string,
    options?: DownloadOptions
): Promise<Buffer | null> {
    try {
        return await downloadTicket(baseUrl, titleId, options);
    } catch (error) {
        options?.signal?.throwIfAborted();
        logger.warn(
            'download',
            `optional ticket unavailable for ${titleId}: ${formatLogError(error)}`
        );
        return null;
    }
}

export async function downloadTmd(
    baseUrl: string,
    titleId: string,
    options?: DownloadOptions
): Promise<Buffer> {
    return downloadBytes(getTmdUrl(baseUrl, titleId), 'tmd', options);
}

export async function downloadContent(
    baseUrl: string,
    titleId: string,
    contentId: number,
    options?: DownloadOptions
): Promise<Buffer> {
    return downloadBytes(
        getContentUrl(baseUrl, titleId, contentId),
        `content ${formatContentId(contentId)}`,
        options
    );
}

export async function downloadContentH3(
    baseUrl: string,
    titleId: string,
    contentId: number,
    options?: DownloadOptions
): Promise<Buffer> {
    return downloadBytes(
        getContentH3Url(baseUrl, titleId, contentId),
        `content ${formatContentId(contentId)}.h3`,
        options
    );
}

export async function downloadContentToFile(
    baseUrl: string,
    titleId: string,
    contentId: number,
    targetFile: string,
    options?: DownloadOptions
): Promise<void> {
    return downloadFile(
        getContentUrl(baseUrl, titleId, contentId),
        targetFile,
        `content ${formatContentId(contentId)}`,
        options
    );
}

export async function downloadContentH3ToFile(
    baseUrl: string,
    titleId: string,
    contentId: number,
    targetFile: string,
    options?: DownloadOptions
): Promise<void> {
    return downloadFile(
        getContentH3Url(baseUrl, titleId, contentId),
        targetFile,
        `content ${formatContentId(contentId)}.h3`,
        options
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

function buildDownloadUrl(
    baseUrl: string,
    titleId: string,
    suffix: string
): string {
    return new URL(
        `${titleId}/${suffix}`,
        baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    ).toString();
}

export type NusTitleMetadata = {
    titleId: string;
    titleVersion: number;
    name: string | null;
    region: string | null;
    productCode: string | null;
    companyCode: string | null;
    titleKey: Buffer | null;
    titleKeyPassword: string | null;
    metaJson: Record<string, unknown> | null;
};

export type ChildTitleMetadata = {
    titleId: string;
    childTitleId: string;
    exists: boolean;
    titleVersion: number | null;
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

type ResolvedTitleKey = {
    titleKey: Buffer;
    decryptedFst: Buffer;
    encryptedTitleKey: Buffer | null;
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
    commonKey: Buffer;
    encryptedFst: Buffer;
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

export const CERT_TITLE_FILE = 'title.cert';
const THREE_DS_CONTENT_BASE_URLS = [
    'https://ccs.cdn.c.shop.nintendowifi.net/ccs/download/',
    'http://ccs.cdn.c.shop.nintendowifi.net/ccs/download/',
    'http://nus.cdn.c.shop.nintendowifi.net/ccs/download/',
] as const;

const GENERATED_TIK_TEMPLATE = Buffer.from([
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

const THREE_DS_P12_DOWNLOAD_URLS_BASE64 = [
    'aHR0cHM6Ly9naXRodWIuY29tL2xhcnNlbnYvTmludGVuZG9DZXJ0cy9yYXcvcmVmcy9oZWFkcy9tYXN0ZXIvY3RyLWNvbW1vbi0xLnAxMg==',
    'aHR0cHM6Ly93ZWIuYXJjaGl2ZS5vcmcvMjAyNjA3MDcyMDQxMzkvaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2xhcnNlbnYvTmludGVuZG9DZXJ0cy9yZWZzL2hlYWRzL21hc3Rlci9jdHItY29tbW9uLTEucDEy',
] as const;

const THREE_DS_CLIENT_CERT_PASSWORD = 'alpine';

let defaultCertPromise: Promise<Buffer> | null = null;
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
            errors.push(`${url}: ${formatLogError(error)}`);
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

    const tik = await downloadOptionalTicket(baseUrl, titleId, downloadOptions);

    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));
    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${titleId}`
        );
    }

    const ticket = tik ? readTik(tik) : null;
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
        if (tmd.header.systemType !== 'wiiu') {
            logger.warn(
                'metadata',
                `unsupported ${tmd.header.systemType} TMD for ${titleId}`
            );
            return createBasicNusTitleMetadata(titleId, tmd);
        }

        const commonKey = Buffer.from(await loadKeys('wiiu'), 'hex');
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
            `failed to enrich metadata for ${titleId}: ${formatLogError(error)}`
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
    download: () => Promise<Buffer>
): Promise<Buffer | null> {
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
    titleKey: Buffer;
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
    decryptedFst: Buffer;
    downloadOptions?: DownloadOptions;
    tmd: Tmd;
    titleId: string;
    titleKey: Buffer;
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
                info: metaXml
                    ? normalizeMetaXmlInformation(readMetaXml(metaXml))
                    : null,
                raw: metaXml ? readMetaXmlJson(metaXml) : null,
            };
        }

        default:
            return { info: null, raw: null };
    }
}

async function extractThreeDSMetadataFromTitle(
    tmd: Tmd,
    titleKey: Buffer,
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
): Promise<Buffer | null> {
    if (!ticket || ticket.commonKeyIndex === null) {
        return null;
    }

    try {
        const keys = await loadKeys('3ds');
        const commonKeyY = keys.commonKeyYs[ticket.commonKeyIndex];
        if (!keys.slot0x3dKeyX || !commonKeyY) {
            return null;
        }
        const commonKey = deriveThreeDSNormalKey(
            Buffer.from(keys.slot0x3dKeyX, 'hex'),
            Buffer.from(commonKeyY, 'hex'),
            Buffer.from(keys.generatorConstant, 'hex')
        );
        return decryptTitleKey(ticket.encryptedKey, commonKey, ticket.titleId);
    } catch (error) {
        logger.warn(
            'metadata',
            `failed to decrypt 3DS ticket title key: ${formatLogError(error)}`
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
): Promise<Buffer | null> {
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
    encryptedContent: Buffer,
    titleKey: Buffer,
    content: TmdContent,
    titleId: Buffer
): ThreeDSContentMetadataReadResult {
    const decrypt = (iv: Buffer) =>
        isHashedContent(content)
            ? decryptHashedContent(encryptedContent, titleKey, iv)
            : decryptContentWithIv(encryptedContent, titleKey, iv);
    const candidates: Array<[string, Buffer]> = [
        ['content index IV', createContentIv(content.index)],
        ['title ID IV', createTitleKeyIv(titleId)],
        ['zero IV', Buffer.alloc(16)],
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
    content: Buffer
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

    const smdhResult = inspectSmdhMetadata(iconResult.file);
    if (!smdhResult.ok) {
        return smdhResult;
    }

    if (!ncch.productCode && !smdhResult.metadata) {
        return {
            ok: false,
            reason: 'NCCH/SMDH had no usable title metadata',
        };
    }

    const title = getPreferredValue(
        smdhResult.metadata.titles,
        SMDH_TITLE_ENGLISH_INDEX
    );
    return {
        ok: true,
        metadata: {
            name: title?.longDescription || title?.shortDescription || null,
            publisher: title?.publisher || null,
            region: normalizeRegion(
                smdhResult.metadata.region,
                ncch.productCode
            ),
            productCode: ncch.productCode,
        },
    };
}

function normalizeMetaXmlInformation(
    info: MetaXmlInformation | null
): MetaXmlInformation | null {
    return info
        ? {
              ...info,
              region: normalizeRegion(info.region, info.productCode) || null,
          }
        : null;
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

export function createGeneratedTik({
    titleId,
    encryptedTitleKey,
    titleVersion,
}: GeneratedTikInput): Buffer {
    return createTikFromTemplate(GENERATED_TIK_TEMPLATE, {
        titleId,
        encryptedTitleKey,
        titleVersion,
    });
}

export type GeneratedCertOptions = {
    ticketBytes?: Buffer | null;
};

export async function createGeneratedCert(
    tmd: Tmd,
    options: GeneratedCertOptions = {}
): Promise<Buffer> {
    const { certificate1, certificate2 } = tmd.certificates;

    if (!certificate1 || !certificate2) {
        throw new TitleMetadataError(
            'generate_cert',
            'TMD is missing certificate data'
        );
    }

    const authorityCert = await resolveTitleCertAuthority(options);

    return Buffer.concat([
        Buffer.from(certificate1.raw),
        Buffer.from(certificate2.raw),
        Buffer.from(authorityCert),
    ]);
}

function extractTitleCertAuthority(ticket: Buffer): Buffer | null {
    return readTikAuthorityCertificate(ticket);
}

async function resolveTitleCertAuthority(
    options: GeneratedCertOptions
): Promise<Buffer> {
    if (options.ticketBytes) {
        const ticketCert = extractTitleCertAuthority(options.ticketBytes);
        if (ticketCert) {
            return ticketCert;
        }
    }

    return readDefaultCert();
}

async function readDefaultCert(): Promise<Buffer> {
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

            return Buffer.from(
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

export async function extractMetaXmlFromTitle(
    decryptedFst: Buffer,
    tmd: Tmd,
    titleKey: Buffer,
    baseUrl: string,
    titleId: string,
    downloadOptions?: DownloadOptions
): Promise<Buffer | null> {
    return extractMetaXmlFromContentReader(
        decryptedFst,
        tmd,
        titleKey,
        titleId,
        (content) =>
            downloadContent(baseUrl, titleId, content.id, downloadOptions)
    );
}

export async function extractMetaXmlFromContentReader(
    decryptedFst: Buffer,
    tmd: Tmd,
    titleKey: Buffer,
    titleId: string,
    readEncryptedContent: (content: TmdContent) => Promise<Buffer | null>
): Promise<Buffer | null> {
    const entries = parseFstEntries(decryptedFst, tmd);
    const metaEntry =
        entries.find((entry) =>
            WIIU_META_XML_PATHS.some((file) => file === entry.fullPath)
        ) ?? null;

    if (!metaEntry || metaEntry.isDirectory) {
        return null;
    }
    const content = tmd.contents[metaEntry.contentId];
    if (!content) {
        return null;
    }

    const encryptedContent = await readEncryptedContent(content);
    if (!encryptedContent) {
        return null;
    }

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
    encryptedContent: Buffer,
    titleKey: Buffer,
    contentIndex: number,
    extractWithHash: boolean,
    titleId: Buffer,
    entry: FstEntry
): Buffer | null {
    const decrypt = (iv: Buffer) =>
        extractWithHash
            ? decryptHashedContent(encryptedContent, titleKey, iv)
            : decryptContentWithIv(encryptedContent, titleKey, iv);

    const candidates = [
        createContentIv(contentIndex),
        createTitleKeyIv(titleId),
        Buffer.alloc(16),
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
    decryptedContent: Buffer,
    entry: FstEntry
): Buffer | null {
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

function parseFstEntries(decryptedFst: Buffer, tmd: Tmd): FstEntry[] {
    return parseTitleFstEntries(decryptedFst, tmd);
}

function startsWithXml(buffer: Buffer | null): boolean {
    if (!buffer || buffer.length === 0) {
        return false;
    }
    const text = Buffer.from(
        buffer.subarray(0, Math.min(buffer.length, 16))
    ).toString('latin1');
    return text.includes('<?xml') || text.includes('<menu');
}

function sliceRange(
    buffer: Buffer,
    offset: number,
    length: number
): Buffer | null {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
        return null;
    }
    return buffer.slice(offset, offset + length);
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
