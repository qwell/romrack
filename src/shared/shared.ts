import { Request } from 'express';
import { TitleKinds } from './titles.js';

export function toArray<T>(value: T | readonly T[] | null | undefined): T[] {
    if (value == null) {
        return [];
    }

    return Array.isArray(value)
        ? Array.from(value as readonly T[])
        : [value as T];
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function formatSize(sizeBytes: number | null): string {
    if (sizeBytes === null || sizeBytes === undefined) {
        return '-';
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

    const workerCount = Math.max(
        1,
        Math.min(Math.floor(concurrency) || 1, items.length)
    );

    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index], index);
        }
    });

    await Promise.all(workers);
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

export function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function nullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getStringQuery(req: Request, name: string): string | null {
    const value = req.query[name];
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function formatTitleDisplayName(
    name: string | null,
    titleId: string,
    kind: TitleKinds | null
): string {
    const label = name ?? titleId;
    return kind ? `${label} [${getTitleKindDisplayName(kind)}]` : label;
}

function getTitleKindDisplayName(kind: TitleKinds): string {
    return kind === TitleKinds.Base ? 'Game' : kind;
}
