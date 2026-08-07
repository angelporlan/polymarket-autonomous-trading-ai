import {
  PUSD_SCALE,
  formatMicros,
  parseDecimalToMicros
} from "../domain/types.js";

export const EUR_SCALE = 1_000_000n;
export const EUR_QUOTE_MAX_AGE_MS = 24 * 60 * 60_000;
export const EUR_QUOTE_MAX_VALIDITY_MS = 7 * 24 * 60 * 60_000;

export interface EurFxQuote {
  baseCurrency: "pUSD";
  quoteCurrency: "EUR";
  rateEurPerPusdMicros: bigint;
  observedAtMs: number;
  validUntilMs: number;
  sourceName: string;
  sourceUrl: string;
}

export interface EurFxQuoteInput {
  baseCurrency: "pUSD";
  quoteCurrency: "EUR";
  rateEurPerPusd: string;
  observedAt: string;
  validUntil: string;
  sourceName: string;
  sourceUrl: string;
}

export class EurValuationError extends Error {
  readonly code:
    | "EUR_QUOTE_INVALID"
    | "EUR_QUOTE_MISSING"
    | "EUR_QUOTE_STALE"
    | "EUR_QUOTE_NOT_YET_VALID";

  constructor(
    code: EurValuationError["code"],
    message: string
  ) {
    super(message);
    this.name = "EurValuationError";
    this.code = code;
  }
}

export function parseEurFxQuote(value: unknown): EurFxQuote {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote must be an object."
    );
  }
  const record = value as Record<string, unknown>;
  if (record.baseCurrency !== "pUSD" || record.quoteCurrency !== "EUR") {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "Only pUSD-to-EUR quotes are supported."
    );
  }
  const rate = record.rateEurPerPusd;
  const observedAt = parseTimestamp(record.observedAt, "observedAt");
  const validUntil = parseTimestamp(record.validUntil, "validUntil");
  if (
    typeof rate !== "string" ||
    !/^\d+(?:\.\d{1,6})?$/u.test(rate)
  ) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote rate must be a positive fixed decimal."
    );
  }
  let rateMicros: bigint;
  try {
    rateMicros = parseDecimalToMicros(rate);
  } catch {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote rate is malformed."
    );
  }
  if (
    rateMicros <= 0n ||
    validUntil < observedAt ||
    validUntil - observedAt > EUR_QUOTE_MAX_VALIDITY_MS
  ) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote validity interval is invalid."
    );
  }
  const sourceName = readSourceText(record.sourceName, "sourceName");
  const sourceUrl = readSourceUrl(record.sourceUrl);
  return {
    baseCurrency: "pUSD",
    quoteCurrency: "EUR",
    rateEurPerPusdMicros: rateMicros,
    observedAtMs: observedAt,
    validUntilMs: validUntil,
    sourceName,
    sourceUrl
  };
}

export function validateEurFxQuote(
  quote: EurFxQuote | null | undefined,
  valuationAtMs: number
): EurFxQuote {
  if (quote === null || quote === undefined) {
    throw new EurValuationError(
      "EUR_QUOTE_MISSING",
      "No EUR quote was supplied for accounting valuation."
    );
  }
  if (
    !Number.isSafeInteger(valuationAtMs) ||
    valuationAtMs <= 0 ||
    quote.baseCurrency !== "pUSD" ||
    quote.quoteCurrency !== "EUR" ||
    quote.rateEurPerPusdMicros <= 0n ||
    !Number.isSafeInteger(quote.observedAtMs) ||
    !Number.isSafeInteger(quote.validUntilMs) ||
    quote.observedAtMs > valuationAtMs ||
    quote.validUntilMs < valuationAtMs
  ) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote is not valid at the valuation timestamp."
    );
  }
  if (valuationAtMs - quote.observedAtMs > EUR_QUOTE_MAX_AGE_MS) {
    throw new EurValuationError(
      "EUR_QUOTE_STALE",
      "The EUR quote is too old for accounting valuation."
    );
  }
  return quote;
}

export function convertPusdToEurMicros(
  pusdMicros: bigint,
  quote: EurFxQuote
): bigint {
  const negative = pusdMicros < 0n;
  const absolute = negative ? -pusdMicros : pusdMicros;
  const numerator = absolute * quote.rateEurPerPusdMicros;
  const quotient = numerator / PUSD_SCALE;
  const remainder = numerator % PUSD_SCALE;
  const rounded = quotient + (remainder * 2n >= PUSD_SCALE ? 1n : 0n);
  return negative ? -rounded : rounded;
}

export function formatEurMicros(value: bigint): string {
  return formatMicros(value);
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      `The EUR quote ${field} timestamp is invalid.`
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      `The EUR quote ${field} timestamp is invalid.`
    );
  }
  return parsed;
}

function readSourceText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      `The EUR quote ${field} is invalid.`
    );
  }
  return value.trim();
}

function readSourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote source URL is invalid."
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote source URL is invalid."
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new EurValuationError(
      "EUR_QUOTE_INVALID",
      "The EUR quote source URL must be HTTPS without credentials."
    );
  }
  return url.toString();
}
