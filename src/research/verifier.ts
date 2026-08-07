import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hashCanonical } from "../domain/proposals.js";
import {
  CRISIS_SOURCE_AGE_MS,
  extractRegistrableDomain,
  isRecognizedEvidenceDomain,
  MAX_SOURCE_AGE_MS
} from "../domain/source-validator.js";
import type {
  EventVolatilityClass,
  ResearchBundle,
  VerifiedSource
} from "../domain/types.js";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const ACCEPTED_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml"
]);

export interface ResearchBundleInput {
  marketConditionId: string;
  tokenId: string;
  estimatedProbabilityMicros: bigint;
  eventVolatilityClass: EventVolatilityClass;
  requestedUrls: string[];
  sourceEvidence: ResearchSourceEvidenceInput[];
  rationale: string;
  counterRationale: string;
}

export interface ResearchSourceEvidenceInput {
  requestedUrl: string;
  supportedClaims: string[];
  contradictedClaims: string[];
  quotedFacts: string[];
  probabilityImpactMicros: bigint;
}

export interface ResearchVerifierOptions {
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

export class ResearchVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchVerificationError";
  }
}

export class ResearchVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly now: () => number;

  constructor(options: ResearchVerifierOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveHostname =
      options.resolveHostname ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map(
          (entry) => entry.address
        ));
    this.now = options.now ?? Date.now;
  }

  async verify(input: ResearchBundleInput): Promise<ResearchBundle> {
    const nowMs = this.now();
    validateBundleInput(input);
    const maxAgeMs =
      input.eventVolatilityClass === "FAST"
        ? CRISIS_SOURCE_AGE_MS
        : MAX_SOURCE_AGE_MS;
    const verifiedSources: VerifiedSource[] = [];
    const domains = new Set<string>();
    const seenUrls = new Set<string>();
    const sourceEvidenceByUrl = new Map(
      input.sourceEvidence.map((candidate) => [
        validatePublicSourceUrl(candidate.requestedUrl),
        candidate
      ])
    );

    for (const requestedUrl of input.requestedUrls) {
      const normalizedRequestedUrl = validatePublicSourceUrl(requestedUrl);
      if (seenUrls.has(normalizedRequestedUrl)) {
        throw new ResearchVerificationError("RESEARCH_SOURCE_DUPLICATE");
      }
      seenUrls.add(normalizedRequestedUrl);
      const fetched = await this.fetchSource(normalizedRequestedUrl);
      const sourceEvidence = sourceEvidenceByUrl.get(normalizedRequestedUrl);
      if (sourceEvidence === undefined) {
        throw new ResearchVerificationError("RESEARCH_SOURCE_EVIDENCE_MISSING");
      }
      const source = parseVerifiedSource(
        normalizedRequestedUrl,
        fetched.finalUrl,
        fetched.httpStatus,
        fetched.contentType,
        fetched.body,
        nowMs
      );
      const semanticEvidence = verifySourceEvidence(sourceEvidence, fetched.body);
      if (nowMs - source.publishedAtMs > maxAgeMs) {
        throw new ResearchVerificationError(
          `RESEARCH_SOURCE_TOO_OLD: ${source.finalUrl}`
        );
      }
      domains.add(source.registrableDomain);
      verifiedSources.push({ ...source, ...semanticEvidence });
    }

    if (domains.size < 2) {
      throw new ResearchVerificationError("RESEARCH_DOMAINS_NOT_INDEPENDENT");
    }

    const bundleWithoutHash = {
      id: `research_${nowMs}_${randomUUID().slice(0, 8)}`,
      marketConditionId: input.marketConditionId,
      tokenId: input.tokenId,
      estimatedProbabilityMicros: input.estimatedProbabilityMicros,
      eventVolatilityClass: input.eventVolatilityClass,
      createdAtMs: nowMs,
      expiresAtMs: Math.min(
        nowMs + maxAgeMs,
        ...verifiedSources.map((source) => source.publishedAtMs + maxAgeMs)
      ),
      sources: verifiedSources,
      rationale: input.rationale.trim(),
      counterRationale: input.counterRationale.trim()
    } satisfies Omit<ResearchBundle, "contentHash">;
    return {
      ...bundleWithoutHash,
      contentHash: hashCanonical(bundleWithoutHash)
    };
  }

  private async fetchSource(requestedUrl: string): Promise<{
    finalUrl: string;
    httpStatus: number;
    contentType: string;
    body: string;
  }> {
    let currentUrl = requestedUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicHostname(new URL(currentUrl).hostname, this.resolveHostname);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      timer.unref();
      let response: Response;
      try {
        response = await this.fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "text/html,text/plain,application/xhtml+xml" }
        });
      } catch {
        throw new ResearchVerificationError("RESEARCH_SOURCE_FETCH_FAILED");
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null || redirectCount === MAX_REDIRECTS) {
          throw new ResearchVerificationError("RESEARCH_REDIRECT_LIMIT");
        }
        currentUrl = validatePublicSourceUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ResearchVerificationError("RESEARCH_SOURCE_HTTP_STATUS");
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
        throw new ResearchVerificationError("RESEARCH_CONTENT_TYPE_UNSUPPORTED");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
        throw new ResearchVerificationError("RESEARCH_RESPONSE_TOO_LARGE");
      }
      const body = await readResponseBodyWithTimeout(response);
      return {
        finalUrl: currentUrl,
        httpStatus: response.status,
        contentType,
        body
      };
    }
    throw new ResearchVerificationError("RESEARCH_REDIRECT_LIMIT");
  }
}

async function assertPublicHostname(
  hostname: string,
  resolveHostname: (hostname: string) => Promise<string[]>
): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata.google.internal"
  ) {
    throw new ResearchVerificationError("RESEARCH_PRIVATE_HOST_BLOCKED");
  }
  if (isIP(normalized) !== 0) {
    if (isPrivateOrSpecialIp(normalized)) {
      throw new ResearchVerificationError("RESEARCH_PRIVATE_HOST_BLOCKED");
    }
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolveHostname(normalized);
  } catch {
    throw new ResearchVerificationError("RESEARCH_HOST_RESOLUTION_FAILED");
  }
  if (addresses.length === 0 || addresses.some(isPrivateOrSpecialIp)) {
    throw new ResearchVerificationError("RESEARCH_PRIVATE_HOST_BLOCKED");
  }
}

function validatePublicSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResearchVerificationError("RESEARCH_SOURCE_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !isRecognizedEvidenceDomain(url.hostname)
  ) {
    throw new ResearchVerificationError("RESEARCH_SOURCE_URL_BLOCKED");
  }
  return url.toString();
}

async function readResponseBody(response: Response): Promise<string> {
  if (response.body === null) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new ResearchVerificationError("RESEARCH_RESPONSE_TOO_LARGE");
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new ResearchVerificationError("RESEARCH_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readResponseBodyWithTimeout(response: Response): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readResponseBody(response),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ResearchVerificationError("RESEARCH_SOURCE_TIMEOUT")),
          FETCH_TIMEOUT_MS
        );
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseVerifiedSource(
  requestedUrl: string,
  finalUrl: string,
  httpStatus: number,
  contentType: string,
  body: string,
  nowMs: number
): Omit<
  VerifiedSource,
  | "supportedClaims"
  | "contradictedClaims"
  | "quotedFactHashes"
  | "probabilityImpactMicros"
> {
  const final = validatePublicSourceUrl(finalUrl);
  const url = new URL(final);
  const title = extractTitle(body);
  const publishedAtMs = extractPublishedAtMs(body);
  if (title === null || publishedAtMs === null) {
    throw new ResearchVerificationError("RESEARCH_METADATA_MISSING");
  }
  if (publishedAtMs > nowMs + 60_000) {
    throw new ResearchVerificationError("RESEARCH_PUBLISHED_DATE_FUTURE");
  }
  const normalizedText = stripHtml(body).replace(/\s+/gu, " ").trim();
  return {
    requestedUrl,
    finalUrl: final,
    registrableDomain: extractRegistrableDomain(url.hostname),
    publisher: extractPublisher(body) ?? extractRegistrableDomain(url.hostname),
    title,
    publishedAtMs,
    retrievedAtMs: nowMs,
    httpStatus,
    contentType,
    excerptHash: sha256(normalizedText.slice(0, 500)),
    responseBodyHash: sha256(body)
  };
}

function verifySourceEvidence(
  evidence: ResearchSourceEvidenceInput,
  body: string
): Pick<
  VerifiedSource,
  | "supportedClaims"
  | "contradictedClaims"
  | "quotedFactHashes"
  | "probabilityImpactMicros"
> {
  const normalizedBody = stripHtml(body)
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  const quotedFactHashes = evidence.quotedFacts.map((quote) => {
    const normalizedQuote = quote.replace(/\s+/gu, " ").trim().toLowerCase();
    if (!normalizedBody.includes(normalizedQuote)) {
      throw new ResearchVerificationError("RESEARCH_QUOTED_FACT_NOT_FOUND");
    }
    return sha256(normalizedQuote);
  });
  return {
    supportedClaims: evidence.supportedClaims.map((claim) => claim.trim()),
    contradictedClaims: evidence.contradictedClaims.map((claim) => claim.trim()),
    quotedFactHashes,
    probabilityImpactMicros: evidence.probabilityImpactMicros
  };
}

function extractTitle(body: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(body);
  const title = match?.[1] === undefined ? "" : decodeEntities(stripHtml(match[1]));
  return title.trim().length >= 3 ? title.trim().slice(0, 500) : null;
}

function extractPublishedAtMs(body: string): number | null {
  const metaPattern = /<meta\b[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/giu;
  for (const match of body.matchAll(metaPattern)) {
    if (
      ["article:published_time", "date", "datepublished", "pubdate"].includes(
        match[1]!.toLowerCase()
      )
    ) {
      const parsed = Date.parse(match[2]!);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  const time = /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/iu.exec(body)?.[1];
  if (time !== undefined) {
    const parsed = Date.parse(time);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const jsonLd = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of body.matchAll(jsonLd)) {
    try {
      const parsed = JSON.parse(match[1]!);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const value = candidate?.datePublished;
        if (typeof value === "string") {
          const timestamp = Date.parse(value);
          if (!Number.isNaN(timestamp)) return timestamp;
        }
      }
    } catch {
      // Ignore malformed metadata; the source remains unverifiable.
    }
  }
  return null;
}

function extractPublisher(body: string): string | null {
  const match = /<meta\b[^>]*(?:property|name)=["'](?:og:site_name|publisher)["'][^>]*content=["']([^"']+)["'][^>]*>/iu.exec(body);
  const publisher = match?.[1]?.trim();
  return publisher === undefined || publisher.length === 0
    ? null
    : publisher.slice(0, 200);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateBundleInput(input: ResearchBundleInput): void {
  if (
    input.marketConditionId.trim().length === 0 ||
    input.tokenId.trim().length === 0 ||
    input.estimatedProbabilityMicros < 0n ||
    input.estimatedProbabilityMicros > 1_000_000n
  ) {
    throw new ResearchVerificationError("RESEARCH_BUNDLE_INPUT_INVALID");
  }
  if (input.requestedUrls.length < 2 || input.requestedUrls.length > 5) {
    throw new ResearchVerificationError("RESEARCH_NEEDS_TWO_SOURCES");
  }
  if (
    input.sourceEvidence.length !== input.requestedUrls.length ||
    input.sourceEvidence.some(
      (evidence) =>
        evidence.supportedClaims.length + evidence.contradictedClaims.length === 0 ||
        evidence.quotedFacts.length === 0 ||
        evidence.probabilityImpactMicros < -1_000_000n ||
        evidence.probabilityImpactMicros > 1_000_000n
    )
  ) {
    throw new ResearchVerificationError("RESEARCH_SOURCE_EVIDENCE_INVALID");
  }
  const normalizedUrls = input.requestedUrls.map(validatePublicSourceUrl);
  const evidenceUrls = input.sourceEvidence.map((evidence) =>
    validatePublicSourceUrl(evidence.requestedUrl)
  );
  if (
    new Set(evidenceUrls).size !== evidenceUrls.length ||
    normalizedUrls.some((url) => !evidenceUrls.includes(url))
  ) {
    throw new ResearchVerificationError("RESEARCH_SOURCE_EVIDENCE_MISMATCH");
  }
  if (input.rationale.trim().length < 20 || input.counterRationale.trim().length < 20) {
    throw new ResearchVerificationError("RESEARCH_RATIONALE_INVALID");
  }
}

function isPrivateOrSpecialIp(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.includes(":")) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first, second] = octets as [number, number, number?, number?];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second! >= 64 && second! <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && second! >= 18 && second! <= 19) ||
    first >= 224
  );
}
