import type { EvidenceSource } from "./types.js";

export interface SourceValidationResult {
  valid: boolean;
  violations: string[];
}

export const FORBIDDEN_DOMAINS = new Set([
  "polymarket.com",
  "clob.polymarket.com",
  "gamma-api.polymarket.com",
  "data-api.polymarket.com",
  "example.com",
  "test.com",
  "dummy.com",
  "localhost"
]);

export function extractRegistrableDomain(hostname: string): string {
  const host = hostname.toLowerCase();
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (["co.uk", "gov.uk", "com.es", "org.uk", "europa.eu"].includes(last2)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export const ALLOWED_ROOT_DOMAINS = new Set([
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "ft.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "wsj.com",
  "economist.com",
  "lemonde.fr",
  "elpais.com",
  "boe.es",
  "federalreserve.gov",
  "ecb.europa.eu"
]);

export const MAX_SOURCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days max age
export const CRISIS_SOURCE_AGE_MS = 48 * 60 * 60 * 1_000; // 48 hours max age for breaking crisis

export function isRecognizedEvidenceDomain(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const rootDomain = extractRegistrableDomain(host);
  return (
    !FORBIDDEN_DOMAINS.has(host) &&
    !FORBIDDEN_DOMAINS.has(rootDomain) &&
    !host.endsWith(".polymarket.com") &&
    (ALLOWED_ROOT_DOMAINS.has(rootDomain) ||
      rootDomain.endsWith(".gov") ||
      rootDomain.endsWith(".edu") ||
      rootDomain.endsWith(".eu") ||
      rootDomain.endsWith(".org"))
  );
}

export function validateEvidenceSources(
  sources: EvidenceSource[],
  nowMs: number = Date.now()
): SourceValidationResult {
  const violations: string[] = [];

  if (!Array.isArray(sources) || sources.length < 2) {
    violations.push("At least two independent evidence sources are required.");
    return { valid: false, violations };
  }

  const hasPrimary = sources.some((s) => s.primary === true);
  if (!hasPrimary) {
    violations.push("At least one evidence source must be marked as primary.");
  }

  const validDomains = new Set<string>();

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const label = `Source #${index + 1}`;

    if (!source.url || typeof source.url !== "string") {
      violations.push(`${label}: missing URL.`);
      continue;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(source.url);
    } catch {
      violations.push(`${label}: invalid URL format '${source.url}'.`);
      continue;
    }

    if (urlObj.protocol !== "https:") {
      violations.push(`${label}: URL must use HTTPS protocol.`);
    }

    const host = urlObj.hostname.toLowerCase();
    const rootDomain = extractRegistrableDomain(host);

    if (FORBIDDEN_DOMAINS.has(host) || FORBIDDEN_DOMAINS.has(rootDomain) || host.endsWith(".polymarket.com")) {
      violations.push(`${label}: domain '${host}' is forbidden or a Polymarket self-reference.`);
    } else if (
      !ALLOWED_ROOT_DOMAINS.has(rootDomain) &&
      !rootDomain.endsWith(".gov") &&
      !rootDomain.endsWith(".edu") &&
      !rootDomain.endsWith(".eu") &&
      !rootDomain.endsWith(".org")
    ) {
      violations.push(`${label}: domain '${host}' is not a recognized news or official primary source.`);
    } else {
      validDomains.add(rootDomain);
    }

    if (!source.title || typeof source.title !== "string" || source.title.trim().length < 10) {
      violations.push(`${label}: title must be at least 10 characters.`);
    }

    if (!source.publishedAt || typeof source.publishedAt !== "string") {
      violations.push(`${label}: missing publishedAt date.`);
    } else {
      const pubMs = Date.parse(source.publishedAt);
      if (Number.isNaN(pubMs)) {
        violations.push(`${label}: publishedAt '${source.publishedAt}' is not a valid ISO timestamp.`);
      } else if (pubMs > nowMs + 60_000) {
        violations.push(`${label}: publishedAt cannot be in the future.`);
      } else if (nowMs - pubMs > MAX_SOURCE_AGE_MS) {
        violations.push(`${label}: publishedAt is older than 7 days.`);
      }
    }

    if (source.retrievedAt && typeof source.retrievedAt === "string") {
      const retMs = Date.parse(source.retrievedAt);
      if (Number.isNaN(retMs) || retMs > nowMs + 60_000) {
        violations.push(`${label}: retrievedAt must be a valid non-future ISO timestamp.`);
      }
    }
  }

  if (validDomains.size < 2) {
    violations.push("Sources must come from at least two distinct independent domains.");
  }

  return {
    valid: violations.length === 0,
    violations
  };
}
