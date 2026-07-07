import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import logger from '../shared/logger.js';
import { formatContentId } from './formats/content.js';
import { HttpError } from '../shared/download.js';

export const WII_U_NUS_BASE_URL =
    'http://ccs.cdn.wup.shop.nintendo.net/ccs/download';
export const THREE_DS_NUS_BASE_URL =
    'https://ccs.c.shop.nintendowifi.net/ccs/download/';

export const DEFAULT_CERT_TITLE_ID = '000500101000400a'; // OSv10

const TIK_TITLE_FILE_CDN = 'cetk';

export type DownloadOptions = {
    signal?: AbortSignal;
    cert?: string;
    key?: string;
    pfx?: Buffer;
    passphrase?: string;
    allowSelfSignedCertificate?: boolean;
};

export async function downloadTicket(
    baseUrl: string,
    titleId: string,
    options?: DownloadOptions
): Promise<Uint8Array> {
    return downloadBinary(getTicketUrl(baseUrl, titleId), 'ticket', options);
}

export async function downloadTmd(
    baseUrl: string,
    titleId: string,
    options?: DownloadOptions
): Promise<Uint8Array> {
    return downloadBinary(getTmdUrl(baseUrl, titleId), 'tmd', options);
}

export async function downloadContent(
    baseUrl: string,
    titleId: string,
    contentId: number,
    options?: DownloadOptions
): Promise<Uint8Array> {
    return downloadBinary(
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
): Promise<Uint8Array> {
    return downloadBinary(
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
    return downloadBinaryToFile(
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
    return downloadBinaryToFile(
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
        ensureTrailingSlash(baseUrl)
    ).toString();
}

async function downloadBinary(
    url: string,
    label = 'file',
    options: DownloadOptions = {}
): Promise<Uint8Array> {
    logger.log('download', `downloading ${label}: ${url}`);
    const response =
        options.cert || options.pfx
            ? await fetchWithClientCert(url, options)
            : await fetch(url, { signal: options.signal });
    if (!response.ok) {
        throw new HttpError(url, response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    logger.log(
        'download',
        `downloaded ${label}: ${url} (${bytes.length} bytes)`
    );
    return bytes;
}

async function downloadBinaryToFile(
    url: string,
    targetFile: string,
    label = 'file',
    options: DownloadOptions = {}
): Promise<void> {
    logger.log('download', `downloading ${label}: ${url}`);
    const response =
        options.cert || options.pfx
            ? await fetchWithClientCert(url, options)
            : await fetch(url, { signal: options.signal });
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
            { signal: options?.signal }
        );
        await rename(tempFile, targetFile);
    } catch (error) {
        await rm(tempFile, { force: true });
        throw error;
    }

    const { size } = await stat(targetFile);
    logger.log(
        'download',
        `downloaded ${label}: ${url} (${size.toString()} bytes)`
    );
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

async function fetchWithClientCert(
    url: string,
    options: DownloadOptions
): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
        return fetch(url, { signal: options.signal });
    }

    const { body, status } = await new Promise<{
        body: Uint8Array;
        status: number;
    }>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        const request = https.get(
            parsed,
            {
                rejectUnauthorized: options.allowSelfSignedCertificate !== true,
                cert: options.cert,
                key: options.key,
                pfx: options.pfx,
                passphrase: options.passphrase,
            },
            (response) => {
                response.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    resolve({
                        body: new Uint8Array(Buffer.concat(chunks)),
                        status: response.statusCode ?? 0,
                    });
                });
            }
        );

        options.signal?.addEventListener(
            'abort',
            () => {
                request.destroy(new Error('Aborted'));
            },
            { once: true }
        );
        request.on('error', reject);
    });

    return new Response(body, { status });
}
