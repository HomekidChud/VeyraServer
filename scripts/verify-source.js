const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const skipped = new Set([".git", "node_modules", "android"]);
const files = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(file);
  }
}
visit(root);
let failed = false;
for (const file of files) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    failed = true;
    process.stderr.write(check.stderr || check.stdout || `Syntax check failed: ${file}\n`);
  }
}
if (failed) process.exit(1);
process.stdout.write(`Validated ${files.length} JavaScript source files.\n`);
