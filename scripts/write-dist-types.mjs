// Marks each build output with its module system.
//
// The root package.json says "type": "module", which every .js under dist/
// inherits - including the CommonJS build, where it would make Node parse
// `require(...)` output as ESM and throw ERR_REQUIRE_ESM. The nearest
// package.json wins, so each output directory declares its own.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outputs = [
  ["dist/esm", "module"],
  ["dist/cjs", "commonjs"],
];

for (const [dir, type] of outputs) {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`);
}
