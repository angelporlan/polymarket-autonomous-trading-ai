import type { EvidenceSource } from "./types.js";

export interface SourceValidationResult {
  valid: boolean;
  violations: string[];
}

const FORBIDDEN_DOMAINS = new Set([
  "polymarket.com",
  "clob.polymarket.com",
  "gamma-api.polymarket.com",
  "data-api.polymarket.com",
  "example.com",
  "test.com",
  "dummy.com",
  "localhost"
]);

export const MAX_SOURCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days max age

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

    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      violations.push(`${label}: URL must use HTTP or HTTPS protocol.`);
    }

    const domain = urlObj.hostname.toLowerCase();
    if (FORBIDDEN_DOMAINS.has(domain) || domain.endsWith(".polymarket.com")) {
      violations.push(`${label}: domain '${domain}' is forbidden or a Polymarket self-reference.`);
    } else {
      validDomains.add(domain);
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
        // 1 min clock skew grace period
        violations.push(`${label}: publishedAt cannot be in the future.`);
      } else if (nowMs - pubMs > MAX_SOURCE_AGE_MS) {
        violations.push(`${label}: publishedAt is older than 7 days.`);
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
