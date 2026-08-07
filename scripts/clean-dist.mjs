import { rm } from "node:fs/promises";
import path from "node:path";

const distPath = path.resolve(process.cwd(), "dist");
if (path.basename(distPath) !== "dist") {
  throw new Error("Refusing to clean an unexpected build path.");
}
await rm(distPath, { recursive: true, force: true });
