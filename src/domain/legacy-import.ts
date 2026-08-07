import type {
  LegacyAutoExitPolicy,
  LegacyEvidenceQuality,
  PortfolioPosition,
  UserTradeActivity
} from "./types.js";

export interface LegacyLocalFill {
  side: "BUY" | "SELL";
  sharesMicros: bigint;
  priceMicros: bigint;
  timestampMs: number;
  transactionHash: string | null;
}

export interface LegacyLocalEvidence {
  orderCount: number;
  reconciledOrderCount: number;
  fills: LegacyLocalFill[];
  feesMicros: bigint | null;
  transactionHashes: string[];
}

export interface LegacyImportComputation {
  quality: LegacyEvidenceQuality;
  automaticExitPolicy: LegacyAutoExitPolicy;
  sharesMicros: bigint;
  averagePriceMicros: bigint;
  openedAtMs: number | null;
  feesMicros: bigint | null;
  activityFillCount: number;
  localEvidenceCount: number;
  reconciledOrderCount: number;
  reconciledFillCount: number;
  remoteOpenOrderCount: number;
  ordersChecked: boolean;
  transactionHashes: string[];
  message: string;
}

export interface LegacyImportResult {
  imported: boolean;
  report: import("./types.js").LegacyImportReport;
}

export function computeLegacyImport(input: {
  position: PortfolioPosition;
  activity: UserTradeActivity[];
  activityAvailable: boolean;
  local: LegacyLocalEvidence;
  remoteOpenOrderCount: number;
  ordersChecked: boolean;
}): LegacyImportComputation {
  const tokenActivity = input.activity.filter(
    (activity) =>
      activity.tokenId === input.position.tokenId &&
      activity.conditionId.toLowerCase() === input.position.conditionId.toLowerCase()
  );
  const buyActivity = tokenActivity.filter((activity) => activity.side === "BUY");
  const sellActivity = tokenActivity.filter((activity) => activity.side === "SELL");
  const netSharesMicros =
    buyActivity.reduce((total, activity) => total + activity.sizeMicros, 0n) -
    sellActivity.reduce((total, activity) => total + activity.sizeMicros, 0n);
  const openedAtMs = buyActivity.reduce<number | null>(
    (earliest, activity) =>
      earliest === null || activity.timestampMs < earliest
        ? activity.timestampMs
        : earliest,
    null
  );
  const activityMatchesPosition =
    input.activityAvailable &&
    tokenActivity.length > 0 &&
    netSharesMicros === input.position.sizeMicros;
  const localEntryFills = input.local.fills.filter((fill) => fill.side === "BUY");
  const localEntryCounts = new Map<string, number>();
  for (const fill of localEntryFills) {
    const key = fillIdentity(
      fill.side,
      fill.sharesMicros,
      fill.priceMicros,
      fill.transactionHash
    );
    localEntryCounts.set(key, (localEntryCounts.get(key) ?? 0) + 1);
  }
  const allActivityEntriesHaveLocalEvidence = buyActivity.length > 0 &&
    buyActivity.every((activity) => {
      const key = fillIdentity(
        activity.side,
        activity.sizeMicros,
        activity.priceMicros,
        activity.transactionHash
      );
      const remaining = localEntryCounts.get(key) ?? 0;
      if (remaining === 0) {
        return false;
      }
      localEntryCounts.set(key, remaining - 1);
      return true;
    });
  const fullyVerified =
    activityMatchesPosition &&
    input.ordersChecked &&
    input.local.reconciledOrderCount > 0 &&
    allActivityEntriesHaveLocalEvidence &&
    input.local.feesMicros !== null;
  const partiallyVerified =
    activityMatchesPosition && input.position.averagePriceMicros > 0n;
  const quality: LegacyEvidenceQuality = fullyVerified
    ? "VERIFIED"
    : partiallyVerified
      ? "PARTIALLY_VERIFIED"
      : "LEGACY_UNVERIFIED";
  const automaticExitPolicy: LegacyAutoExitPolicy =
    quality === "VERIFIED"
      ? "FULL"
      : quality === "PARTIALLY_VERIFIED"
        ? "PRICE_ONLY"
        : "BLOCKED";
  const transactionHashes = uniqueHashes([
    ...tokenActivity.map((activity) => activity.transactionHash),
    ...input.local.transactionHashes
  ]);

  return {
    quality,
    automaticExitPolicy,
    sharesMicros: input.position.sizeMicros,
    averagePriceMicros: input.position.averagePriceMicros,
    openedAtMs: quality === "LEGACY_UNVERIFIED" ? null : openedAtMs,
    feesMicros: input.local.feesMicros,
    activityFillCount: tokenActivity.length,
    localEvidenceCount: input.local.orderCount,
    reconciledOrderCount: input.local.reconciledOrderCount,
    reconciledFillCount: input.local.fills.length,
    remoteOpenOrderCount: input.remoteOpenOrderCount,
    ordersChecked: input.ordersChecked,
    transactionHashes,
    message: messageForQuality(quality, activityMatchesPosition)
  };
}

function fillIdentity(
  side: LegacyLocalFill["side"],
  sharesMicros: bigint,
  priceMicros: bigint,
  transactionHash: string | null
): string {
  return [
    side,
    sharesMicros.toString(),
    priceMicros.toString(),
    transactionHash?.toLowerCase() ?? ""
  ].join(":");
}

function uniqueHashes(values: string[]): string[] {
  return [...new Set(values.filter((value) => /^0x[a-f0-9]{64}$/u.test(value.toLowerCase())).map((value) => value.toLowerCase()))];
}

function messageForQuality(
  quality: LegacyEvidenceQuality,
  activityMatchesPosition: boolean
): string {
  if (quality === "VERIFIED") {
    return "Position imported with matched public activity, reconciled local fills, fees, and transaction hashes.";
  }
  if (quality === "PARTIALLY_VERIFIED") {
    return "Position price history is consistent with public activity; automatic exits are limited to stop-loss, take-profit, and duration rules.";
  }
  return activityMatchesPosition
    ? "Position history is incomplete or lacks reconciled local fill evidence; automatic exits remain blocked."
    : "Position history could not be reconstructed without inventing entry evidence; automatic exits remain blocked.";
}
