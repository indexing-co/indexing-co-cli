export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  API: 5,
  NOT_FOUND: 6,
  VALIDATION: 7,
  INTERRUPTED: 130,
} as const;

export class CliError extends Error {
  exitCode: number;
  hint?: string;
  details?: unknown;

  constructor(message: string, exitCode: number = EXIT_CODES.FAILURE, options: { hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new CliError("The request timed out.", EXIT_CODES.NETWORK);
  }

  if (error instanceof Error) {
    return new CliError(error.message, EXIT_CODES.FAILURE);
  }

  return new CliError("An unknown error occurred.", EXIT_CODES.FAILURE, { details: error });
}
