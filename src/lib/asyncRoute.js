import { errorToResponse } from './errors.js';

// Wraps a route handler so thrown domain errors (ValidationError, NotFoundError,
// ConflictError) become the right HTTP status instead of a generic 500, and
// unexpected errors still flow to the central error handler (no stack leakage).
export function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      const mapped = errorToResponse(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      next(err);
    }
  };
}
