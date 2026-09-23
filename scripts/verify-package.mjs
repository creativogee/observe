// Proves the published entry points actually load, both ways.
//
// `npm test` imports TypeScript source through Vitest, so it cannot catch a
// broken `exports` map, a missing `dist/cjs/package.json` type marker, or an
// ESM-only construct that survived into the CommonJS build. Most NestJS
// service is `"type": "commonjs"`, so a broken `require` path would fail at
// every consumer's first boot and nowhere earlier.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const packageRoot = process.cwd();
const scratch = join(tmpdir(), `observe-package-check-${process.pid}`);

const cases = [
  {
    name: "CommonJS consumer",
    type: "commonjs",
    // `.cjs` so Node parses this as CommonJS and exercises the `require`
    // condition of the exports map, which is the path every service takes.
    entry: "entry.cjs",
    source: `
      const observe = require("@crudmates/observe");
      const missing = ["createObserveModule", "ObserveMetrics", "shutdownObserve"]
        .filter((key) => typeof observe[key] !== "function");
      if (missing.length > 0) throw new Error("missing exports: " + missing.join(", "));
      observe.createObserveModule();
    `,
  },
  {
    name: "ESM consumer",
    type: "module",
    entry: "entry.mjs",
    source: `
      const observe = await import("@crudmates/observe");
      const missing = ["createObserveModule", "ObserveMetrics", "shutdownObserve"]
        .filter((key) => typeof observe[key] !== "function");
      if (missing.length > 0) throw new Error("missing exports: " + missing.join(", "));
      observe.createObserveModule();
    `,
  },
];

let failed = false;
try {
  for (const testCase of cases) {
    const dir = join(scratch, testCase.type);
    mkdirSync(join(dir, "node_modules", "@crudmates"), { recursive: true });
    symlinkSync(packageRoot, join(dir, "node_modules", "@crudmates", "observe"), "dir");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", type: testCase.type }),
    );
    const entry = join(dir, testCase.entry);
    writeFileSync(entry, testCase.source);

    try {
      execFileSync(process.execPath, [entry], { cwd: dir, stdio: "pipe" });
      console.log(`ok   ${testCase.name}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${testCase.name}`);
      console.error(String(error.stderr ?? error.message));
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
