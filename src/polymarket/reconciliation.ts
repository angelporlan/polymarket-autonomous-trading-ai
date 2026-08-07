import { parseDecimalToMicros } from "../domain/types.js";

const ORDER_STATUS_MAP = new Map<string, string>([
  ["ORDER_STATUS_LIVE", "LIVE"],
  ["ORDER_STATUS_INVALID", "REJECTED"],
  ["ORDER_STATUS_CANCELED_MARKET_RESOLVED", "CANCELLED"],
  ["ORDER_STATUS_CANCELED", "CANCELLED"],
  ["ORDER_STATUS_CANCELLED", "CANCELLED"],
  ["ORDER_STATUS_MATCHED", "MATCHED"],
  ["LIVE", "LIVE"],
  ["MATCHED", "MATCHED"],
  ["FILLED", "FILLED"],
  ["CANCELLED", "CANCELLED"],
  ["CANCELED", "CANCELLED"],
  ["EXPIRED", "EXPIRED"],
  ["REJECTED", "REJECTED"]
]);

const TRADE_STATUS_MAP = new Map<string, string>([
  ["TRADE_STATUS_MATCHED", "MATCHED"],
  ["TRADE_STATUS_MINED", "MINED"],
  ["TRADE_STATUS_CONFIRMED", "CONFIRMED"],
  ["TRADE_STATUS_RETRYING", "RETRYING"],
  ["TRADE_STATUS_FAILED", "FAILED"],
  ["MATCHED", "MATCHED"],
  ["MINED", "MINED"],
  ["CONFIRMED", "CONFIRMED"],
  ["RETRYING", "RETRYING"],
  ["FAILED", "FAILED"]
]);

export function normalizeClobOrderStatus(value: unknown): string {
  const status = readNonEmptyString(value, "ORDER_STATUS").toUpperCase();
  const normalized = ORDER_STATUS_MAP.get(status);
  if (normalized === undefined) {
    throw new Error("REMOTE_ORDER_STATUS_UNSUPPORTED");
  }
  return normalized;
}

export function normalizeClobTradeStatus(value: unknown): string {
  const status = readNonEmptyString(value, "TRADE_STATUS").toUpperCase();
  const normalized = TRADE_STATUS_MAP.get(status);
  if (normalized === undefined) {
    throw new Error("REMOTE_TRADE_STATUS_UNSUPPORTED");
  }
  return normalized;
}

/**
 * CLOB V2 order and trade sizes are already integer fixed-math base units
 * (six decimals). They must never be routed through decimal scaling again.
 */
export function parseClobFixed6(value: unknown, code: string): bigint {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    !/^\d+$/u.test(value)
  ) {
    throw new Error(code);
  }
  const parsed = BigInt(value);
  if (parsed > 10n ** 30n) {
    throw new Error(code);
  }
  return parsed;
}

export function parseClobPrice(value: unknown, code: string): bigint {
  if (typeof value !== "string" || value.length > 100) {
    throw new Error(code);
  }
  try {
    const parsed = parseDecimalToMicros(value);
    if (parsed <= 0n || parsed >= 1_000_000n) {
      throw new Error(code);
    }
    return parsed;
  } catch {
    throw new Error(code);
  }
}

export function readNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(code);
  }
  return value;
}

export function parseClobTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    return null;
  }
  if (/^\d+$/u.test(value)) {
    const integer = BigInt(value);
    const milliseconds =
      integer < 10_000_000_000n ? integer * 1_000n : integer;
    return milliseconds > 0n &&
      milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(milliseconds)
      : null;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
