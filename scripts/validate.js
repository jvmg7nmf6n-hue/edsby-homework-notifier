import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const files = await readdir(root, { recursive: true, withFileTypes: true });
const javascript = files
  .filter((entry) => entry.isFile() && extname(entry.name) === ".js" && !entry.parentPath.includes("node_modules"))
  .map((entry) => join(entry.parentPath, entry.name));

for (const file of javascript) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}

for (const legacy of ["data/history.json", "data/notified.json"]) {
  try {
    await readFile(join(root, legacy));
    throw new Error(`Legacy plaintext state must not exist: ${legacy}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

console.log(`Validated ${javascript.length} JavaScript files and privacy invariants.`);
