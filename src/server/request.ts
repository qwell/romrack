import { type Request, type Response } from 'express';
import { type ApiErrorResponse } from '../shared/api.js';
import {
    identifyTitle,
    identifyWiiUTitle,
    type TitleIdentity,
} from '../shared/titles.js';
import { formatLogError } from '../shared/utils.js';

type TitleQueryResult =
    | {
          ok: true;
          title: TitleIdentity;
      }
    | {
          ok: false;
          error: string;
      };

type WiiUTitleQueryResult =
    | {
          ok: true;
          title: TitleIdentity;
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

    const titleIdentity = identifyTitle(titleId);
    if (!titleIdentity) {
        return {
            ok: false,
            error: 'titleId query parameter must be a Wii U title ID, 3DS title ID, or Wii product code',
        };
    }

    return {
        ok: true,
        title: titleIdentity,
    };
}

export function getWiiUTitleQuery(req: Request): WiiUTitleQueryResult {
    const titleId = getStringQuery(req, 'titleId');

    if (!titleId) {
        return {
            ok: false,
            error: 'Missing titleId query parameter',
        };
    }

    const titleIdentity = identifyWiiUTitle(titleId);
    if (!titleIdentity) {
        return {
            ok: false,
            error: 'titleId query parameter must be 16 hexadecimal characters',
        };
    }

    return {
        ok: true,
        title: titleIdentity,
    };
}

function requireTitleQueryResult<TTitle>(
    req: Request,
    res: Response,
    getResult: (req: Request) =>
        | {
              ok: true;
              title: TTitle;
          }
        | {
              ok: false;
              error: string;
          }
): TTitle | null {
    const result = getResult(req);
    if (result.ok) {
        return result.title;
    }

    res.status(400).json({
        error: result.error,
    });
    return null;
}

export function requireTitleQuery(
    req: Request,
    res: Response
): TitleIdentity | null {
    return requireTitleQueryResult(req, res, getTitleQuery);
}

export function requireWiiUTitleQuery(
    req: Request,
    res: Response
): TitleIdentity | null {
    return requireTitleQueryResult(req, res, getWiiUTitleQuery);
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
        body.message = formatLogError(error);
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
