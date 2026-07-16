import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = dirname(scriptDir);
const bindingsPath = join(repoRoot, "src", "generated", "bindings.ts");
const bindingsPrettierPath = "src/generated/bindings.ts";
const genTypesScriptPath = join(scriptDir, "tauri-gen-types.mjs");
const prettierCliPath = join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs");
const EXPECTED_HOME_USAGE_PERIOD_LITERALS = ["last7", "last15", "last30", "month"];

function parseHomeUsagePeriodLiterals(source) {
  const match = source.match(/export type HomeUsagePeriod = ([^;]+);/);
  if (!match) {
    throw new Error("Missing HomeUsagePeriod export in generated bindings.");
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (part) => part[1]);
}

function assertHomeUsagePeriodContract(source) {
  const actual = parseHomeUsagePeriodLiterals(source);
  if (JSON.stringify(actual) === JSON.stringify(EXPECTED_HOME_USAGE_PERIOD_LITERALS)) return;

  throw new Error(
    `HomeUsagePeriod contract drifted. Expected ${EXPECTED_HOME_USAGE_PERIOD_LITERALS.join(
      ", "
    )}; received ${actual.join(", ")}.`
  );
}
export function runNodeTool(args, options = {}) {
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
}

export function checkGeneratedBindings() {
  const before = existsSync(bindingsPath) ? readFileSync(bindingsPath, "utf8") : null;

  runNodeTool([genTypesScriptPath]);

  // Format the freshly generated file so comparison uses the committed style.
  runNodeTool([prettierCliPath, "--write", bindingsPrettierPath]);

  const after = existsSync(bindingsPath) ? readFileSync(bindingsPath, "utf8") : null;
  if (after == null) {
    throw new Error("Generated bindings file is missing: src/generated/bindings.ts");
  }

  assertHomeUsagePeriodContract(after);

  if (before !== after) {
    throw new Error(
      "Generated bindings were outdated. Review and commit src/generated/bindings.ts."
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    if (process.argv[2] === "--self-test-failing-child") {
      runNodeTool(["-e", "process.exit(23)"], { stdio: "pipe" });
    } else {
      checkGeneratedBindings();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
