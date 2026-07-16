import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { buildRequestLogFixture, buildTextFixtures, canonicalJson } from "./egui-fixtures.mjs";

function runFixtures(args) {
  return spawnSync("node", ["scripts/egui-fixtures.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function snapshotTree(root, current = root, snapshot = {}) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) snapshotTree(root, absolute, snapshot);
    else if (entry.isFile()) {
      const bytes = readFileSync(absolute);
      snapshot[path] = `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
    } else snapshot[path] = `<${entry.isSymbolicLink() ? "link" : "special"}>`;
  }
  return snapshot;
}

const first = buildRequestLogFixture();
const second = buildRequestLogFixture();
assert.equal(first.rows.length, 10_000);
assert.equal(second.rows.length, 10_000);
assert.equal(first.jsonl, second.jsonl);
assert.equal(createHash("sha256").update(first.jsonl).digest("hex"), first.sha256);
assert.ok(new Set(first.rows.map((row) => row.session_id)).size <= 12);
assert.ok(first.rows.some((row) => row.has_failover));
assert.ok(first.rows.some((row) => row.is_interrupted));
assert.ok(first.rows.some((row) => row.status === 200));
assert.ok(first.rows.some((row) => row.status === 429));
assert.doesNotMatch(first.jsonl, /api[_-]?key|bearer\s|password|sk-[a-z0-9]/i);

const fixtures = buildTextFixtures();
assert.equal(fixtures.get("request-logs/request-logs-10000.jsonl"), first.jsonl);
assert.ok(fixtures.has("plugins/manifest-corpus/cases.json"));
assert.ok(fixtures.has("plugins/transcripts/valid-lifecycle.jsonl"));
assert.ok(fixtures.has("updater/valid/latest.json"));
assert.ok(fixtures.has("updater/invalid/cases.json"));

const parseJsonlFixture = (path) =>
  fixtures
    .get(path)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const representativeManifest = JSON.parse(
  fixtures.get("plugins/plugin-api-v1/representative/plugin.json")
);
const validTranscript = parseJsonlFixture("plugins/transcripts/valid-lifecycle.jsonl");
const validHandshake = validTranscript[1].message;
assert.equal(validHandshake.params.pluginId, representativeManifest.id);
assert.equal(validHandshake.params.version, representativeManifest.version);
assert.equal(validHandshake.params.apiVersion, representativeManifest.apiVersion);
assert.match(validHandshake.params.contributionHash, /^[0-9a-f]{64}$/);
assert.deepEqual(validTranscript[2].message.result, {
  pluginId: representativeManifest.id,
  version: representativeManifest.version,
  apiVersion: representativeManifest.apiVersion,
  workerVersion: 1,
});
assert.equal(validTranscript[3].message.params, null);
assert.equal(validTranscript[6].message.id, 1);
assert.equal(validTranscript[7].message.id, 1);
assert.equal(validTranscript[11].message.params, null);

const invalidTranscript = parseJsonlFixture("plugins/transcripts/invalid-handshake.jsonl");
const invalidHandshake = invalidTranscript[0].message;
assert.notEqual(invalidHandshake.params.pluginId, validHandshake.params.pluginId);
assert.deepEqual(
  { ...invalidHandshake.params, pluginId: validHandshake.params.pluginId },
  validHandshake.params
);
assert.equal(
  invalidTranscript[1].message.error.data.code,
  "PLUGIN_EXTENSION_HOST_HANDSHAKE_FAILED"
);

const committedManifest = JSON.parse(
  readFileSync("src-tauri/tests/fixtures/egui-migration/manifest.json", "utf8")
);
const committedSettings = JSON.parse(
  readFileSync("src-tauri/tests/fixtures/egui-migration/settings/settings-current.json", "utf8")
);
assert.equal(
  committedSettings.enable_notification_sound,
  false,
  "current settings fixture must retain its safe representative non-default value"
);
for (const [databasePath, expectedVersion] of [
  ["data/sqlite-v25/aio-coding-hub.db", 25],
  ["data/sqlite-current/aio-coding-hub.db", 35],
]) {
  const sqlite = committedManifest.artifacts[databasePath]?.sqlite;
  assert.equal(sqlite?.userVersion, expectedVersion);
  assert.match(sqlite?.normalizedSchemaSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(sqlite?.rowCounts ?? {}).length > 0);
  const schemaPath = databasePath.replace("aio-coding-hub.db", "schema.json");
  assert.equal(sqlite?.normalizedSchemaSha256, committedManifest.artifacts[schemaPath]?.sha256);
}

const canonical = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
assert.equal(canonical, '{\n  "a": {\n    "x": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');

const tempRoot = mkdtempSync(join(tmpdir(), "aio-egui-fixtures-root-"));
const outsideRoot = mkdtempSync(join(tmpdir(), "aio-egui-fixtures-outside-"));
try {
  writeFileSync(join(tempRoot, "package.json"), '{"version":"0.60.13"}\n', "utf8");
  const normalFixtureRoot = join(tempRoot, "fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", normalFixtureRoot, { recursive: true });
  const normal = runFixtures(["--root", tempRoot, "--fixtures", normalFixtureRoot, "--write"]);
  assert.equal(
    normal.status,
    0,
    `temporary fixture root write failed:\n${normal.stderr || normal.stdout}`
  );

  const escapedFixtureRoot = join(tempRoot, "escaped-fixtures");
  symlinkSync(outsideRoot, escapedFixtureRoot, process.platform === "win32" ? "junction" : "dir");
  const outsideEntriesBefore = readdirSync(outsideRoot).sort();
  const escaped = runFixtures(["--root", tempRoot, "--fixtures", escapedFixtureRoot, "--write"]);
  assert.deepEqual(
    readdirSync(outsideRoot).sort(),
    outsideEntriesBefore,
    "fixture write escaped through a symlink or junction"
  );
  assert.notEqual(escaped.status, 0, "fixture write accepted an escaped fixture root");
  assert.match(escaped.stderr, /fixture root must be a child of the repository root/);

  const nestedJunctionFixtureRoot = join(tempRoot, "nested-junction-fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", nestedJunctionFixtureRoot, {
    recursive: true,
  });
  rmSync(join(nestedJunctionFixtureRoot, "plugins"), { recursive: true, force: true });
  symlinkSync(
    outsideRoot,
    join(nestedJunctionFixtureRoot, "plugins"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const outsideBeforeNestedJunctionWrite = snapshotTree(outsideRoot);
  const nestedJunction = runFixtures([
    "--root",
    tempRoot,
    "--fixtures",
    nestedJunctionFixtureRoot,
    "--write",
  ]);
  assert.notEqual(nestedJunction.status, 0, "fixture write accepted an escaped child path");
  assert.deepEqual(
    snapshotTree(outsideRoot),
    outsideBeforeNestedJunctionWrite,
    "fixture write modified files through an internal symlink or junction"
  );

  const lateFailureFixtureRoot = join(tempRoot, "late-failure-fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", lateFailureFixtureRoot, { recursive: true });
  writeFileSync(join(lateFailureFixtureRoot, "README.md"), "preexisting drift\n", "utf8");
  rmSync(join(lateFailureFixtureRoot, "settings/settings-current.json"));
  const lateFailureBefore = snapshotTree(lateFailureFixtureRoot);
  const lateFailure = runFixtures([
    "--root",
    tempRoot,
    "--fixtures",
    lateFailureFixtureRoot,
    "--write",
  ]);
  assert.notEqual(lateFailure.status, 0, "fixture write ignored a missing Rust artifact");
  assert.match(lateFailure.stderr, /missing Rust-generated fixture artifact/);
  assert.deepEqual(
    snapshotTree(lateFailureFixtureRoot),
    lateFailureBefore,
    "late fixture validation failure left a partially updated target tree"
  );

  const staleFixtureRoot = join(tempRoot, "stale-fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", staleFixtureRoot, { recursive: true });
  const staleRelativePath = "plugins/removed-generator-case.json";
  writeFileSync(join(staleFixtureRoot, staleRelativePath), '{"stale":true}\n', "utf8");
  const staleWrite = runFixtures(["--root", tempRoot, "--fixtures", staleFixtureRoot, "--write"]);
  assert.equal(staleWrite.status, 0, `stale cleanup write failed:\n${staleWrite.stderr}`);
  assert.equal(
    existsSync(join(staleFixtureRoot, staleRelativePath)),
    false,
    "fixture write retained a file no longer produced by the generator"
  );
  const staleManifest = JSON.parse(readFileSync(join(staleFixtureRoot, "manifest.json"), "utf8"));
  assert.equal(
    Object.hasOwn(staleManifest.artifacts, staleRelativePath),
    false,
    "fixture write incorporated a stale target file into the manifest"
  );

  const sensitiveFixtureRoot = join(tempRoot, "sensitive-fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", sensitiveFixtureRoot, { recursive: true });
  writeFileSync(
    join(sensitiveFixtureRoot, "plugins/plugin-api-v1/representative/config.json"),
    '{"enabled":true,"apiKey":"sk-live-should-never-be-committed"}\n',
    "utf8"
  );
  const sensitive = runFixtures(["--root", tempRoot, "--fixtures", sensitiveFixtureRoot]);
  assert.notEqual(sensitive.status, 0, "fixture check accepted a credential outside manifest.json");
  assert.match(
    sensitive.stderr,
    /sensitive value.*plugins\/plugin-api-v1\/representative\/config\.json/i
  );

  const personalPathFixtureRoot = join(tempRoot, "personal-path-fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", personalPathFixtureRoot, { recursive: true });
  writeFileSync(
    join(personalPathFixtureRoot, "plugins/transcripts/invalid-handshake.jsonl"),
    '{"path":"C:\\\\Users\\\\FixtureOwner\\\\.aio-coding-hub"}\n',
    "utf8"
  );
  const personalPath = runFixtures(["--root", tempRoot, "--fixtures", personalPathFixtureRoot]);
  assert.notEqual(personalPath.status, 0, "fixture check accepted an absolute personal path");
  assert.match(
    personalPath.stderr,
    /absolute personal path.*plugins\/transcripts\/invalid-handshake\.jsonl/i
  );

  const sensitiveWriteFixtureRoot = join(tempRoot, "sensitive-write-fixtures");
  cpSync("src-tauri/tests/fixtures/egui-migration", sensitiveWriteFixtureRoot, {
    recursive: true,
  });
  const sensitiveSettingsPath = join(sensitiveWriteFixtureRoot, "settings/settings-current.json");
  const sensitiveSettings = JSON.parse(readFileSync(sensitiveSettingsPath, "utf8"));
  sensitiveSettings.upstream_proxy_password = "fixture-password-must-still-be-rejected";
  writeFileSync(sensitiveSettingsPath, canonicalJson(sensitiveSettings), "utf8");
  const sensitiveWriteBefore = snapshotTree(sensitiveWriteFixtureRoot);
  const sensitiveWrite = runFixtures([
    "--root",
    tempRoot,
    "--fixtures",
    sensitiveWriteFixtureRoot,
    "--write",
  ]);
  assert.notEqual(sensitiveWrite.status, 0, "fixture write published a sensitive Rust artifact");
  assert.match(sensitiveWrite.stderr, /sensitive value.*settings\/settings-current\.json/i);
  assert.deepEqual(
    snapshotTree(sensitiveWriteFixtureRoot),
    sensitiveWriteBefore,
    "failed sensitive fixture write modified the published target tree"
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}

console.log("egui fixture generator self-test passed");
