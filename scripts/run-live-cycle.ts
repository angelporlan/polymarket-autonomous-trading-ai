/**
 * Deliberately disabled until autonomous session and exit controls exist.
 *
 * This file previously contained a hard-coded live order. Keeping a command
 * with that shape runnable would make a demo path indistinguishable from an
 * autonomous trading path, so it fails closed before constructing a runtime.
 */
function main(): never {
  throw new Error(
    "LIVE_CYCLE_DISABLED: configure an authorized trading session and the autonomous position supervisor first."
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "LIVE_CYCLE_DISABLED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
