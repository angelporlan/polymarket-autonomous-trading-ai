import { describe, expect, it } from "vitest";
import { validateEvidenceSources } from "../src/domain/source-validator.js";
import type { EvidenceSource } from "../src/domain/types.js";

describe("SourceValidator", () => {
  const nowMs = 1700000000000;
  const recentDate = new Date(nowMs - 3600 * 1000).toISOString();

  it("validates two independent valid sources", () => {
    const sources: EvidenceSource[] = [
      {
        url: "https://www.reuters.com/world/europe/election-update-2026",
        title: "Official Reuters election update report",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: true
      },
      {
        url: "https://www.apnews.com/article/spain-parliament-vote",
        title: "Associated Press analysis on parliamentary vote",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: false
      }
    ];

    const result = validateEvidenceSources(sources, nowMs);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects sources with fewer than 2 items", () => {
    const sources: EvidenceSource[] = [
      {
        url: "https://www.reuters.com/world/europe/election-update-2026",
        title: "Official Reuters election update report",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: true
      }
    ];

    const result = validateEvidenceSources(sources, nowMs);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("At least two independent evidence sources are required.");
  });

  it("rejects sources missing a primary flag", () => {
    const sources: EvidenceSource[] = [
      {
        url: "https://www.reuters.com/world/europe/election-update-2026",
        title: "Official Reuters election update report",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: false
      },
      {
        url: "https://www.apnews.com/article/spain-parliament-vote",
        title: "Associated Press analysis on parliamentary vote",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: false
      }
    ];

    const result = validateEvidenceSources(sources, nowMs);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("At least one evidence source must be marked as primary.");
  });

  it("rejects sources from identical domains", () => {
    const sources: EvidenceSource[] = [
      {
        url: "https://www.reuters.com/article1",
        title: "Reuters article part 1 for elections",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: true
      },
      {
        url: "https://www.reuters.com/article2",
        title: "Reuters article part 2 for elections",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: false
      }
    ];

    const result = validateEvidenceSources(sources, nowMs);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("Sources must come from at least two distinct independent domains.");
  });

  it("rejects Polymarket self-references and fake domains", () => {
    const sources: EvidenceSource[] = [
      {
        url: "https://polymarket.com/event/macron-snap-election",
        title: "Polymarket event details page metadata",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: true
      },
      {
        url: "https://example.com/test",
        title: "Dummy test page example news report",
        publishedAt: recentDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: false
      }
    ];

    const result = validateEvidenceSources(sources, nowMs);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("forbidden or a Polymarket self-reference"))).toBe(true);
  });

  it("rejects sources older than 7 days or in the future", () => {
    const futureDate = new Date(nowMs + 86400 * 1000 * 10).toISOString();
    const ancientDate = new Date(nowMs - 86400 * 1000 * 10).toISOString();

    const sources: EvidenceSource[] = [
      {
        url: "https://www.bbc.com/news/123",
        title: "BBC News future prediction analysis",
        publishedAt: futureDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: true
      },
      {
        url: "https://www.ft.com/content/456",
        title: "Financial Times old market report",
        publishedAt: ancientDate,
        retrievedAt: new Date(nowMs).toISOString(),
        primary: false
      }
    ];

    const result = validateEvidenceSources(sources, nowMs);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("future"))).toBe(true);
    expect(result.violations.some((v) => v.includes("older than 7 days"))).toBe(true);
  });
});
