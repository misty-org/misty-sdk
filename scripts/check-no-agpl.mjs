// CI check: the SDK is MIT and must never pull in the AGPL host. It fails when a source file imports
// host code, or a path that leaves its own package, and when a package depends on a host package.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const forbidden = [/^@misty\/app(\/|$)/, /^@tauri-apps\//, /src-tauri/, /(^|\/)misty\/src(\/|$)/];
const importPattern =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
const problems = [];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

for (const pkg of readdirSync(packagesDir)) {
  const pkgRoot = join(packagesDir, pkg);
  if (!statSync(pkgRoot).isDirectory()) continue;
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  if (manifest.license !== "MIT") problems.push(`${pkg}: license must be MIT`);
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (forbidden.some((rule) => rule.test(name))) problems.push(`${pkg}: depends on ${name}`);
    }
  }
  for (const file of walk(join(pkgRoot, "src")).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const spec = match[1] ?? match[2] ?? match[3];
      const where = `${relative(root, file)} imports ${spec}`;
      if (forbidden.some((rule) => rule.test(spec))) problems.push(where);
      else if (spec.startsWith(".") && relative(pkgRoot, resolve(dirname(file), spec)).startsWith("..")) {
        problems.push(`${where} (leaves its package)`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`misty-sdk must not import AGPL host code:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("misty-sdk: no host imports.");
