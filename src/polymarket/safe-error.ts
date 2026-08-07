const MAX_SAFE_MESSAGE_LENGTH = 280;

export interface SafeErrorOptions {
  code?: string;
  service?: string;
  fallbackMessage?: string;
  submissionMayHaveReachedCLOB?: boolean;
}

/**
 * Error safe to persist in the local ledger or return through MCP.
 *
 * It deliberately does not retain the original error as `cause`: errors from
 * HTTP and signing libraries frequently carry request headers and credentials.
 */
export class SafeExternalServiceError extends Error {
  readonly code: string;
  readonly service: string | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly submissionMayHaveReachedCLOB: boolean;

  constructor(
    message: string,
    options: {
      code: string;
      service?: string;
      status?: number;
      retryable?: boolean;
      submissionMayHaveReachedCLOB?: boolean;
    }
  ) {
    super(message);
    this.name = "SafeExternalServiceError";
    this.code = options.code;
    this.service = options.service;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
    this.submissionMayHaveReachedCLOB =
      options.submissionMayHaveReachedCLOB === true;
  }
}

export function toSafeExternalError(
  error: unknown,
  options: SafeErrorOptions = {}
): SafeExternalServiceError {
  if (error instanceof SafeExternalServiceError) {
    return error;
  }

  const status = readFiniteNumber(error, "status");
  const sourceMessage =
    readString(error, "message") ??
    readString(error, "error") ??
    options.fallbackMessage ??
    "The external service request failed.";
  const message = sanitizeErrorMessage(sourceMessage);

  return new SafeExternalServiceError(message, {
    code: options.code ?? "EXTERNAL_SERVICE_ERROR",
    ...(options.service === undefined ? {} : { service: options.service }),
    ...(status === undefined ? {} : { status }),
    retryable: isRetryableStatus(status) || isRetryableNetworkError(error),
    submissionMayHaveReachedCLOB: options.submissionMayHaveReachedCLOB === true
  });
}

export function toSubmissionUnknownError(error: unknown): SafeExternalServiceError {
  const safe = toSafeExternalError(error, {
    code: "CLOB_ORDER_SUBMISSION_UNKNOWN",
    service: "clob",
    fallbackMessage: "The CLOB submission result is unknown; reconciliation is required."
  });
  if (safe.submissionMayHaveReachedCLOB) {
    return safe;
  }
  return new SafeExternalServiceError(
    "The CLOB submission result is unknown; reconciliation is required.",
    {
      code: "CLOB_ORDER_SUBMISSION_UNKNOWN",
      service: safe.service ?? "clob",
      ...(safe.status === undefined ? {} : { status: safe.status }),
      retryable: false,
      submissionMayHaveReachedCLOB: true
    }
  );
}

export function isSubmissionUnknown(error: unknown): boolean {
  return (
    error instanceof SafeExternalServiceError &&
    error.submissionMayHaveReachedCLOB === true
  );
}

export function sanitizeErrorMessage(message: string): string {
  const sanitized = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /(["']?)(authorization|poly[-_ ]?api[-_ ]?key|api[-_ ]?key|apikey|private[-_ ]?key|secret|passphrase|access[-_ ]?token|refresh[-_ ]?token|token|key)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      "$1$2$1:[REDACTED]"
    )
    .replace(
      /\b(authorization|api[-_ ]?key|private[-_ ]?key|secret|passphrase|access[-_ ]?token|refresh[-_ ]?token)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1$2[REDACTED]"
    )
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, "[REDACTED_HEX]")
    .replace(/([?&](?:key|secret|token|passphrase|signature)=)[^&#\s]*/giu, "$1[REDACTED]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

  const nonEmpty = sanitized.length === 0 ? "The external service request failed." : sanitized;
  return nonEmpty.length <= MAX_SAFE_MESSAGE_LENGTH
    ? nonEmpty
    : `${nonEmpty.slice(0, MAX_SAFE_MESSAGE_LENGTH - 1)}…`;
}

export function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  );
}

function readString(value: unknown, key: string): string | undefined {
  if (value instanceof Error && key === "message") {
    return value.message;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readFiniteNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = readString(error, "code");
  const name = readString(error, "name");
  return (
    name === "AbortError" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN"
  );
}
