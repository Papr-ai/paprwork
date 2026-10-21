import { ConflictError, ForbiddenError, NotFoundError, PlaybookError, ReviewStateError, TemplateRenderError } from '@splitin/outreach-core';
import { ImportRejectedError, ImportStaleError, ProfileError } from '@splitin/outreach-import';
import { ZodError } from 'zod';

export interface ApiError {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500;
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly string[];
}

/** Maps domain errors to HTTP. Unexpected errors never leak their message or stack. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ZodError) {
    return { status: 400, code: 'invalid_request', message: 'request body is invalid', issues: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  if (error instanceof SyntaxError) return { status: 400, code: 'invalid_json', message: 'request body is not valid JSON' };
  if (error instanceof ForbiddenError) return { status: 403, code: 'forbidden', message: error.message };
  if (error instanceof NotFoundError) return { status: 404, code: 'not_found', message: error.message };
  if (error instanceof ConflictError || error instanceof ImportStaleError || error instanceof ReviewStateError) {
    return { status: 409, code: 'conflict', message: error.message };
  }
  if (error instanceof PlaybookError || error instanceof ProfileError) return { status: 422, code: 'invalid_definition', message: 'definition is invalid', issues: error.issues };
  if (error instanceof ImportRejectedError || error instanceof TemplateRenderError) return { status: 422, code: 'unprocessable', message: error.message };
  return { status: 500, code: 'internal', message: 'internal error' };
}
