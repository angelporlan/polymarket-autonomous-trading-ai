import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolDependencies } from "../src/mcp/server.js";
import {
  getMarketSnapshotOutputSchema,
  getPortfolioOutputSchema,
  scanCandidatesOutputSchema
} from "../src/mcp/schemas.js";
import { marketFixture } from "./fixtures.js";

const publicClientMocks = vi.hoisted(() => ({
  profileExists: vi.fn(),
  getPortfolio: vi.fn(),
  scanCandidates: vi.fn(),
  getMarketSnapshot: vi.fn(),
  resolveMarketReference: vi.fn(),
  checkGeoblock: vi.fn()
}));

vi.mock("../src/polymarket/public-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/polymarket/public-client.js")>();
  return {
    ...actual,
    PolymarketPublicClient: class {
      profileExists(profileAddress: string) {
        return publicClientMocks.profileExists(profileAddress);
      }

      getPortfolio(profileAddress: string) {
        return publicClientMocks.getPortfolio(profileAddress);
      }

      scanCandidates(categories: unknown) {
        return publicClientMocks.scanCandidates(categories);
      }

      getMarketSnapshot(reference: unknown) {
        return publicClientMocks.getMarketSnapshot(reference);
      }

      resolveMarketReference(reference: unknown) {
        return publicClientMocks.resolveMarketReference(reference);
      }

      checkGeoblock() {
        return publicClientMocks.checkGeoblock();
      }
    }
  };
});

vi.mock("../src/polymarket/live-adapter.js", () => ({
  GuardedLiveTradingAdapter: class {
    async configured() {
      return false;
    }

    async stopHeartbeat() {}

    beginShutdown() {}

    close() {}
  }
}));

import { createMcpToolDependencies } from "../src/runtime.js";

const PROFILE_ADDRESS = `0x${"a".repeat(40)}`;
const savedEnvironment = {
  profile: process.env.POLYMARKET_PROFILE_ADDRESS,
  database: process.env.POLYMARKET_DB_PATH,
  live: process.env.POLYMARKET_LIVE_ENABLED,
  paperGateSkip: process.env.PAPER_GATE_SKIP
};
const runtimes: McpToolDependencies[] = [];
const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  const directory = mkdtempSync(
    path.join(tmpdir(), "polymarket-runtime-mapping-test-")
  );
  temporaryDirectories.push(directory);
  process.env.POLYMARKET_PROFILE_ADDRESS = PROFILE_ADDRESS;
  process.env.POLYMARKET_DB_PATH = path.join(directory, "runtime.sqlite");
  process.env.POLYMARKET_LIVE_ENABLED = "false";
  process.env.PAPER_GATE_SKIP = "false";
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.close?.();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  restoreEnvironment("POLYMARKET_PROFILE_ADDRESS", savedEnvironment.profile);
  restoreEnvironment("POLYMARKET_DB_PATH", savedEnvironment.database);
  restoreEnvironment("POLYMARKET_LIVE_ENABLED", savedEnvironment.live);
  restoreEnvironment("PAPER_GATE_SKIP", savedEnvironment.paperGateSkip);
});

describe("runtime MCP boundary mapping", () => {
  it("maps portfolio, candidate, and order-book values to schema-safe decimal strings without network access", async () => {
    const capturedAtMs = Date.parse("2026-07-23T14:00:00.000Z");
    const snapshot = marketFixture(capturedAtMs);
    publicClientMocks.getPortfolio.mockResolvedValue({
      profileAddress: PROFILE_ADDRESS,
      pUsdBalanceMicros: null,
      totalPositionValueMicros: 1_234_567n,
      totalPnlMicros: -250_001n,
      positions: [
        {
          tokenId: snapshot.tokenId,
          conditionId: snapshot.conditionId,
          question: "",
          outcome: "",
          sizeMicros: 3_500_000n,
          averagePriceMicros: 400_000n,
          currentPriceMicros: 350_000n,
          currentValueMicros: 1_225_000n,
          cashPnlMicros: -175_000n,
          realizedPnlMicros: -75_001n,
          endTimeMs: snapshot.endTimeMs
        }
      ],
      capturedAtMs,
      source: "public"
    });
    publicClientMocks.scanCandidates.mockResolvedValue([
      {
        conditionId: snapshot.conditionId,
        slug: snapshot.slug,
        question: snapshot.question,
        category: "politics",
        endTimeMs: snapshot.endTimeMs,
        volume24hMicros: 12_345_678n,
        liquidityMicros: 2_500_000n,
        spreadMicros: 12_345n,
        tokenIds: [snapshot.tokenId],
        active: true,
        acceptingOrders: true
      },
      {
        conditionId: `0x${"2".repeat(64)}`,
        slug: "below-minimum-liquidity",
        question: "A market filtered out at the runtime boundary",
        category: "technology",
        endTimeMs: snapshot.endTimeMs,
        volume24hMicros: 10n,
        liquidityMicros: 500_000n,
        spreadMicros: null,
        tokenIds: ["222"],
        active: true,
        acceptingOrders: true
      }
    ]);
    publicClientMocks.resolveMarketReference.mockResolvedValue({
      conditionId: snapshot.conditionId,
      tokenId: snapshot.tokenId,
      outcome: snapshot.outcome
    });
    publicClientMocks.getMarketSnapshot.mockResolvedValue(snapshot);
    publicClientMocks.checkGeoblock.mockResolvedValue({
      blocked: false,
      country: "ES",
      region: "MD",
      checkedAtMs: capturedAtMs
    });

    const dependencies = await createMcpToolDependencies();
    runtimes.push(dependencies);

    const portfolio = await dependencies.getPortfolio({});
    expect(getPortfolioOutputSchema.parse(portfolio)).toEqual(portfolio);
    expect(portfolio).toMatchObject({
      profileAddress: PROFILE_ADDRESS,
      pUsdBalancePusd: null,
      totalPositionValuePusd: "1.234567",
      totalPnlPusd: "-0.250001",
      positions: [
        {
          question: "Unavailable market title",
          outcome: "Unavailable outcome",
          sizeShares: "3.5",
          averagePricePusd: "0.4",
          currentPricePusd: "0.35",
          currentValuePusd: "1.225",
          cashPnlPusd: "-0.175",
          realizedPnlPusd: "-0.075001"
        }
      ],
      capturedAt: "2026-07-23T14:00:00.000Z",
      source: "public"
    });
    expect(publicClientMocks.getPortfolio).toHaveBeenCalledWith(PROFILE_ADDRESS);

    const candidates = await dependencies.scanCandidates({
      categories: ["politics", "technology"],
      limit: 20,
      minLiquidityPusd: "1"
    });
    expect(scanCandidatesOutputSchema.parse(candidates)).toEqual(candidates);
    expect(candidates.candidates).toEqual([
      expect.objectContaining({
        conditionId: snapshot.conditionId,
        volume24hPusd: "12.345678",
        liquidityPusd: "2.5",
        spreadPusd: "0.012345"
      })
    ]);
    expect(publicClientMocks.scanCandidates).toHaveBeenCalledWith([
      "politics",
      "technology"
    ]);

    const market = await dependencies.getMarketSnapshot({
      tokenId: snapshot.tokenId,
      side: "BUY",
      limitPricePusd: "0.42"
    });
    expect(getMarketSnapshotOutputSchema.parse(market)).toEqual(market);
    expect(market).toMatchObject({
      conditionId: snapshot.conditionId,
      tokenId: snapshot.tokenId,
      bestBidPusd: "0.39",
      bestAskPusd: "0.4",
      spreadPusd: "0.01",
      depthPusdAtLimit: "100",
      geoblockStatus: "allowed",
      capturedAt: "2026-07-23T14:00:00.000Z"
    });
    expect(publicClientMocks.resolveMarketReference).toHaveBeenCalledWith({
      tokenId: snapshot.tokenId
    });
    expect(publicClientMocks.getMarketSnapshot).toHaveBeenCalledWith({
      conditionId: snapshot.conditionId,
      tokenId: snapshot.tokenId,
      outcome: snapshot.outcome,
      side: "BUY",
      limitPriceMicros: 420_000n
    });
    expect(publicClientMocks.checkGeoblock).toHaveBeenCalledTimes(1);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
