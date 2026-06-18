import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import logger from '../shared/logger.js';
import { formatContentId } from './formats/content.js';
import { HttpError } from '../shared/download.js';

export const NUS_BASE_URL = 'http://ccs.cdn.wup.shop.nintendo.net/ccs/download';
// export const NUS_BASE_URL = 'http://ccs.cdn.c.shop.nintendowifi.net/ccs/download/';
export const DEFAULT_CERT_TITLE_ID = '000500101000400a'; // OSv10

const TIK_TITLE_FILE_CDN = 'cetk';

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

export async function downloadContentToFile(
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

export async function downloadContentH3ToFile(
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
    signal?: AbortSignal
): Promise<Uint8Array> {
    logger.log('download', `downloading ${label}: ${url}`);
    const response = await fetch(url, { signal });
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
    signal?: AbortSignal
): Promise<void> {
    logger.log('download', `downloading ${label}: ${url}`);
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
        'download',
        `downloaded ${label}: ${url} (${size.toString()} bytes)`
    );
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}
