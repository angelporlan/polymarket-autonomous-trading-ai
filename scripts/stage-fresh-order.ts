/**
 * Deliberately disabled until autonomous session and exit controls exist.
 *
 * This file previously contained a hard-coded live order staging routine.
 * Keeping a script with that shape executable would create an un-budgeted
 * live order path, so it fails closed before constructing a runtime or staging any order.
 */
function main(): never {
  throw new Error(
    "STAGE_FRESH_ORDER_DISABLED: configure an authorized trading session and the autonomous position supervisor first."
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "STAGE_FRESH_ORDER_DISABLED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
