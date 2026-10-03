/**
 * Packaging guard (WO-019 F1).
 *
 * The root package.json `files` list names channel modules one by one, so a
 * new module that a shipped file imports can be left out of the npm package
 * while every test (which runs from the git tree) stays green. Then every
 * installed bridge or router dies on startup with a missing import.
 *
 * This runs `npm pack --dry-run --json` and checks that every relative import
 * of every packed channel .ts file is itself packed.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const CHANNEL = import.meta.dir;
const ROOT = path.resolve(CHANNEL, "..");

/** Drop block comments and whole-line // comments (commented-out imports
 *  such as the Discord adapter placeholder are not real dependencies). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** Relative module specifiers imported by a source file (static and dynamic). */
function relativeImports(source: string): string[] {
  const specs = new Set<string>();
  const code = stripComments(source);
  for (const re of [
    /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\bimport\s+["'](\.{1,2}\/[^"']+)["']/g,
  ]) {
    for (const m of code.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

/** Resolve a specifier from `fromFile` (repo-relative) to a repo-relative path. */
function resolveSpec(fromFile: string, spec: string, exists: (p: string) => boolean): string {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (exists(candidate)) return candidate;
  }
  return path.extname(base) ? base : `${base}.ts`;
}

/** Imports of packed channel .ts files that are missing from the pack. */
function missingImports(
  packed: Set<string>,
  read: (p: string) => string,
  exists: (p: string) => boolean
): string[] {
  const missing: string[] = [];
  for (const file of packed) {
    if (!file.startsWith("channel/") || !file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const spec of relativeImports(read(file))) {
      const target = resolveSpec(file, spec, exists);
      if (!packed.has(target)) missing.push(`${file} imports ${spec} → ${target}`);
    }
  }
  return missing;
}

function packedFiles(): Set<string> {
  const proc = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`npm pack --dry-run failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  const report = JSON.parse(proc.stdout.toString()) as { files: { path: string }[] }[];
  return new Set(report[0].files.map((f) => f.path));
}

const readRepo = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");
const existsRepo = (p: string) => existsSync(path.join(ROOT, p));

describe("npm package contents", () => {
  test("the bridge and router entry points are packed", () => {
    const packed = packedFiles();
    for (const entry of ["channel/bridge.ts", "channel/router.ts", "channel/bridge-tools.ts"]) {
      expect([entry, packed.has(entry)]).toEqual([entry, true]);
    }
  });

  test("every relative import of a packed channel module is packed", () => {
    expect(missingImports(packedFiles(), readRepo, existsRepo)).toEqual([]);
  });

  test("control: an import of an unpacked module is reported missing", () => {
    const packed = new Set(["channel/entry.ts"]);
    const sources: Record<string, string> = {
      "channel/entry.ts":
        'import { x } from "./not-packed";\nconst y = await import("./also-missing");\nimport "./side-effect";\n// import { z } from "./commented-out";',
    };
    const missing = missingImports(packed, (p) => sources[p] ?? "", () => false);
    expect(missing).toEqual([
      "channel/entry.ts imports ./not-packed → channel/not-packed.ts",
      "channel/entry.ts imports ./also-missing → channel/also-missing.ts",
      "channel/entry.ts imports ./side-effect → channel/side-effect.ts",
    ]);
  });
});
