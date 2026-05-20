import { type Response } from 'express';
import { type ApiErrorResponse } from '../shared/api.js';

export function sendServerError(
    res: Response,
    publicError: string,
    error: unknown,
    options: { includeDetails?: boolean } = {}
): void {
    const body: ApiErrorResponse = {
        error: publicError,
    };

    if (options.includeDetails) {
        body.message = error instanceof Error ? error.message : String(error);
        body.stage = getErrorStage(error);
    }

    res.status(500).json(body);
}

function getErrorStage(error: unknown): string | null {
    return typeof error === 'object' &&
        error !== null &&
        'stage' in error &&
        typeof error.stage === 'string'
        ? error.stage
        : null;
}

export * from './routes/config.js';
export * from './routes/delete.js';
export * from './routes/download.js';
export * from './routes/icon.js';
export * from './routes/library.js';
export * from './routes/storage.js';
export * from './routes/title.js';
