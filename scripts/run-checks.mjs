/**
 * Single source of truth for aggregate check stages.
 *
 * Usage:
 *   node scripts/run-checks.mjs <stage>
 *   node scripts/run-checks.mjs --list
 *
 * Adding a check: define its command in CHECKS, then add its id to the
 * stages that should run it. Hooks (.githooks/*) and package.json aggregate
 * scripts all resolve stages through this file, so there is exactly one
 * list to edit.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHECKS = {
  "format-check": "pnpm format:check",
  "repository-independence-self": "pnpm test:repository-independence-self",
  "repository-independence": "pnpm check:repository-independence",
  "repository-independence-staged": "pnpm check:repository-independence:staged",
  lint: "pnpm lint",
  typecheck: "pnpm typecheck",
  "no-instant-now-sub": "pnpm check:no-instant-now-sub",
  "spec-links": "pnpm check:spec-links",
  "support-matrix": "pnpm check:support-matrix",
  "gateway-error-codes": "pnpm check:gateway-error-codes",
  "plugin-system-docs": "pnpm check:plugin-system-docs",
  "plugin-api-contract": "pnpm check:plugin-api-contract",
  "egui-compat-contract": "pnpm check:egui-compat-contract",
  "egui-fixtures": "pnpm check:egui-fixtures",
  "headless-core-boundary-self": "pnpm test:headless-core-boundary-self",
  "headless-core-boundary": "pnpm check:headless-core-boundary",
  "egui-baseline-self": "pnpm test:egui-baseline-self",
  "plugin-sdk-typecheck": "pnpm --filter @aio-coding-hub/plugin-sdk typecheck",
  "plugin-sdk-test": "pnpm --filter @aio-coding-hub/plugin-sdk test",
  "create-aio-plugin-test": "pnpm --filter create-aio-plugin test",
  "unit-coverage-shards": "pnpm test:unit:coverage:shards",
  "generated-bindings-self": "node scripts/check-generated-bindings.selftest.mjs",
  "generated-bindings": "pnpm check:generated-bindings",
  "tauri-fmt": "pnpm tauri:fmt",
  "tauri-check": "pnpm tauri:check",
  "tauri-test": "pnpm tauri:test",
  "tauri-lib-test": "cd src-tauri && cargo test --lib",
  "tauri-clippy": "pnpm tauri:clippy",
};

const SOURCE_REPOSITORY = ["repository-independence-self", "repository-independence"];
const PRECOMMIT_REPOSITORY = ["repository-independence-self", "repository-independence-staged"];
const PRECOMMIT_SRC = ["lint", "typecheck", "no-instant-now-sub"];
const PRECOMMIT_TAURI = ["headless-core-boundary", "tauri-check"];
const PREPUSH_STATIC = [
  ...SOURCE_REPOSITORY,
  "lint",
  "typecheck",
  "support-matrix",
  "gateway-error-codes",
  "plugin-system-docs",
  "plugin-api-contract",
  "egui-compat-contract",
  "egui-fixtures",
  "headless-core-boundary-self",
  "headless-core-boundary",
  "egui-baseline-self",
  "generated-bindings-self",
  "plugin-sdk-typecheck",
  "tauri-fmt",
];

const STAGES = {
  // pre-commit hook picks the sub-stage based on which files are staged.
  "precommit-repository": PRECOMMIT_REPOSITORY,
  "precommit-src": PRECOMMIT_SRC,
  "precommit-tauri": PRECOMMIT_TAURI,
  precommit: [...PRECOMMIT_REPOSITORY, ...PRECOMMIT_SRC, ...PRECOMMIT_TAURI],
  "precommit-full": [
    "format-check",
    ...PRECOMMIT_REPOSITORY,
    ...PRECOMMIT_SRC,
    "spec-links",
    "support-matrix",
    "gateway-error-codes",
    "headless-core-boundary-self",
    "headless-core-boundary",
    "tauri-fmt",
    "tauri-check",
    "generated-bindings",
    "tauri-clippy",
  ],
  prepush: [
    ...PREPUSH_STATIC,
    "unit-coverage-shards",
    "plugin-sdk-test",
    "create-aio-plugin-test",
    "generated-bindings",
    "tauri-test",
    "tauri-clippy",
  ],
  "plugin-hardening": [
    "plugin-api-contract",
    "plugin-sdk-test",
    "plugin-sdk-typecheck",
    "tauri-lib-test",
  ],
};

function listStages() {
  for (const [stage, ids] of Object.entries(STAGES)) {
    console.log(`${stage}:`);
    for (const id of ids) {
      console.log(`  ${id}: ${CHECKS[id]}`);
    }
  }
}

function main() {
  const arg = process.argv[2];
  if (arg === "--list") {
    listStages();
    return;
  }

  const ids = STAGES[arg];
  if (!ids) {
    console.error(`[checks] unknown stage: ${arg ?? "<none>"}`);
    console.error(`[checks] available stages: ${Object.keys(STAGES).join(", ")}`);
    process.exit(1);
  }

  for (const [index, id] of ids.entries()) {
    const command = CHECKS[id];
    console.log(`[checks] (${index + 1}/${ids.length}) ${id}: ${command}`);
    const result = spawnSync(command, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
    });
    if (result.status !== 0) {
      console.error(`[checks] ${id} failed (exit ${result.status ?? "signal"})`);
      process.exit(result.status ?? 1);
    }
  }
  console.log(`[checks] stage "${arg}" passed (${ids.length} checks)`);
}

main();
