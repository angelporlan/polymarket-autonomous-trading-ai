import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Start the existing supervisor in an explicitly read-only shadow/paper
 * configuration. This entry point cannot enable live, create a live session,
 * clear an emergency lock, or adopt a portfolio.
 */
export function configureShadowEnvironment(env: NodeJS.ProcessEnv): void {
  env.POLYMARKET_LIVE_ENABLED = "false";
  env.POLYMARKET_DB_PATH =
    env.POLYMARKET_SHADOW_DB_PATH ?? "./data/shadow.sqlite";
}

export async function main(): Promise<void> {
  configureShadowEnvironment(process.env);

  const { runSupervisor } = await import("../supervisor/main.js");

  process.stderr.write("SHADOW_MODE_STARTED\n");
  await runSupervisor();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main();
}
