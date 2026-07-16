import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNodeTool } from "./check-generated-bindings.mjs";

assert.throws(
  () => runNodeTool(["-e", "process.exit(23)"], { stdio: "pipe" }),
  (error) => error?.status === 23
);

const scriptPath = fileURLToPath(new URL("./check-generated-bindings.mjs", import.meta.url));
const result = spawnSync(process.execPath, [scriptPath, "--self-test-failing-child"], {
  encoding: "utf8",
});
assert.equal(result.status, 1, result.stdout + result.stderr);
assert.match(result.stderr, /Command failed/);

console.log("generated bindings runner self-test passed");
