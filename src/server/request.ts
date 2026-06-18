import { type Request, type Response } from 'express';
import { type ApiErrorResponse } from '../shared/api.js';
import {
    normalizeTitle,
    normalizeWiiUTitle,
    type NormalizedTitle,
} from '../shared/titles.js';

type TitleQueryResult =
    | {
          ok: true;
          title: NormalizedTitle;
      }
    | {
          ok: false;
          error: string;
      };

type TitleIdQueryResult =
    | {
          ok: true;
          titleId: string;
      }
    | {
          ok: false;
          error: string;
      };

export function getStringQuery(req: Request, name: string): string | null {
    const value = req.query[name];
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function getStringBodyField(body: unknown, name: string): string {
    if (typeof body !== 'object' || body === null) {
        return '';
    }

    const value = (body as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : '';
}

export function getTitleQuery(req: Request): TitleQueryResult {
    const titleId = getStringQuery(req, 'titleId');

    if (!titleId) {
        return {
            ok: false,
            error: 'Missing titleId query parameter',
        };
    }

    const normalizedTitle = normalizeTitle(titleId);
    if (!normalizedTitle) {
        return {
            ok: false,
            error: 'titleId query parameter must be a Wii U title ID or Wii disc ID',
        };
    }

    return {
        ok: true,
        title: normalizedTitle,
    };
}

export function getTitleIdQuery(req: Request): TitleIdQueryResult {
    const result = getTitleQuery(req);
    if (!result.ok) {
        return result;
    }

    return {
        ok: true,
        titleId: result.title.titleId,
    };
}

export function getWiiUTitleIdQuery(req: Request): TitleIdQueryResult {
    const titleId = getStringQuery(req, 'titleId');

    if (!titleId) {
        return {
            ok: false,
            error: 'Missing titleId query parameter',
        };
    }

    const normalizedTitle = normalizeWiiUTitle(titleId);
    if (!normalizedTitle) {
        return {
            ok: false,
            error: 'titleId query parameter must be 16 hexadecimal characters',
        };
    }

    return {
        ok: true,
        titleId: normalizedTitle.titleId,
    };
}

function requireTitleIdQueryResult(
    req: Request,
    res: Response,
    getResult: (req: Request) => TitleIdQueryResult
): string | null {
    const result = getResult(req);
    if (result.ok) {
        return result.titleId;
    }

    res.status(400).json({
        error: result.error,
    });
    return null;
}

export function requireTitleIdQuery(
    req: Request,
    res: Response
): string | null {
    return requireTitleIdQueryResult(req, res, getTitleIdQuery);
}

export function requireWiiUTitleIdQuery(
    req: Request,
    res: Response
): string | null {
    return requireTitleIdQueryResult(req, res, getWiiUTitleIdQuery);
}

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
