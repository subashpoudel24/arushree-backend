export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'Please sign in to continue.') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new ApiError(403, 'forbidden', message);
