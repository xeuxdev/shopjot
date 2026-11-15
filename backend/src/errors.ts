export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireRule(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ApiError(422, 'INVALID_OPERATION', message);
}
