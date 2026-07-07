import fs from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { type TitleMediaType, type TitlePlatform } from '../shared/titles.js';
import { getUserAppRoot } from './paths.js';

export type CachedImage = {
    body: Buffer;
    contentType: string;
};

const mediaCacheDir = path.join(getUserAppRoot(), '.cache');
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MEDIA_EXTENSIONS = ['.png', '.jpg'] as const;
const mediaUrlReads = new Map<string, Promise<CachedImage>>();

export function getImageContentType(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        default:
            return 'application/octet-stream';
    }
}

async function readBodyWithLimit(
    response: Response,
    url: string
): Promise<Buffer> {
    if (!response.body) {
        throw new Error(`image fetch returned no body for ${url}`);
    }

    const reader =
        response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            total += value.length;
            if (total > MAX_BODY_BYTES) {
                throw new Error(
                    `image exceeded ${MAX_BODY_BYTES.toString()} bytes: ${url}`
                );
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks, total);
}

function isRedirectStatus(status: number): boolean {
    return status >= 300 && status < 400;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function readNodeResponseWithLimit(
    response: IncomingMessage,
    url: string
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;

        response.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                response.destroy(
                    new Error(
                        `image exceeded ${MAX_BODY_BYTES.toString()} bytes: ${url}`
                    )
                );
                return;
            }
            chunks.push(chunk);
        });

        response.on('end', () => {
            resolve(Buffer.concat(chunks, total));
        });
        response.on('error', reject);
    });
}

function fetchImageInsecure(
    url: string,
    redirectsRemaining = MAX_REDIRECTS
): Promise<CachedImage> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;
        const request =
            parsed.protocol === 'https:'
                ? https.get(
                      parsed,
                      { rejectUnauthorized: false },
                      (response) => {
                          void handleResponse(response);
                      }
                  )
                : client.get(parsed, (response) => {
                      void handleResponse(response);
                  });

        const timeout = setTimeout(() => {
            request.destroy(
                new Error(
                    `image fetch timed out after ${FETCH_TIMEOUT_MS.toString()}ms for ${url}`
                )
            );
        }, FETCH_TIMEOUT_MS);

        async function handleResponse(
            response: IncomingMessage
        ): Promise<void> {
            const statusCode = response.statusCode ?? 0;

            if (isRedirectStatus(statusCode) && response.headers.location) {
                response.resume();
                if (redirectsRemaining <= 0) {
                    reject(new Error(`too many redirects fetching ${url}`));
                    return;
                }
                const nextUrl = new URL(response.headers.location, url);
                try {
                    resolve(
                        await fetchImageInsecure(
                            nextUrl.toString(),
                            redirectsRemaining - 1
                        )
                    );
                } catch (error) {
                    reject(toError(error));
                }
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(
                    new Error(
                        `image fetch failed for ${url}: ${statusCode.toString()}`
                    )
                );
                return;
            }

            try {
                const body = await readNodeResponseWithLimit(response, url);
                const contentTypeHeader = response.headers['content-type'] as
                    | string
                    | string[]
                    | undefined;
                const contentType = Array.isArray(contentTypeHeader)
                    ? (contentTypeHeader[0] ?? 'application/octet-stream')
                    : (contentTypeHeader ?? 'application/octet-stream');
                resolve({ body, contentType });
            } catch (error) {
                reject(toError(error));
            }
        }

        request.on('error', reject);
        request.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

async function fetchImage(url: string): Promise<CachedImage> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
    }).catch((error: unknown) => {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:') {
            return fetchImageInsecure(url);
        }
        throw new Error(`image fetch failed for ${url}`, { cause: error });
    });

    if (!(response instanceof Response)) {
        return response;
    }

    if (!response.ok) {
        throw new Error(
            `image fetch failed for ${url}: ${response.status.toString()}`
        );
    }

    const body = await readBodyWithLimit(response, url);
    const contentType =
        response.headers.get('content-type') ?? 'application/octet-stream';

    return { body, contentType };
}

async function writeFile(
    targetPath: string,
    data: Buffer | string
): Promise<void> {
    const tempPath = `${targetPath}.${process.pid}.${Date.now().toString()}.tmp`;
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, targetPath);
}

function getTitleMediaDir(
    type: TitleMediaType,
    platform: TitlePlatform
): string {
    return path.join(mediaCacheDir, type, platform);
}

function getTitleMediaKey(productCode: string): string {
    return productCode.trim().toUpperCase();
}

function getTitleMediaExtension(
    image: CachedImage,
    url: string
): '.jpg' | '.png' {
    const contentType = image.contentType.toLowerCase().split(';')[0]?.trim();
    switch (contentType) {
        case 'image/png':
            return '.png';
        case 'image/jpeg':
        case 'image/jpg':
            return '.jpg';
    }

    const extension = path.extname(safeUrlPathname(url) ?? url).toLowerCase();
    switch (extension) {
        case '.png':
            return '.png';
        case '.jpg':
        case '.jpeg':
            return '.jpg';
        default:
            throw new Error(
                `unsupported title media content type for ${url}: ${image.contentType}`
            );
    }
}

function safeUrlPathname(url: string): string | null {
    try {
        return new URL(url).pathname;
    } catch {
        return null;
    }
}

function getTitleMediaPath(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string,
    extension: '.jpg' | '.png'
): string {
    return path.join(
        getTitleMediaDir(type, platform),
        `${productCode}${extension}`
    );
}

export async function readCachedTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage | null> {
    const mediaKey = getTitleMediaKey(productCode);
    for (const extension of MEDIA_EXTENSIONS) {
        const filePath = getTitleMediaPath(type, platform, mediaKey, extension);
        try {
            return {
                body: await fs.readFile(filePath),
                contentType: getImageContentType(filePath),
            };
        } catch {
            continue;
        }
    }

    return null;
}

async function fetchAndCacheTitleMedia(
    url: string,
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage> {
    const image = await fetchImage(url);
    const extension = getTitleMediaExtension(image, url);
    const filePath = getTitleMediaPath(type, platform, productCode, extension);

    await fs.mkdir(getTitleMediaDir(type, platform), { recursive: true });
    await writeFile(filePath, image.body);

    return {
        body: image.body,
        contentType: getImageContentType(filePath),
    };
}

export async function readTitleMediaFromUrl(
    url: string,
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string
): Promise<CachedImage> {
    const mediaKey = getTitleMediaKey(productCode);

    const cached = await readCachedTitleMedia(type, platform, mediaKey);
    if (cached) {
        return cached;
    }

    const pendingKey = `${type}:${platform}:${mediaKey}`;
    const pending =
        mediaUrlReads.get(pendingKey) ??
        fetchAndCacheTitleMedia(url, type, platform, mediaKey).finally(() => {
            mediaUrlReads.delete(pendingKey);
        });
    mediaUrlReads.set(pendingKey, pending);
    return pending;
}

export async function cacheTitleMedia(
    type: TitleMediaType,
    platform: TitlePlatform,
    productCode: string,
    image: CachedImage
): Promise<void> {
    const mediaKey = getTitleMediaKey(productCode);
    const extension = getTitleMediaExtension(image, `${mediaKey}.png`);
    const filePath = getTitleMediaPath(type, platform, mediaKey, extension);

    await fs.mkdir(getTitleMediaDir(type, platform), { recursive: true });
    await writeFile(filePath, image.body);
}
