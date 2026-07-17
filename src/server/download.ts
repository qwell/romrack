import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError } from '../shared/download.js';
import logger from '../shared/logger.js';

export type DownloadOptions = {
    signal?: AbortSignal;
    cert?: string;
    key?: string;
    pfx?: Buffer;
    passphrase?: string;
    allowSelfSignedCertificate?: boolean;
};

export async function downloadBytes(
    url: string,
    label = 'file',
    options: DownloadOptions = {}
): Promise<Buffer> {
    logger.log('download', `downloading ${label}: ${url}`);
    const response = await fetchDownload(url, options);
    if (!response.ok) {
        throw new HttpError(url, response.status);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    logger.log(
        'download',
        `downloaded ${label}: ${url} (${bytes.length.toString()} bytes)`
    );
    return bytes;
}

export async function downloadFile(
    url: string,
    targetFile: string,
    label = 'file',
    options: DownloadOptions = {}
): Promise<void> {
    logger.log('download', `downloading ${label}: ${url}`);
    const response = await fetchDownload(url, options);
    if (!response.ok) {
        throw new HttpError(url, response.status);
    }
    if (!response.body) {
        throw new Error(`download failed for ${url}: empty response body`);
    }

    const tempFile = `${targetFile}.${process.pid.toString()}.${randomUUID()}.download`;
    try {
        await pipeline(
            Readable.fromWeb(response.body),
            createWriteStream(tempFile),
            { signal: options.signal }
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

async function fetchDownload(
    url: string,
    options: DownloadOptions
): Promise<Response> {
    return options.cert || options.pfx
        ? fetchWithClientCertificate(url, options)
        : fetch(url, { signal: options.signal });
}

async function fetchWithClientCertificate(
    url: string,
    options: DownloadOptions
): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
        return fetch(url, { signal: options.signal });
    }

    const { body, status } = await new Promise<{
        body: Buffer;
        status: number;
    }>((resolve, reject) => {
        const chunks: Buffer[] = [];
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
                        body: Buffer.concat(chunks),
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
