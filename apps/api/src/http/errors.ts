export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new HttpError(401, 'unauthorized', message);
  }
  static forbidden(message = 'You do not have permission to do this') {
    return new HttpError(403, 'forbidden', message);
  }
  static notFound(message = 'Not found') {
    return new HttpError(404, 'not_found', message);
  }
  static conflict(message: string) {
    return new HttpError(409, 'conflict', message);
  }
}

/** Maps Postgres unique-violation errors to a 409 with a readable message. */
export function mapDbError(err: unknown, conflictMessage: string): never {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    throw HttpError.conflict(conflictMessage);
  }
  throw err;
}
