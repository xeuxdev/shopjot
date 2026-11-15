import { ZodError } from '../domain/index';

export function userMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join(' ');
  return error instanceof Error ? error.message : fallback;
}
