import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((value) => value.toLowerCase());

const envSchema = z.object({
  POLYMARKET_PROFILE_ADDRESS: addressSchema.default(
    "0x0000000000000000000000000000000000000000"
  ),
  POLYMARKET_DB_PATH: z.string().default("./data/polymarket.sqlite"),
  POLYMARKET_APPROVAL_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  POLYMARKET_APPROVAL_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  POLYMARKET_LIVE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PAPER_GATE_SKIP: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYMARKET_KEYCHAIN_SERVICE: z
    .literal("codex-polymarket-guarded")
    .default("codex-polymarket-guarded"),
  POLYGON_RPC_URL: z
    .url()
    .refine((value) => new URL(value).protocol === "https:")
    .default("https://polygon-rpc.com"),
  POLYGON_RPC_URLS: z.string().default("")
});

export interface AppConfig {
  profileAddress: string;
  databasePath: string;
  approvalHost: "127.0.0.1";
  approvalPort: number;
  liveEnabled: boolean;
  paperGateSkip: boolean;
  paperGateSkipSource: "dotenv" | "environment" | "default";
  keychainService: "codex-polymarket-guarded";
  clobHost: "https://clob.polymarket.com";
  gammaHost: "https://gamma-api.polymarket.com";
  dataHost: "https://data-api.polymarket.com";
  polygonRpcUrls: string[];
  chainId: 137;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const loaded = env === process.env ? loadDotEnv(env) : { env, paperGateSkipFromDotEnv: false };
  const parsed = envSchema.parse(loaded.env);
  const polygonRpcUrls = parsePolygonRpcUrls(
    parsed.POLYGON_RPC_URLS,
    parsed.POLYGON_RPC_URL
  );
  if (parsed.POLYMARKET_LIVE_ENABLED && polygonRpcUrls.length < 2) {
    throw new Error(
      "Live mode requires POLYGON_RPC_URLS with two independent HTTPS origins."
    );
  }
  return {
    profileAddress: parsed.POLYMARKET_PROFILE_ADDRESS,
    databasePath: path.resolve(parsed.POLYMARKET_DB_PATH),
    approvalHost: parsed.POLYMARKET_APPROVAL_HOST,
    approvalPort: parsed.POLYMARKET_APPROVAL_PORT,
    liveEnabled: parsed.POLYMARKET_LIVE_ENABLED,
    paperGateSkip: parsed.PAPER_GATE_SKIP,
    paperGateSkipSource: loaded.paperGateSkipFromDotEnv
      ? "dotenv"
      : env.PAPER_GATE_SKIP === undefined
        ? "default"
        : "environment",
    keychainService: parsed.POLYMARKET_KEYCHAIN_SERVICE,
    clobHost: "https://clob.polymarket.com",
    gammaHost: "https://gamma-api.polymarket.com",
    dataHost: "https://data-api.polymarket.com",
    polygonRpcUrls,
    chainId: 137
  };
}

function parsePolygonRpcUrls(value: string, fallback: string): string[] {
  const candidates =
    value.trim().length === 0
      ? [fallback]
      : value.split(",").map((candidate) => candidate.trim());
  const urls: string[] = [];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error(
        "Polygon RPC endpoints must be credential-free HTTPS origins without paths, queries, or fragments."
      );
    }
    const normalized = url.toString();
    if (origins.has(url.origin)) {
      throw new Error("Polygon RPC endpoints must use distinct origins.");
    }
    origins.add(url.origin);
    urls.push(normalized);
  }
  return urls;
}

function loadDotEnv(env: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  paperGateSkipFromDotEnv: boolean;
} {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) {
    return { env, paperGateSkipFromDotEnv: false };
  }
  const content = fs.readFileSync(envPath, "utf8");
  const merged = { ...env };
  let paperGateSkipFromDotEnv = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === "PAPER_GATE_SKIP") {
        merged[key] = value;
        paperGateSkipFromDotEnv = true;
        continue;
      }
      if (
        merged[key] === undefined ||
        merged[key] === "" ||
        merged[key] === "0x0000000000000000000000000000000000000000"
      ) {
        merged[key] = value;
      }
    }
  }
  return { env: merged, paperGateSkipFromDotEnv };
}
