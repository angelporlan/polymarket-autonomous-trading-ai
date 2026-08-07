import { describe, expect, it } from "vitest";
import {
  ResearchVerificationError,
  ResearchVerifier
} from "../src/research/verifier.js";
import { TradingDatabase } from "../src/storage/database.js";

const NOW_MS = Date.parse("2026-08-07T12:00:00.000Z");
const RECENT = new Date(NOW_MS - 60 * 60 * 1_000).toISOString();

function page(publisher: string, title: string, publishedAt = RECENT): string {
  return `<!doctype html>
    <html><head>
      <title>${title}</title>
      <meta property="og:site_name" content="${publisher}">
      <meta property="article:published_time" content="${publishedAt}">
    </head><body><article>${title} supporting details and counterpoints.</article></body></html>`;
}

function verifier(fetchImpl: typeof fetch) {
  return new ResearchVerifier({
    now: () => NOW_MS,
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl
  });
}

const input = {
  marketConditionId: "condition-1",
  tokenId: "token-1",
  estimatedProbabilityMicros: 600_000n,
  eventVolatilityClass: "SLOW" as const,
  requestedUrls: [
    "https://www.reuters.com/world/example-verified",
    "https://www.apnews.com/article/example-verified"
  ],
  rationale: "Two independently retrieved sources support the current estimate.",
  counterRationale: "The official event could still resolve against the estimate."
};

describe("ResearchVerifier", () => {
  it("verifies independent HTTPS sources and stores hashes instead of article bodies", async () => {
    const result = await verifier(async (url) => {
      const requested = String(url);
      return new Response(
        page(
          requested.includes("reuters") ? "Reuters" : "Associated Press",
          requested.includes("reuters")
            ? "Reuters verified report"
            : "AP verified report"
        ),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }).verify(input);

    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.registrableDomain)).toEqual([
      "reuters.com",
      "apnews.com"
    ]);
    expect(result.sources[0]?.responseBodyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.sources[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result).not.toHaveProperty("body");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.expiresAtMs).toBe(NOW_MS + 7 * 24 * 60 * 60 * 1_000);
    const database = new TradingDatabase(":memory:");
    database.saveResearchBundle(result);
    expect(database.getResearchBundle(result.id)).toEqual(result);
    expect(
      database.getLatestResearchBundle(result.marketConditionId, result.tokenId, NOW_MS)
    ).toEqual(result);
    database.close();
  });

  it("rejects two nonexistent Reuters/AP pages", async () => {
    await expect(
      verifier(async () =>
        new Response("not found", {
          status: 404,
          headers: { "content-type": "text/plain" }
        })
      ).verify(input)
    ).rejects.toThrowError(ResearchVerificationError);
  });

  it("blocks non-HTTPS, private DNS, redirects, unsupported content, and stale FAST sources", async () => {
    await expect(
      verifier(async () => new Response("ok", { status: 200 })).verify({
        ...input,
        requestedUrls: ["http://www.reuters.com/a", input.requestedUrls[1]!]
      })
    ).rejects.toThrow("RESEARCH_SOURCE_URL_BLOCKED");

    await expect(
      new ResearchVerifier({
        now: () => NOW_MS,
        resolveHostname: async () => ["127.0.0.1"],
        fetchImpl: async () => new Response("ok", { status: 200 })
      }).verify(input)
    ).rejects.toThrow("RESEARCH_PRIVATE_HOST_BLOCKED");

    await expect(
      verifier(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://www.apnews.com/redirected" }
        })
      ).verify(input)
    ).rejects.toThrow("RESEARCH_REDIRECT_LIMIT");

    await expect(
      verifier(async () =>
        new Response("binary", {
          status: 200,
          headers: { "content-type": "application/pdf" }
        })
      ).verify(input)
    ).rejects.toThrow("RESEARCH_CONTENT_TYPE_UNSUPPORTED");

    await expect(
      verifier(async (url) =>
        new Response(
          page("Publisher", "Stale verified report", new Date(NOW_MS - 49 * 60 * 60 * 1_000).toISOString()),
          { status: 200, headers: { "content-type": "text/html" } }
        )
      ).verify({ ...input, eventVolatilityClass: "FAST" })
    ).rejects.toThrow("RESEARCH_SOURCE_TOO_OLD");
  });
});
