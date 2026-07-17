import { identifyTitle, normalizeTitleName } from './titles.js';

export function toArray<T>(value: T | readonly T[] | null | undefined): T[] {
    if (value == null) {
        return [];
    }

    return Array.isArray(value)
        ? Array.from(value as readonly T[])
        : [value as T];
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function mapConcurrent<T, U>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
    if (items.length === 0) {
        return [];
    }

    const results = new Array<U>(items.length);
    let cursor = 0;
    let failure: { error: unknown } | null = null;

    const workerCount = Math.max(
        1,
        Math.min(Math.floor(concurrency) || 1, items.length)
    );

    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length && failure === null) {
            const index = cursor++;
            try {
                results[index] = await mapper(items[index], index);
            } catch (error) {
                failure ??= { error };
            }
        }
    });

    await Promise.all(workers);
    const caughtFailure = failure as { error: unknown } | null;
    if (caughtFailure !== null) {
        throw caughtFailure.error;
    }

    return results;
}

export function formatLogError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const cause = 'cause' in error ? error.cause : undefined;
    if (cause === undefined) {
        return error.message;
    }

    return `${error.message}; cause: ${formatLogError(cause)}`;
}

export function formatSize(sizeBytes: number | null): string {
    if (sizeBytes === null || sizeBytes === undefined) {
        return '';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = sizeBytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatTitleDisplay(
    name: string | null,
    titleId: string,
    version: number | null = null
): string {
    const title = identifyTitle(titleId);
    if (!title) {
        return '';
    }

    const label = name ?? titleId;
    const versionText = version === null ? '' : ` v${version}`;
    let kindText = '';
    if (title.kind) {
        switch (title.platform) {
            case '3ds':
                break;
            case 'wiiu':
                kindText = ` [${title.kind}]`;
                break;
            case 'wii':
                break;
        }
    }
    const titleIdText = name === null ? '' : ` ${titleId}`;
    return `${label}${versionText}${kindText}${titleIdText}`;
}

export function isNonEmptyString(value: string): boolean {
    return value.length > 0;
}

export function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function nullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readNullTerminatedString(
    buffer: Buffer,
    offset: number,
    encoding: BufferEncoding = 'utf8'
): string {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) {
        end += 1;
    }
    return buffer.toString(encoding, offset, end);
}

export function safeDirectoryName(value: string): string {
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

export function latestVersion(versions: number[]): number[] {
    return versions.length === 0 ? [] : [versions[versions.length - 1]];
}
