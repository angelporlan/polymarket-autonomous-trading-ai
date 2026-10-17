import { createHash } from "node:crypto";
import {
  PUSD_SCALE,
  type CandidateMarket,
  type MarketCategory,
  type MarketSnapshot,
  type OrderSide,
  type PortfolioPosition,
  type PortfolioSnapshot,
  type PriceLevel,
  type UserTradeActivity
} from "../domain/types.js";
import {
  SafeExternalServiceError,
  isRetryableStatus,
  toSafeExternalError
} from "./safe-error.js";
import type { MarketChannelBook } from "./market-channel-monitor.js";

const DEFAULT_GAMMA_HOST = "https://gamma-api.polymarket.com";
const DEFAULT_DATA_HOST = "https://data-api.polymarket.com";
const DEFAULT_CLOB_HOST = "https://clob.polymarket.com";
const DEFAULT_GEOBLOCK_HOST = "https://polymarket.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 150;
const MAX_BOOK_AGE_MS = 5_000;
const PORTFOLIO_PAGE_LIMIT = 500;
const PORTFOLIO_MAX_OFFSET = 10_000;
const CLOSED_POSITION_PAGE_LIMIT = 50;
const CLOSED_POSITION_MAX_PAGES = 200;
const ACTIVITY_PAGE_LIMIT = 500;
const ACTIVITY_MAX_OFFSET = 5_000;
const ACTIVITY_MAX_REQUESTS = 256;
const ACTIVITY_MAX_ROWS = 100_000;

export type PublicFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface PublicClientOptions {
  gammaHost?: string;
  dataHost?: string;
  clobHost?: string;
  geoblockHost?: string;
  fetch?: PublicFetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface CandidateScanOptions {
  limit?: number;
}

export interface MarketSnapshotRequest {
  conditionId: string;
  tokenId: string;
  side?: OrderSide;
  limitPriceMicros?: bigint;
  category?: MarketCategory;
  outcome?: string;
  /** Validated public market-channel book used for agent-supervised live data. */
  realtimeBook?: MarketChannelBook;
}

export interface ResolvedMarketReference {
  conditionId: string;
  tokenId: string;
  outcome: string;
}

type QueryValue = string | number | boolean | undefined;
type JsonRecord = Record<string, unknown>;
type DecimalRounding = "nearest" | "floor" | "ceil";

export class PolymarketPublicClient {
  private readonly gammaHost: string;
  private readonly dataHost: string;
  private readonly clobHost: string;
  private readonly geoblockHost: string;
  private readonly fetchFn: PublicFetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: PublicClientOptions = {}) {
    this.gammaHost = normalizeHost(options.gammaHost ?? DEFAULT_GAMMA_HOST);
    this.dataHost = normalizeHost(options.dataHost ?? DEFAULT_DATA_HOST);
    this.clobHost = normalizeHost(options.clobHost ?? DEFAULT_CLOB_HOST);
    this.geoblockHost = normalizeHost(
      options.geoblockHost ?? DEFAULT_GEOBLOCK_HOST
    );
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = nonNegativeInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async scanCandidates(
    optionsOrCategories: CandidateScanOptions | MarketCategory[] = {}
  ): Promise<CandidateMarket[]> {
    const options = Array.isArray(optionsOrCategories)
      ? {}
      : optionsOrCategories;
    const categoryFilter = Array.isArray(optionsOrCategories)
      ? new Set<MarketCategory>(optionsOrCategories)
      : undefined;
    const limit = Math.min(500, positiveInteger(options.limit, 100));
    const payload = await this.requestJson(
      "gamma",
      this.gammaHost,
      "/markets",
      {
        active: true,
        closed: false,
        limit
      }
    );

    const markets = readArrayPayload(payload);
    const candidates: CandidateMarket[] = [];

    for (const value of markets) {
      const market = asRecord(value);
      if (market === undefined) {
        continue;
      }

      const category = classifyMarket(market);
      const conditionId = readString(market, "conditionId", "condition_id");
      const question = readString(market, "question", "title");
      const slug = readString(market, "slug");
      const acceptingOrders = readBoolean(
        market,
        false,
        "acceptingOrders",
        "accepting_orders",
        "enableOrderBook"
      );
      if (
        category === undefined ||
        (categoryFilter !== undefined && !categoryFilter.has(category)) ||
        conditionId === undefined ||
        question === undefined ||
        slug === undefined ||
        readBoolean(market, true, "closed") ||
        !readBoolean(market, true, "active")
      ) {
        continue;
      }

      const bestBid = readOptionalMicros(market, "bestBid", "best_bid");
      const bestAsk = readOptionalMicros(market, "bestAsk", "best_ask");
      const directSpread = readOptionalMicros(market, "spread");
      const spreadMicros =
        directSpread ??
        (bestBid !== undefined && bestAsk !== undefined
          ? maxBigInt(0n, bestAsk - bestBid)
          : null);

      candidates.push({
        conditionId,
        slug,
        question,
        category,
        endTimeMs: readDateMs(market, "endDate", "end_date", "endTime"),
        volume24hMicros: maxBigInt(
          0n,
          readMicros(
            market,
            "floor",
            "volume24hr",
            "volume24h",
            "volume_24h"
          )
        ),
        liquidityMicros: maxBigInt(
          0n,
          readMicros(market, "floor", "liquidity", "liquidityNum")
        ),
        spreadMicros,
        tokenIds: readStringArray(
          readValue(market, "clobTokenIds", "clob_token_ids", "tokenIds")
        ),
        active: true,
        acceptingOrders
      });
    }

    if (candidates.length === 0) {
      const eventsPayload = await this.requestJson(
        "gamma",
        this.gammaHost,
        "/events",
        {
          active: true,
          closed: false,
          limit
        }
      );
      const events = readArrayPayload(eventsPayload);
      const seenConditionIds = new Set<string>();
      for (const eventValue of events) {
        const eventRecord = asRecord(eventValue);
        if (eventRecord === undefined) {
          continue;
        }
        const eventMarkets = readArrayPayload(eventRecord.markets);
        for (const value of eventMarkets) {
          const market = asRecord(value);
          if (market === undefined) {
            continue;
          }
          const conditionId = readString(market, "conditionId", "condition_id");
          if (conditionId === undefined || seenConditionIds.has(conditionId.toLowerCase())) {
            continue;
          }
          const syntheticMarket = {
            ...market,
            category: market.category ?? eventRecord.category,
            tags: market.tags ?? eventRecord.tags,
            events: market.events ?? [eventRecord]
          };
          const category = classifyMarket(syntheticMarket);
          const question = readString(market, "question", "title");
          const slug = readString(market, "slug");
          const acceptingOrders = readBoolean(
            market,
            false,
            "acceptingOrders",
            "accepting_orders",
            "enableOrderBook"
          );
          if (
            category === undefined ||
            (categoryFilter !== undefined && !categoryFilter.has(category)) ||
            question === undefined ||
            slug === undefined ||
            readBoolean(market, true, "closed") ||
            !readBoolean(market, true, "active")
          ) {
            continue;
          }

          seenConditionIds.add(conditionId.toLowerCase());
          const bestBid = readOptionalMicros(market, "bestBid", "best_bid");
          const bestAsk = readOptionalMicros(market, "bestAsk", "best_ask");
          const directSpread = readOptionalMicros(market, "spread");
          const spreadMicros =
            directSpread ??
            (bestBid !== undefined && bestAsk !== undefined
              ? maxBigInt(0n, bestAsk - bestBid)
              : null);

          candidates.push({
            conditionId,
            slug,
            question,
            category,
            endTimeMs: readDateMs(market, "endDate", "end_date", "endTime"),
            volume24hMicros: maxBigInt(
              0n,
              readMicros(
                market,
                "floor",
                "volume24hr",
                "volume24h",
                "volume_24h"
              )
            ),
            liquidityMicros: maxBigInt(
              0n,
              readMicros(market, "floor", "liquidity", "liquidityNum")
            ),
            spreadMicros,
            tokenIds: readStringArray(
              readValue(market, "clobTokenIds", "clob_token_ids", "tokenIds")
            ),
            active: true,
            acceptingOrders
          });
        }
      }
    }

    return candidates;
  }

  async profileExists(profileAddress: string): Promise<boolean> {
    assertProfileAddress(profileAddress);
    try {
      const payload = await this.requestJson(
        "gamma",
        this.gammaHost,
        "/public-profile",
        { address: profileAddress }
      );
      return asRecord(payload) !== undefined;
    } catch (error) {
      if (
        error instanceof SafeExternalServiceError &&
        error.status === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async checkGeoblock(): Promise<{
    blocked: boolean;
    country: string;
    region: string;
    checkedAtMs: number;
  }> {
    const payload = requireServiceRecord(
      await this.requestJson(
        "geoblock",
        this.geoblockHost,
        "/api/geoblock",
        {}
      ),
      "geoblock",
      "The geoblock response was malformed."
    );
    if (
      typeof payload.blocked !== "boolean" ||
      typeof payload.country !== "string" ||
      payload.country.trim().length === 0 ||
      typeof payload.region !== "string" ||
      payload.region.trim().length === 0
    ) {
      throw new SafeExternalServiceError(
        "The geoblock response was indeterminate.",
        {
          code: "INDETERMINATE_GEOBLOCK",
          service: "geoblock",
          retryable: false
        }
      );
    }
    return {
      blocked: payload.blocked,
      country: payload.country,
      region: payload.region,
      checkedAtMs: this.now()
    };
  }

  async getPortfolio(profileAddress: string): Promise<PortfolioSnapshot> {
    assertProfileAddress(profileAddress);

    const [rawPositions, rawClosedPositions] = await Promise.all([
      this.requestPortfolioPages(
        "/positions",
        {
          user: profileAddress,
          sizeThreshold: 0,
          sortBy: "TOKENS",
          sortDirection: "DESC"
        },
        PORTFOLIO_PAGE_LIMIT,
        PORTFOLIO_MAX_OFFSET / PORTFOLIO_PAGE_LIMIT + 1
      ),
      this.requestPortfolioPages(
        "/closed-positions",
        {
          user: profileAddress,
          sortBy: "TIMESTAMP",
          sortDirection: "DESC"
        },
        CLOSED_POSITION_PAGE_LIMIT,
        CLOSED_POSITION_MAX_PAGES
      )
    ]);

    const positions: PortfolioPosition[] = [];
    const seenPositions = new Set<string>();
    for (const value of rawPositions) {
      const position = asRecord(value);
      if (position === undefined) {
        throw invalidPortfolioResponse();
      }

      const tokenId = readString(position, "asset", "tokenId", "token_id");
      const conditionId = readString(
        position,
        "conditionId",
        "condition_id",
        "market"
      );
      const proxyWallet = readString(
        position,
        "proxyWallet",
        "proxy_wallet"
      );
      const question = readString(position, "title", "question");
      const outcome = readString(position, "outcome");
      const endTimeMs = readDateMs(
        position,
        "endDate",
        "end_date",
        "endTime"
      );
      if (
        tokenId === undefined ||
        conditionId === undefined ||
        proxyWallet?.toLowerCase() !== profileAddress.toLowerCase() ||
        question === undefined ||
        outcome === undefined ||
        endTimeMs <= 0
      ) {
        throw invalidPortfolioResponse();
      }
      const positionIdentity =
        `${conditionId.toLowerCase()}:${tokenId.toLowerCase()}`;
      if (seenPositions.has(positionIdentity)) {
        throw truncatedPortfolioResponse();
      }
      seenPositions.add(positionIdentity);

      const sizeMicros = readRequiredBoundedPortfolioMicros(
        position,
        "nearest",
        0n,
        undefined,
        "size"
      );
      const averagePriceMicros = readRequiredBoundedPortfolioMicros(
        position,
        "nearest",
        0n,
        PUSD_SCALE,
        "avgPrice",
        "averagePrice",
        "average_price"
      );
      const currentPriceMicros = readRequiredBoundedPortfolioMicros(
        position,
        "nearest",
        0n,
        PUSD_SCALE,
        "curPrice",
        "currentPrice",
        "current_price"
      );
      const currentValueMicros = readRequiredBoundedPortfolioMicros(
        position,
        "nearest",
        0n,
        undefined,
        "currentValue",
        "current_value"
      );
      const cashPnlMicros = readRequiredPortfolioMicros(
        position,
        "nearest",
        "cashPnl",
        "cash_pnl",
        "pnl"
      );
      const realizedPnlMicros = readRequiredPortfolioMicros(
        position,
        "nearest",
        "realizedPnl",
        "realized_pnl"
      );
      positions.push({
        tokenId,
        conditionId,
        question,
        outcome,
        sizeMicros,
        averagePriceMicros,
        currentPriceMicros,
        currentValueMicros,
        cashPnlMicros,
        realizedPnlMicros,
        endTimeMs
      });
    }

    const closedPositionIdentities = new Set<string>();
    let closedRealizedPnlMicros = 0n;
    for (const value of rawClosedPositions) {
      const position = asRecord(value);
      if (position === undefined) {
        throw invalidPortfolioResponse();
      }
      const tokenId = readString(position, "asset", "tokenId", "token_id");
      const conditionId = readString(
        position,
        "conditionId",
        "condition_id",
        "market"
      );
      const proxyWallet = readString(
        position,
        "proxyWallet",
        "proxy_wallet"
      );
      if (
        tokenId === undefined ||
        conditionId === undefined ||
        proxyWallet?.toLowerCase() !== profileAddress.toLowerCase()
      ) {
        throw invalidPortfolioResponse();
      }
      const identity = `${conditionId.toLowerCase()}:${tokenId.toLowerCase()}`;
      if (closedPositionIdentities.has(identity)) {
        throw truncatedPortfolioResponse();
      }
      closedPositionIdentities.add(identity);
      if (!seenPositions.has(identity)) {
        closedRealizedPnlMicros += readRequiredPortfolioMicros(
          position,
          "nearest",
          "realizedPnl",
          "realized_pnl"
        );
      }
    }

    return {
      profileAddress,
      pUsdBalanceMicros: null,
      totalPositionValueMicros: sumBigInts(
        positions.map((position) => position.currentValueMicros)
      ),
      totalPnlMicros: sumBigInts(
        positions.map(
          (position) =>
            position.cashPnlMicros + position.realizedPnlMicros
        )
      ) + closedRealizedPnlMicros,
      positions,
      capturedAtMs: this.now(),
      source: "public"
    };
  }

  async getUserActivity(
    profileAddress: string,
    sinceMs: number
  ): Promise<UserTradeActivity[]> {
    assertProfileAddress(profileAddress);
    const nowMs = this.now();
    if (
      !Number.isSafeInteger(sinceMs) ||
      sinceMs < 0 ||
      !Number.isSafeInteger(nowMs) ||
      nowMs <= 0 ||
      sinceMs > nowMs
    ) {
      throw new Error(
        "sinceMs must be a non-negative epoch millisecond no later than now."
      );
    }

    let startSeconds = Math.floor(sinceMs / 1_000);
    const endSeconds = Math.floor(nowMs / 1_000);
    const result: UserTradeActivity[] = [];
    const committedIdentities = new Set<string>();
    let requestCount = 0;

    while (startSeconds <= endSeconds) {
      const windowRows: UserTradeActivity[] = [];
      const windowIdentities = new Set<string>();
      const pageFingerprints = new Set<string>();
      let previousTimestampMs: number | null = null;
      let windowComplete = false;

      for (
        let offset = 0;
        offset <= ACTIVITY_MAX_OFFSET;
        offset += ACTIVITY_PAGE_LIMIT
      ) {
        requestCount += 1;
        if (requestCount > ACTIVITY_MAX_REQUESTS) {
          throw truncatedActivityResponse();
        }

        const payload = await this.requestJson(
          "data",
          this.dataHost,
          "/activity",
          {
            user: profileAddress,
            type: "TRADE",
            start: startSeconds,
            end: endSeconds,
            sortBy: "TIMESTAMP",
            sortDirection: "ASC",
            limit: ACTIVITY_PAGE_LIMIT,
            offset
          }
        );
        if (!Array.isArray(payload) || payload.length > ACTIVITY_PAGE_LIMIT) {
          throw invalidActivityResponse();
        }

        const fingerprint = JSON.stringify(payload);
        if (payload.length > 0 && pageFingerprints.has(fingerprint)) {
          throw truncatedActivityResponse();
        }
        pageFingerprints.add(fingerprint);

        for (const value of payload) {
          const activity = parseTradeActivity(
            value,
            profileAddress,
            startSeconds,
            endSeconds
          );
          if (
            previousTimestampMs !== null &&
            activity.timestampMs < previousTimestampMs
          ) {
            throw invalidActivityResponse();
          }
          previousTimestampMs = activity.timestampMs;

          const identity = tradeActivityIdentity(activity);
          if (windowIdentities.has(identity)) {
            throw truncatedActivityResponse();
          }
          windowIdentities.add(identity);
          windowRows.push(activity);
        }

        if (payload.length < ACTIVITY_PAGE_LIMIT) {
          appendActivities(
            result,
            windowRows,
            committedIdentities
          );
          windowComplete = true;
          break;
        }
      }

      if (windowComplete) {
        return result;
      }

      const finalRow = windowRows.at(-1);
      if (finalRow === undefined) {
        throw truncatedActivityResponse();
      }
      const boundarySeconds = Math.floor(finalRow.timestampMs / 1_000);
      if (boundarySeconds <= startSeconds) {
        // The API cannot paginate beyond offset=5000. Advancing here would
        // silently drop further rows that share the same epoch second.
        throw truncatedActivityResponse();
      }

      appendActivities(
        result,
        windowRows.filter(
          (activity) =>
            Math.floor(activity.timestampMs / 1_000) < boundarySeconds
        ),
        committedIdentities
      );
      startSeconds = boundarySeconds;
    }

    return result;
  }

  private async requestPortfolioPages(
    path: "/positions" | "/closed-positions",
    query: Record<string, QueryValue>,
    pageLimit: number,
    maxPages: number
  ): Promise<unknown[]> {
    const values: unknown[] = [];
    const pageFingerprints = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.requestJson(
        "data",
        this.dataHost,
        path,
        {
          ...query,
          limit: pageLimit,
          offset: page * pageLimit
        }
      );
      if (!Array.isArray(payload) || payload.length > pageLimit) {
        throw invalidPortfolioResponse();
      }
      const fingerprint = JSON.stringify(payload);
      if (payload.length > 0 && pageFingerprints.has(fingerprint)) {
        throw truncatedPortfolioResponse();
      }
      pageFingerprints.add(fingerprint);
      values.push(...payload);
      if (payload.length < pageLimit) {
        return values;
      }
    }
    throw truncatedPortfolioResponse();
  }

  async getMarketSnapshot(
    request: MarketSnapshotRequest
  ): Promise<MarketSnapshot> {
    if (request.conditionId.trim().length === 0 || request.tokenId.trim().length === 0) {
      throw new Error("conditionId and tokenId are required.");
    }
    if (
      (request.side === undefined) !==
      (request.limitPriceMicros === undefined)
    ) {
      throw new Error("side and limitPriceMicros must be provided together.");
    }

    const gammaPayload = await this.requestJson(
      "gamma",
      this.gammaHost,
      "/markets",
      {
        condition_ids: request.conditionId,
        limit: 1
      }
    );
    const market = asRecord(readArrayPayload(gammaPayload)[0]);
    if (market === undefined) {
      throw new SafeExternalServiceError("The requested market was not found.", {
        code: "MARKET_NOT_FOUND",
        service: "gamma",
        status: 404,
        retryable: false
      });
    }

    const actualConditionId = readString(
      market,
      "conditionId",
      "condition_id"
    );
    if (
      actualConditionId !== undefined &&
      actualConditionId.toLowerCase() !== request.conditionId.toLowerCase()
    ) {
      throw new SafeExternalServiceError(
        "Gamma returned a different market than requested.",
        {
          code: "MARKET_MISMATCH",
          service: "gamma",
          retryable: false
        }
      );
    }

    const [bookPayload, clobMarketPayload, feeRatePayload] = await Promise.all([
      this.requestJson("clob", this.clobHost, "/book", {
        token_id: request.tokenId
      }),
      this.requestJson(
        "clob",
        this.clobHost,
        `/clob-markets/${encodeURIComponent(request.conditionId)}`,
        {}
      ),
      this.requestJson("clob", this.clobHost, "/fee-rate", {
        token_id: request.tokenId
      })
    ]);
    const book = requireRecord(bookPayload, "CLOB book");
    const clobMarket = requireRecord(
      clobMarketPayload,
      "CLOB market response"
    );
    const tokenFeeRate = readTokenFeeRateBps(
      requireServiceRecord(
        feeRatePayload,
        "clob",
        "The token fee-rate response was malformed."
      )
    );
    const clobConditionId = readString(clobMarket, "c");
    if (
      clobConditionId === undefined ||
      clobConditionId.toLowerCase() !== request.conditionId.toLowerCase()
    ) {
      throw new SafeExternalServiceError(
        "The CLOB market metadata does not match the requested market.",
        {
          code: "INVALID_EXTERNAL_RESPONSE",
          service: "clob",
          retryable: false
        }
      );
    }
    const restBookTimestampMs = validateBookSnapshot(
      book,
      request.conditionId,
      request.tokenId,
      this.now(),
      request.realtimeBook === undefined
    );
    if (request.realtimeBook !== undefined) {
      validateRealtimeBook(
        request.realtimeBook,
        request.conditionId,
        request.tokenId,
        this.now()
      );
    }
    const gammaNegRisk = readRequiredBoolean(
      market,
      "gamma",
      "The Gamma market response did not contain an explicit negRisk value.",
      "negRisk",
      "neg_risk"
    );
    const bookNegRisk = readRequiredBoolean(
      book,
      "clob",
      "The CLOB order book did not contain an explicit neg_risk value.",
      "neg_risk"
    );
    const rawClobNegRisk = readValue(clobMarket, "nr");
    if (
      rawClobNegRisk !== undefined &&
      typeof rawClobNegRisk !== "boolean"
    ) {
      throw new SafeExternalServiceError(
        "The CLOB market returned an invalid negRisk value.",
        {
          code: "INVALID_EXTERNAL_RESPONSE",
          service: "clob",
          retryable: false
        }
      );
    }
    const clobNegRisk = rawClobNegRisk ?? false;
    if (
      gammaNegRisk !== bookNegRisk ||
      gammaNegRisk !== clobNegRisk
    ) {
      throw new SafeExternalServiceError(
        "Gamma and CLOB returned inconsistent negRisk values.",
        {
          code: "INVALID_EXTERNAL_RESPONSE",
          service: "clob",
          retryable: false
        }
      );
    }
    const feesEnabled = readRequiredBoolean(
      market,
      "gamma",
      "The Gamma market response did not contain an explicit feesEnabled value.",
      "feesEnabled",
      "fees_enabled"
    );
    const rawFeeDetails = clobMarket.fd;
    let feeRateBps: number;
    let feeExponent: number;
    let feesTakerOnly: boolean;
    if (rawFeeDetails === undefined || rawFeeDetails === null) {
      if (feesEnabled || tokenFeeRate !== 0) {
        throw new SafeExternalServiceError(
          "The fee-bearing market omitted explicit fee details.",
          {
            code: "INVALID_EXTERNAL_RESPONSE",
            service: "clob",
            retryable: false
          }
        );
      }
      feeRateBps = 0;
      feeExponent = 0;
      feesTakerOnly = true;
    } else {
      const feeDetails = requireServiceRecord(
        rawFeeDetails,
        "clob",
        "The CLOB market fee details were malformed."
      );
      feeRateBps = feeRateToBps(feeDetails.r);
      feeExponent = readFeeExponent(feeDetails.e);
      feesTakerOnly = readRequiredBoolean(
        feeDetails,
        "clob",
        "The CLOB market response did not contain an explicit taker-only fee value.",
        "to"
      );
      if (!feesEnabled && (feeRateBps !== 0 || tokenFeeRate !== 0)) {
        throw new SafeExternalServiceError(
          "Gamma, market metadata, and token fee rate are inconsistent.",
          {
            code: "INVALID_EXTERNAL_RESPONSE",
            service: "clob",
            retryable: false
          }
        );
      }
    }
    const tickSizeMicros = readRequiredMicros(
      [book, market],
      "nearest",
      "tick_size",
      "tickSize",
      "orderPriceMinTickSize"
    );
    const bookMinOrderSizeMicros = readRequiredMicros(
      [book],
      "nearest",
      "min_order_size"
    );
    const marketMinOrderSizeMicros = readRequiredMicros(
      [clobMarket],
      "nearest",
      "mos"
    );
    if (
      bookMinOrderSizeMicros !== marketMinOrderSizeMicros ||
      bookMinOrderSizeMicros <= 0n
    ) {
      throw invalidBookResponse(
        "CLOB_MIN_ORDER_SIZE_MISMATCH",
        "The CLOB minimum order size is missing or inconsistent."
      );
    }
    if (
      tickSizeMicros <= 0n ||
      tickSizeMicros >= PUSD_SCALE ||
      PUSD_SCALE % tickSizeMicros !== 0n
    ) {
      throw invalidBookResponse(
        "CLOB_BOOK_TICK_INVALID",
        "The CLOB order book tick size is invalid."
      );
    }
    if (
      request.realtimeBook?.tickSizeMicros !== null &&
      request.realtimeBook?.tickSizeMicros !== undefined &&
      request.realtimeBook.tickSizeMicros !== tickSizeMicros
    ) {
      throw invalidBookResponse(
        "CLOB_BOOK_TICK_MISMATCH",
        "The market channel and REST metadata disagree about tick size."
      );
    }
    const bids = request.realtimeBook === undefined
      ? readRequiredPriceLevels(book.bids, tickSizeMicros)
      : validateRealtimeLevels(request.realtimeBook.bids, tickSizeMicros);
    const asks = request.realtimeBook === undefined
      ? readRequiredPriceLevels(book.asks, tickSizeMicros)
      : validateRealtimeLevels(request.realtimeBook.asks, tickSizeMicros);
    bids.sort((left, right) => compareBigInt(right.priceMicros, left.priceMicros));
    asks.sort((left, right) => compareBigInt(left.priceMicros, right.priceMicros));

    const bestBidMicros = bids[0]!.priceMicros;
    const bestAskMicros = asks[0]!.priceMicros;
    if (bestBidMicros > bestAskMicros) {
      throw invalidBookResponse(
        "CLOB_BOOK_CROSSED",
        "The CLOB order book is crossed."
      );
    }
    if (
      request.realtimeBook !== undefined &&
      this.now() - restBookTimestampMs <= MAX_BOOK_AGE_MS
    ) {
      const restBids = readRequiredPriceLevels(book.bids, tickSizeMicros)
        .sort((left, right) => compareBigInt(right.priceMicros, left.priceMicros));
      const restAsks = readRequiredPriceLevels(book.asks, tickSizeMicros)
        .sort((left, right) => compareBigInt(left.priceMicros, right.priceMicros));
      if (
        restBids[0]?.priceMicros !== bestBidMicros ||
        restAsks[0]?.priceMicros !== bestAskMicros
      ) {
        throw invalidBookResponse(
          "CLOB_BOOK_CROSSCHECK_MISMATCH",
          "Fresh REST and market-channel books disagree."
        );
      }
    }
    let remoteCategory = classifyMarket(market);
    if (remoteCategory === undefined) {
      const events = readRecordArray(market.events);
      const firstEvent = events[0];
      const eventId = firstEvent === undefined ? undefined : readValue(firstEvent, "id");
      if (eventId !== undefined) {
        try {
          const eventPayload = await this.requestJson(
            "gamma",
            this.gammaHost,
            "/events",
            { id: String(eventId) }
          );
          const fullEvent = asRecord(readArrayPayload(eventPayload)[0]);
          if (fullEvent !== undefined) {
            const enrichedMarket = {
              ...market,
              category: market.category ?? fullEvent.category,
              tags: market.tags ?? fullEvent.tags,
              events: [fullEvent]
            };
            remoteCategory = classifyMarket(enrichedMarket);
          }
        } catch {
          // Fallback proceeds to category check
        }
      }
    }
    if (
      remoteCategory === undefined ||
      (request.category !== undefined &&
        request.category !== remoteCategory)
    ) {
      throw new SafeExternalServiceError(
        "The market is outside the permitted category allowlist.",
        {
          code: "CATEGORY_NOT_ALLOWED",
          service: "gamma",
          retryable: false
        }
      );
    }
    const category = remoteCategory;

    const tokenIds = readStringArray(
      readValue(market, "clobTokenIds", "clob_token_ids", "tokenIds")
    );
    const outcomes = readStringArray(market.outcomes);
    const tokenIndex = tokenIds.indexOf(request.tokenId);
    if (tokenIndex < 0 || outcomes[tokenIndex] === undefined) {
      throw new SafeExternalServiceError(
        "The requested token is not part of the requested market.",
        {
          code: "TOKEN_MARKET_MISMATCH",
          service: "gamma",
          retryable: false
        }
      );
    }
    if (
      request.outcome !== undefined &&
      outcomes[tokenIndex]?.trim().toLowerCase() !==
        request.outcome.trim().toLowerCase()
    ) {
      throw new SafeExternalServiceError(
        "The requested outcome does not match the requested token.",
        {
          code: "OUTCOME_TOKEN_MISMATCH",
          service: "gamma",
          retryable: false
        }
      );
    }
    const events = readRecordArray(market.events);
    const firstEvent = events[0];
    const eventIdValue =
      firstEvent === undefined ? undefined : readValue(firstEvent, "id", "eventId");

    return {
      conditionId: actualConditionId ?? request.conditionId,
      tokenId: request.tokenId,
      eventId: primitiveToString(eventIdValue) ?? null,
      question: readString(market, "question", "title") ?? "",
      slug: readString(market, "slug") ?? "",
      outcome: outcomes[tokenIndex]!,
      category,
      rules:
        readString(
          market,
          "rules",
          "resolutionCriteria",
          "resolution_criteria",
          "description"
        ) ?? "",
      resolutionSource:
        readString(
          market,
          "resolutionSource",
          "resolution_source",
          "source"
        ) ?? "Official resolution source",
      endTimeMs: readDateMs(market, "endDate", "end_date", "endTime"),
      active: readBoolean(market, false, "active"),
      closed: readBoolean(market, false, "closed"),
      acceptingOrders: readBoolean(
        market,
        false,
        "acceptingOrders",
        "accepting_orders",
        "enableOrderBook"
      ),
      negRisk: gammaNegRisk,
      tickSizeMicros,
      minOrderSizeMicros: bookMinOrderSizeMicros,
      feesEnabled,
      feeRateBps,
      feeExponent,
      feesTakerOnly,
      bestBidMicros,
      bestAskMicros,
      spreadMicros: bestAskMicros - bestBidMicros,
      depthPusdMicrosAtLimit:
        request.side === undefined || request.limitPriceMicros === undefined
          ? 0n
          : calculateDepthAtLimit(
              request.side,
              request.limitPriceMicros,
              bids,
              asks
            ),
      bids,
      asks,
      capturedAtMs:
        request.realtimeBook?.receivedAtMs ?? restBookTimestampMs,
      sourceTimestampMs:
        request.realtimeBook?.sourceTimestampMs ?? restBookTimestampMs,
      receivedAtMs:
        request.realtimeBook?.receivedAtMs ?? this.now(),
      channelGeneration:
        request.realtimeBook?.channelGeneration ?? 0,
      bookHash:
        request.realtimeBook?.bookHash ??
        readOptionalBookHash(book) ??
        hashBookLevels(request.conditionId, request.tokenId, bids, asks),
      marketDataSource:
        request.realtimeBook === undefined ? "REST" : "WEBSOCKET"
    };
  }

  async resolveMarketReference(request: {
    conditionId?: string;
    tokenId?: string;
  }): Promise<ResolvedMarketReference> {
    if (request.conditionId === undefined && request.tokenId === undefined) {
      throw new Error("conditionId or tokenId is required.");
    }
    let conditionId = request.conditionId;
    if (conditionId === undefined) {
      const book = requireRecord(
        await this.requestJson("clob", this.clobHost, "/book", {
          token_id: request.tokenId
        }),
        "CLOB book"
      );
      conditionId = readString(book, "market");
      if (conditionId === undefined) {
        throw new SafeExternalServiceError(
          "The CLOB book did not identify its market.",
          {
            code: "INVALID_EXTERNAL_RESPONSE",
            service: "clob",
            retryable: false
          }
        );
      }
    }

    const payload = await this.requestJson(
      "gamma",
      this.gammaHost,
      "/markets",
      { condition_ids: conditionId, limit: 1 }
    );
    const market = requireRecord(
      readArrayPayload(payload)[0],
      "Gamma market"
    );
    const actualConditionId =
      readString(market, "conditionId", "condition_id") ?? conditionId;
    const tokenIds = readStringArray(
      readValue(market, "clobTokenIds", "clob_token_ids", "tokenIds")
    );
    const outcomes = readStringArray(market.outcomes);
    const tokenId = request.tokenId ?? tokenIds[0];
    const tokenIndex = tokenId === undefined ? -1 : tokenIds.indexOf(tokenId);
    if (tokenId === undefined || tokenIndex < 0 || outcomes[tokenIndex] === undefined) {
      throw new SafeExternalServiceError(
        "The requested token and market could not be resolved together.",
        {
          code: "TOKEN_MARKET_MISMATCH",
          service: "gamma",
          retryable: false
        }
      );
    }
    return {
      conditionId: actualConditionId,
      tokenId,
      outcome: outcomes[tokenIndex]!
    };
  }

  private async requestJson(
    service: string,
    host: string,
    path: string,
    query: Record<string, QueryValue>
  ): Promise<unknown> {
    const url = new URL(path, `${host}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let finalError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchFn(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal
        });
        if (!response.ok) {
          throw new PublicHttpError(
            response.status,
            parseRetryAfterMs(response.headers.get("retry-after"), this.now())
          );
        }

        try {
          return (await response.json()) as unknown;
        } catch {
          throw new SafeExternalServiceError(
            "The external service returned invalid JSON.",
            {
              code: "INVALID_EXTERNAL_RESPONSE",
              service,
              retryable: false
            }
          );
        }
      } catch (error) {
        finalError = error;
        const retryable =
          error instanceof PublicHttpError
            ? isRetryableStatus(error.status)
            : error instanceof TypeError ||
              toSafeExternalError(error).retryable;
        if (!retryable || attempt >= this.maxAttempts) {
          break;
        }

        const exponentialDelay = this.baseDelayMs * 2 ** (attempt - 1);
        const jitter = Math.floor(this.baseDelayMs * clampRandom(this.random()));
        const retryAfter =
          error instanceof PublicHttpError ? error.retryAfterMs : undefined;
        await this.sleep(Math.max(exponentialDelay + jitter, retryAfter ?? 0));
      } finally {
        clearTimeout(timeout);
      }
    }

    if (finalError instanceof PublicHttpError) {
      throw new SafeExternalServiceError(
        `Polymarket ${service} returned HTTP ${finalError.status}.`,
        {
          code: "PUBLIC_API_HTTP_ERROR",
          service,
          status: finalError.status,
          retryable: isRetryableStatus(finalError.status)
        }
      );
    }
    throw toSafeExternalError(finalError, {
      code: "PUBLIC_API_ERROR",
      service,
      fallbackMessage: `Polymarket ${service} request failed.`
    });
  }
}

/** Exact base-10 conversion; it never routes financial values through floats. */
export function parseApiDecimalToMicros(
  value: unknown,
  rounding: DecimalRounding = "nearest"
): bigint {
  if (typeof value === "bigint") {
    return value * PUSD_SCALE;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Decimal value must be a string, number, or bigint.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Decimal value must be finite.");
  }

  const text = String(value).trim();
  const match =
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (match === null) {
    throw new Error("Invalid decimal value.");
  }

  const negative = match[1] === "-";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number.parseInt(match[5] ?? "0", 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new Error("Decimal exponent is outside the supported range.");
  }

  const digits = BigInt(`${whole}${fraction}` || "0");
  const scaleShift = 6 - fraction.length + exponent;
  let absoluteMicros: bigint;
  if (scaleShift >= 0) {
    absoluteMicros = digits * 10n ** BigInt(scaleShift);
  } else {
    const divisor = 10n ** BigInt(-scaleShift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    const shouldIncrement =
      rounding === "nearest"
        ? remainder * 2n >= divisor
        : rounding === "ceil"
          ? !negative && remainder > 0n
          : negative && rounding === "floor" && remainder > 0n;
    absoluteMicros = quotient + (shouldIncrement ? 1n : 0n);
  }

  return negative ? -absoluteMicros : absoluteMicros;
}

function calculateDepthAtLimit(
  side: OrderSide,
  limitPriceMicros: bigint,
  bids: PriceLevel[],
  asks: PriceLevel[]
): bigint {
  const executable =
    side === "BUY"
      ? asks.filter((level) => level.priceMicros <= limitPriceMicros)
      : bids.filter((level) => level.priceMicros >= limitPriceMicros);
  return sumBigInts(
    executable.map(
      (level) => (level.priceMicros * level.sharesMicros) / PUSD_SCALE
    )
  );
}

function validateBookSnapshot(
  book: JsonRecord,
  expectedConditionId: string,
  expectedTokenId: string,
  nowMs: number,
  enforceFresh = true
): number {
  const market = readString(book, "market");
  const assetId = readString(book, "asset_id");
  if (
    market === undefined ||
    assetId === undefined ||
    market.toLowerCase() !== expectedConditionId.toLowerCase() ||
    assetId !== expectedTokenId
  ) {
    throw invalidBookResponse(
      "CLOB_BOOK_IDENTITY_MISMATCH",
      "The CLOB order book identity does not match the requested market."
    );
  }

  const rawTimestamp = book.timestamp ?? book.t;
  const capturedAtMs = parseRemoteBookTimestampMs(rawTimestamp);
  return validateBookEnvelope(capturedAtMs, nowMs, enforceFresh);
}

function validateBookEnvelope(
  capturedAtMs: number | null,
  nowMs: number,
  enforceFresh = true
): number {
  if (
    capturedAtMs === null ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0 ||
    capturedAtMs > nowMs
  ) {
    throw invalidBookResponse(
      "CLOB_BOOK_TIMESTAMP_INVALID",
      "The CLOB order book timestamp is invalid."
    );
  }
  if (enforceFresh && nowMs - capturedAtMs > MAX_BOOK_AGE_MS) {
    throw invalidBookResponse(
      "CLOB_BOOK_STALE",
      "The CLOB order book snapshot is stale."
    );
  }
  return capturedAtMs;
}

function validateRealtimeBook(
  book: MarketChannelBook,
  expectedConditionId: string,
  expectedTokenId: string,
  nowMs: number
): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0 ||
    book.conditionId.toLowerCase() !== expectedConditionId.toLowerCase() ||
    book.tokenId !== expectedTokenId ||
    !Number.isSafeInteger(book.sourceTimestampMs) ||
    !Number.isSafeInteger(book.receivedAtMs) ||
    !Number.isSafeInteger(book.channelGeneration) ||
    book.channelGeneration <= 0 ||
    book.sourceTimestampMs <= 0 ||
    book.sourceTimestampMs > nowMs + MAX_BOOK_AGE_MS ||
    book.receivedAtMs <= 0 ||
    book.receivedAtMs > nowMs ||
    book.bookHash.length === 0 ||
    book.bookHash.length > 256
  ) {
    throw invalidBookResponse(
      "CLOB_MARKET_CHANNEL_BOOK_INVALID",
      "The market-channel book failed identity or freshness validation."
    );
  }
  if (nowMs - book.receivedAtMs > MAX_BOOK_AGE_MS) {
    throw invalidBookResponse(
      "CLOB_MARKET_CHANNEL_BOOK_STALE",
      "The market-channel book expired while its market metadata was being verified."
    );
  }
}

function validateRealtimeLevels(
  levels: PriceLevel[],
  tickSizeMicros: bigint
): PriceLevel[] {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 10_000) {
    throw invalidBookResponse(
      "CLOB_MARKET_CHANNEL_BOOK_INVALID",
      "The market-channel book has no executable levels."
    );
  }
  const seen = new Set<string>();
  return levels.map((level) => {
    if (
      level.priceMicros <= 0n ||
      level.priceMicros > PUSD_SCALE ||
      level.priceMicros % tickSizeMicros !== 0n ||
      level.sharesMicros <= 0n ||
      seen.has(level.priceMicros.toString())
    ) {
      throw invalidBookResponse(
        "CLOB_MARKET_CHANNEL_BOOK_INVALID",
        "The market-channel book contains an invalid level."
      );
    }
    seen.add(level.priceMicros.toString());
    return { ...level };
  });
}

function readOptionalBookHash(book: JsonRecord): string | null {
  const value = book.hash;
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value.toLowerCase()
    : null;
}

function hashBookLevels(
  conditionId: string,
  tokenId: string,
  bids: PriceLevel[],
  asks: PriceLevel[]
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      conditionId: conditionId.toLowerCase(),
      tokenId,
      bids: bids.map((level) => [level.priceMicros.toString(), level.sharesMicros.toString()]),
      asks: asks.map((level) => [level.priceMicros.toString(), level.sharesMicros.toString()])
    }))
    .digest("hex");
}

function parseRemoteBookTimestampMs(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return null;
    }
    const milliseconds =
      value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (/^\d+$/u.test(value)) {
    try {
      const integer = BigInt(value);
      const milliseconds =
        integer < 10_000_000_000n ? integer * 1_000n : integer;
      if (
        milliseconds <= 0n ||
        milliseconds > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return null;
      }
      return Number(milliseconds);
    } catch {
      return null;
    }
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readRequiredPriceLevels(
  value: unknown,
  tickSizeMicros: bigint
): PriceLevel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidBookResponse(
      "CLOB_BOOK_ONE_SIDED",
      "The CLOB order book must contain both bids and asks."
    );
  }

  const levels: PriceLevel[] = [];
  const seenPrices = new Set<string>();
  for (const candidate of value) {
    const level = asRecord(candidate);
    if (level === undefined) {
      throw invalidBookResponse(
        "CLOB_BOOK_MALFORMED",
        "The CLOB order book contains an invalid price level."
      );
    }
    let priceMicros: bigint;
    let sharesMicros: bigint;
    try {
      priceMicros = parseApiDecimalToMicros(
        readValue(level, "price", "p"),
        "nearest"
      );
      sharesMicros = parseApiDecimalToMicros(
        readValue(level, "size", "s"),
        "floor"
      );
    } catch {
      throw invalidBookResponse(
        "CLOB_BOOK_MALFORMED",
        "The CLOB order book contains an invalid price level."
      );
    }
    if (
      priceMicros <= 0n ||
      priceMicros >= PUSD_SCALE ||
      sharesMicros <= 0n ||
      priceMicros % tickSizeMicros !== 0n ||
      seenPrices.has(priceMicros.toString())
    ) {
      throw invalidBookResponse(
        "CLOB_BOOK_MALFORMED",
        "The CLOB order book contains an invalid price level."
      );
    }
    seenPrices.add(priceMicros.toString());
    levels.push({ priceMicros, sharesMicros });
  }
  return levels;
}

const STRUCTURED_CATEGORY_ALLOWLIST: ReadonlyMap<string, MarketCategory> =
  new Map([
    ["politics", "politics"],
    ["political", "politics"],
    ["election", "politics"],
    ["elections", "politics"],
    ["government", "politics"],
    ["geopolitics", "politics"],
    ["us politics", "politics"],
    ["economics", "economics"],
    ["economic", "economics"],
    ["economy", "economics"],
    ["finance", "economics"],
    ["financial markets", "economics"],
    ["inflation", "economics"],
    ["interest rates", "economics"],
    ["central banks", "economics"],
    ["business", "economics"],
    ["technology", "technology"],
    ["tech", "technology"],
    ["artificial intelligence", "technology"],
    ["ai", "technology"],
    ["software", "technology"],
    ["hardware", "technology"],
    ["semiconductors", "technology"],
    ["computing", "technology"],
    ["cybersecurity", "technology"],
    ["robotics", "technology"],
    ["crypto", "technology"],
    ["blockchain", "technology"],
    ["spaceflight", "technology"]
  ]);

function classifyMarket(market: JsonRecord): MarketCategory | undefined {
  const primaryCategories = [
    readString(market, "category"),
    ...readRecordArray(market.events).map((event) =>
      readString(event, "category")
    )
  ].filter((value): value is string => value !== undefined);
  const primaryMatches = new Set(
    primaryCategories
      .map(classifyStructuredLabel)
      .filter((value): value is MarketCategory => value !== undefined)
  );

  // An explicit primary category outside the allowlist cannot be rescued by a
  // keyword-like tag. Conflicting primary categories are also indeterminate.
  if (
    primaryCategories.some(
      (value) => classifyStructuredLabel(value) === undefined
    ) ||
    primaryMatches.size > 1
  ) {
    return undefined;
  }

  const structuredLabels: string[] = [];
  const subcategory = readString(market, "subcategory");
  if (subcategory !== undefined) {
    structuredLabels.push(subcategory);
  }
  collectTagText(market.tags, structuredLabels);
  for (const event of readRecordArray(market.events)) {
    const eventSubcategory = readString(event, "subcategory");
    if (eventSubcategory !== undefined) {
      structuredLabels.push(eventSubcategory);
    }
    collectTagText(event.tags, structuredLabels);
  }

  const matches = new Set(primaryMatches);
  for (const label of structuredLabels) {
    const category = classifyStructuredLabel(label);
    if (category !== undefined) {
      matches.add(category);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function classifyStructuredLabel(
  value: string
): MarketCategory | undefined {
  return STRUCTURED_CATEGORY_ALLOWLIST.get(normalizeStructuredLabel(value));
}

function normalizeStructuredLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function collectTagText(value: unknown, output: string[]): void {
  for (const item of parsePossiblyJsonArray(value)) {
    if (typeof item === "string") {
      output.push(item);
      continue;
    }
    const tag = asRecord(item);
    if (tag !== undefined) {
      const text = readString(tag, "label", "name", "slug");
      if (text !== undefined) {
        output.push(text);
      }
    }
  }
}

function readStringArray(value: unknown): string[] {
  return parsePossiblyJsonArray(value)
    .map(primitiveToString)
    .filter((item): item is string => item !== undefined);
}

function parsePossiblyJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readArrayPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  if (record === undefined) {
    return [];
  }
  for (const key of ["data", "markets", "positions"] as const) {
    if (Array.isArray(record[key])) {
      return record[key];
    }
  }
  return [];
}

function readRecordArray(value: unknown): JsonRecord[] {
  return parsePossiblyJsonArray(value)
    .map(asRecord)
    .filter((record): record is JsonRecord => record !== undefined);
}

function readOptionalMicros(
  record: JsonRecord,
  ...keys: string[]
): bigint | undefined {
  const value = readValue(record, ...keys);
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  try {
    return parseApiDecimalToMicros(value);
  } catch {
    return undefined;
  }
}

function readMicros(
  record: JsonRecord,
  rounding: DecimalRounding,
  ...keys: string[]
): bigint {
  const value = readValue(record, ...keys);
  if (value === undefined || value === null || value === "") {
    return 0n;
  }
  return parseApiDecimalToMicros(value, rounding);
}

function readRequiredMicros(
  records: JsonRecord[],
  rounding: DecimalRounding,
  ...keys: string[]
): bigint {
  for (const record of records) {
    const value = readValue(record, ...keys);
    if (value !== undefined && value !== null && value !== "") {
      const parsed = parseApiDecimalToMicros(value, rounding);
      if (parsed > 0n) {
        return parsed;
      }
    }
  }
  throw new SafeExternalServiceError(
    "The CLOB response did not contain a valid tick size.",
    {
      code: "INVALID_EXTERNAL_RESPONSE",
      service: "clob",
      retryable: false
    }
  );
}

function readRequiredPortfolioMicros(
  record: JsonRecord,
  rounding: DecimalRounding,
  ...keys: string[]
): bigint {
  const value = readValue(record, ...keys);
  if (value === undefined || value === null || value === "") {
    throw invalidPortfolioResponse();
  }
  try {
    return parseApiDecimalToMicros(value, rounding);
  } catch {
    throw invalidPortfolioResponse();
  }
}

function readRequiredBoundedPortfolioMicros(
  record: JsonRecord,
  rounding: DecimalRounding,
  minimumMicros: bigint,
  maximumMicros: bigint | undefined,
  ...keys: string[]
): bigint {
  const value = readValue(record, ...keys);
  if (value === undefined || value === null || value === "") {
    throw invalidPortfolioResponse();
  }
  try {
    const floorMicros = parseApiDecimalToMicros(value, "floor");
    const ceilMicros = parseApiDecimalToMicros(value, "ceil");
    if (
      floorMicros < minimumMicros ||
      (maximumMicros !== undefined && ceilMicros > maximumMicros)
    ) {
      throw invalidPortfolioResponse();
    }
    return parseApiDecimalToMicros(value, rounding);
  } catch (error) {
    if (error instanceof SafeExternalServiceError) {
      throw error;
    }
    throw invalidPortfolioResponse();
  }
}

function parseTradeActivity(
  value: unknown,
  expectedProfileAddress: string,
  startSeconds: number,
  endSeconds: number
): UserTradeActivity {
  const activity = asRecord(value);
  if (activity === undefined) {
    throw invalidActivityResponse();
  }

  const profileAddress = readString(
    activity,
    "proxyWallet",
    "proxy_wallet"
  );
  const transactionHash = readString(
    activity,
    "transactionHash",
    "transaction_hash"
  );
  const conditionId = readString(
    activity,
    "conditionId",
    "condition_id"
  );
  const tokenId = readString(activity, "asset", "tokenId", "token_id");
  const side = readString(activity, "side");
  const type = readString(activity, "type");
  const timestamp = readValue(activity, "timestamp");

  if (
    profileAddress === undefined ||
    profileAddress.toLowerCase() !== expectedProfileAddress.toLowerCase() ||
    transactionHash === undefined ||
    !/^0x[a-fA-F0-9]{64}$/u.test(transactionHash) ||
    conditionId === undefined ||
    !/^0x[a-fA-F0-9]{64}$/u.test(conditionId) ||
    tokenId === undefined ||
    !/^[A-Za-z0-9._:-]{1,256}$/u.test(tokenId) ||
    (side !== "BUY" && side !== "SELL") ||
    type !== "TRADE" ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp < startSeconds ||
    timestamp > endSeconds
  ) {
    throw invalidActivityResponse();
  }

  let sizeMicros: bigint;
  let priceMicros: bigint;
  let notionalMicros: bigint;
  try {
    sizeMicros = parseApiDecimalToMicros(activity.size, "nearest");
    priceMicros = parseApiDecimalToMicros(activity.price, "nearest");
    notionalMicros = parseApiDecimalToMicros(
      readValue(activity, "usdcSize", "usdc_size"),
      "nearest"
    );
  } catch {
    throw invalidActivityResponse();
  }
  if (
    sizeMicros <= 0n ||
    priceMicros <= 0n ||
    priceMicros > PUSD_SCALE ||
    notionalMicros <= 0n
  ) {
    throw invalidActivityResponse();
  }

  const timestampMs = timestamp * 1_000;
  if (!Number.isSafeInteger(timestampMs)) {
    throw invalidActivityResponse();
  }

  return {
    profileAddress: profileAddress.toLowerCase(),
    transactionHash: transactionHash.toLowerCase(),
    conditionId: conditionId.toLowerCase(),
    tokenId,
    side,
    timestampMs,
    sizeMicros,
    priceMicros,
    notionalMicros
  };
}

function tradeActivityIdentity(activity: UserTradeActivity): string {
  return [
    activity.transactionHash,
    activity.conditionId,
    activity.tokenId,
    activity.side,
    activity.timestampMs,
    activity.sizeMicros,
    activity.priceMicros,
    activity.notionalMicros
  ].join(":");
}

function appendActivities(
  target: UserTradeActivity[],
  values: UserTradeActivity[],
  identities: Set<string>
): void {
  if (target.length + values.length > ACTIVITY_MAX_ROWS) {
    throw truncatedActivityResponse();
  }
  for (const activity of values) {
    const identity = tradeActivityIdentity(activity);
    if (identities.has(identity)) {
      throw truncatedActivityResponse();
    }
    identities.add(identity);
    target.push(activity);
  }
}

function invalidPortfolioResponse(): SafeExternalServiceError {
  return new SafeExternalServiceError(
    "The portfolio response was incomplete or inconsistent.",
    {
      code: "INVALID_PORTFOLIO_RESPONSE",
      service: "data",
      retryable: false
    }
  );
}

function invalidActivityResponse(): SafeExternalServiceError {
  return new SafeExternalServiceError(
    "The user activity response was incomplete or inconsistent.",
    {
      code: "INVALID_ACTIVITY_RESPONSE",
      service: "data",
      retryable: false
    }
  );
}

function truncatedActivityResponse(): SafeExternalServiceError {
  return new SafeExternalServiceError(
    "The user activity response could not be proven complete.",
    {
      code: "ACTIVITY_RESPONSE_TRUNCATED",
      service: "data",
      retryable: false
    }
  );
}

function truncatedPortfolioResponse(): SafeExternalServiceError {
  return new SafeExternalServiceError(
    "The portfolio response could not be proven complete.",
    {
      code: "PORTFOLIO_RESPONSE_TRUNCATED",
      service: "data",
      retryable: false
    }
  );
}

function invalidBookResponse(
  code:
    | "CLOB_BOOK_IDENTITY_MISMATCH"
    | "CLOB_BOOK_TIMESTAMP_INVALID"
    | "CLOB_BOOK_STALE"
    | "CLOB_BOOK_TICK_INVALID"
    | "CLOB_BOOK_TICK_MISMATCH"
    | "CLOB_BOOK_CROSSCHECK_MISMATCH"
    | "CLOB_MARKET_CHANNEL_BOOK_INVALID"
    | "CLOB_MARKET_CHANNEL_BOOK_STALE"
    | "CLOB_MIN_ORDER_SIZE_MISMATCH"
    | "CLOB_BOOK_ONE_SIDED"
    | "CLOB_BOOK_CROSSED"
    | "CLOB_BOOK_MALFORMED",
  message: string
): SafeExternalServiceError {
  return new SafeExternalServiceError(message, {
    code,
    service: "clob",
    retryable: false
  });
}

function readInteger(record: JsonRecord, ...keys: string[]): number {
  const value = readValue(record, ...keys);
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SafeExternalServiceError(
      "The CLOB response did not contain a valid fee rate.",
      {
        code: "INVALID_EXTERNAL_RESPONSE",
        service: "clob",
        retryable: false
      }
    );
  }
  return parsed;
}

function feeRateToBps(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new SafeExternalServiceError(
      "The CLOB response did not contain a valid fee rate.",
      {
        code: "INVALID_EXTERNAL_RESPONSE",
        service: "clob",
        retryable: false
      }
    );
  }
  let rateMicros: bigint;
  try {
    const floorMicros = parseApiDecimalToMicros(value, "floor");
    const ceilMicros = parseApiDecimalToMicros(value, "ceil");
    if (
      floorMicros !== ceilMicros ||
      floorMicros % 100n !== 0n
    ) {
      throw new Error("Fee rate is not an exact basis-point value.");
    }
    rateMicros = floorMicros;
  } catch {
    throw new SafeExternalServiceError(
      "The CLOB fee rate cannot be represented exactly in basis points.",
      {
        code: "INVALID_EXTERNAL_RESPONSE",
        service: "clob",
        retryable: false
      }
    );
  }
  const bps = rateMicros / 100n;
  if (bps > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SafeExternalServiceError(
      "The CLOB fee rate is outside the supported range.",
      {
        code: "INVALID_EXTERNAL_RESPONSE",
        service: "clob",
        retryable: false
      }
    );
  }
  return Number(bps);
}

function readTokenFeeRateBps(record: JsonRecord): number {
  const value = readValue(record, "base_fee", "baseFee");
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : typeof value === "string" && /^\d{1,9}$/u.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > 100_000
  ) {
    throw new SafeExternalServiceError(
      "The token fee-rate response was invalid.",
      {
        code: "INVALID_EXTERNAL_RESPONSE",
        service: "clob",
        retryable: false
      }
    );
  }
  return parsed;
}

function readFeeExponent(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8
  ) {
    throw new SafeExternalServiceError(
      "The CLOB fee exponent is outside the supported range.",
      {
        code: "INVALID_EXTERNAL_RESPONSE",
        service: "clob",
        retryable: false
      }
    );
  }
  return value;
}

function readRequiredBoolean(
  record: JsonRecord,
  service: string,
  message: string,
  ...keys: string[]
): boolean {
  const value = readValue(record, ...keys);
  if (typeof value !== "boolean") {
    throw new SafeExternalServiceError(message, {
      code: "INVALID_EXTERNAL_RESPONSE",
      service,
      retryable: false
    });
  }
  return value;
}

function readDateMs(record: JsonRecord, ...keys: string[]): number {
  const value = readValue(record, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.trunc(value * 1_000) : Math.trunc(value);
  }
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  if (/^\d+$/u.test(value)) {
    const integer = Number.parseInt(value, 10);
    return integer < 10_000_000_000 ? integer * 1_000 : integer;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readBoolean(
  record: JsonRecord,
  fallback: boolean,
  ...keys: string[]
): boolean {
  const value = readValue(record, ...keys);
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (value === "false" || value === 0 || value === "0") {
    return false;
  }
  return fallback;
}

function readString(record: JsonRecord, ...keys: string[]): string | undefined {
  const value = readValue(record, ...keys);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readValue(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function primitiveToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  return requireServiceRecord(
    value,
    "clob",
    `${label} was malformed.`
  );
}

function requireServiceRecord(
  value: unknown,
  service: string,
  message: string
): JsonRecord {
  const record = asRecord(value);
  if (record === undefined) {
    throw new SafeExternalServiceError(message, {
      code: "INVALID_EXTERNAL_RESPONSE",
      service,
      retryable: false
    });
  }
  return record;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function normalizeHost(host: string): string {
  const url = new URL(host);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Public API hosts must use HTTPS, except for loopback tests.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function assertProfileAddress(profileAddress: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/u.test(profileAddress)) {
    throw new Error("profileAddress must be a 20-byte hexadecimal address.");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function parseRetryAfterMs(
  retryAfter: string | null,
  nowMs: number
): number | undefined {
  if (retryAfter === null) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/u.test(retryAfter)) {
    return Math.max(0, Math.ceil(Number(retryAfter) * 1_000));
  }
  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(0.999_999, Math.max(0, value));
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function sumBigInts(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

class PublicHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs: number | undefined) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export { PolymarketPublicClient as PublicPolymarketClient };
