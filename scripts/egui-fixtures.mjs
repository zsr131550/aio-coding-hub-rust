import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = dirname(scriptDir);
const FIXTURE_RELATIVE_ROOT = "src-tauri/tests/fixtures/egui-migration";
const FIXED_EPOCH_MS = 1_700_000_000_000;
const EXTERNAL_RUST_ARTIFACTS = [
  "data/sqlite-v25/aio-coding-hub.db",
  "data/sqlite-v25/schema.json",
  "data/sqlite-current/aio-coding-hub.db",
  "data/sqlite-current/schema.json",
  "settings/settings-current.json",
];
const JSON_STRING_FIELD_PATTERN = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
const SENSITIVE_VALUE_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|apiToken|authToken|bearerToken|sessionToken|(?:^|[_-])(?:token|secret|password|authorization|credential|cookie|private[_-]?key)(?:$|[_-]))/iu;
const FIXTURE_SAFETY_RULES = [
  {
    label: "absolute personal path",
    pattern:
      /(?:\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/"'\s\u0000]+|\/(?:Users|home)\/[^/"'\s\u0000]+(?:\/|\b)|\/root(?:\/|\b))/iu,
  },
  {
    label: "private key material",
    pattern:
      /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|untrusted comment:\s*(?:minisign|tauri) secret key)/iu,
  },
  {
    label: "authorization credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  },
  {
    label: "credential token prefix",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/u,
  },
  {
    label: "credential assignment",
    pattern:
      /(?:^|[\r\n])\s*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|PRIVATE_KEY|SECRET_KEY)\s*=\s*["']?[^\s"']{4,}/iu,
  },
];
const SENSITIVE_FIXTURE_PATH_PATTERN =
  /(?:^|\/)(?:id_rsa|id_ed25519|[^/]*(?:private|secret)[_-]?key[^/]*)$/iu;

function fail(message) {
  throw new Error(`[egui-fixtures] ${message}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => [key, canonicalize(value[key])])
  );
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function routeHop(providerId, providerName, status, ok, skipped = false) {
  return {
    provider_id: providerId,
    provider_name: providerName,
    ok,
    attempts: skipped ? 0 : 1,
    skipped,
    status,
    error_code: ok ? null : status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR",
    decision: skipped ? "skip" : ok ? "success" : "retry",
    reason: skipped ? "fixture-circuit-open" : null,
  };
}

function buildRequestLog(index) {
  const cliKeys = ["claude", "codex", "gemini"];
  const models = ["claude-sonnet-fixture", "gpt-fixture", "gemini-fixture"];
  const cliKey = cliKeys[index % cliKeys.length];
  const interrupted = index % 29 === 0;
  const rateLimited = !interrupted && index % 17 === 0;
  const hasFailover = !interrupted && index % 5 === 0;
  const status = interrupted ? null : rateLimited ? 429 : 200;
  const errorCode = interrupted ? null : rateLimited ? "RATE_LIMITED" : null;
  const startProviderId = (index % 4) + 1;
  const finalProviderId = hasFailover ? (startProviderId % 4) + 1 : startProviderId;
  const startProviderName = `Fixture Provider ${startProviderId}`;
  const finalProviderName = `Fixture Provider ${finalProviderId}`;
  const createdAtMs = FIXED_EPOCH_MS - index * 1_337;
  const inputTokens = 120 + (index % 700);
  const outputTokens = interrupted ? null : 40 + (index % 280);
  const route = hasFailover
    ? [
        routeHop(startProviderId, startProviderName, 503, false),
        routeHop(finalProviderId, finalProviderName, status, status === 200),
      ]
    : [routeHop(startProviderId, startProviderName, status, status === 200)];

  return {
    id: index + 1,
    trace_id: `fixture-trace-${String(index + 1).padStart(5, "0")}`,
    cli_key: cliKey,
    session_id: `fixture-session-${String(index % 12).padStart(2, "0")}`,
    method: "POST",
    path: index % 2 === 0 ? "/v1/messages" : "/v1/responses",
    excluded_from_stats: index % 97 === 0,
    special_settings_json: null,
    requested_model: models[index % models.length],
    status,
    error_code: errorCode,
    is_interrupted: interrupted,
    duration_ms: interrupted ? 0 : 180 + (index % 3_000),
    ttfb_ms: interrupted ? null : 45 + (index % 450),
    attempt_count: route.filter((hop) => !hop.skipped).length,
    has_failover: hasFailover,
    start_provider_id: startProviderId,
    start_provider_name: startProviderName,
    final_provider_id: interrupted ? 0 : finalProviderId,
    final_provider_name: interrupted ? "" : finalProviderName,
    final_provider_source_id: null,
    final_provider_source_name: null,
    route,
    session_reuse: index % 3 !== 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: outputTokens == null ? null : inputTokens + outputTokens,
    cache_read_input_tokens: index % 4 === 0 ? Math.floor(inputTokens / 2) : 0,
    cache_creation_input_tokens: index % 11 === 0 ? 32 : 0,
    cache_creation_5m_input_tokens: index % 11 === 0 ? 16 : 0,
    cache_creation_1h_input_tokens: index % 11 === 0 ? 16 : 0,
    effective_input_tokens: inputTokens,
    cost_usd: interrupted
      ? null
      : Number(((inputTokens + (outputTokens ?? 0)) / 1_000_000).toFixed(8)),
    provider_chain_json: JSON.stringify(route.map((hop) => hop.provider_id)),
    error_details_json: rateLimited ? JSON.stringify({ category: "fixture-rate-limit" }) : null,
    cost_multiplier: 1,
    created_at_ms: createdAtMs,
    last_activity_ms: interrupted ? createdAtMs + 500 : createdAtMs + 100,
    activity_details_json: interrupted ? JSON.stringify({ phase: "interrupted" }) : null,
    created_at: Math.floor(createdAtMs / 1_000),
  };
}

export function buildRequestLogFixture() {
  const rows = Array.from({ length: 10_000 }, (_, index) => buildRequestLog(index));
  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  return { rows, jsonl, sha256: sha256(jsonl) };
}

function representativePluginManifest() {
  return {
    id: "fixture.compatibility-panel",
    name: "Compatibility Panel Fixture",
    version: "1.0.0",
    apiVersion: "1.0.0",
    configVersion: 1,
    description: "Synthetic Plugin API v1 fixture without user data or credentials.",
    runtime: { kind: "extensionHost", language: "typescript" },
    main: "dist/extension.js",
    activationEvents: [
      "onStartup",
      "onCommand:fixture.inspect",
      "onGatewayHook:gateway.request.beforeSend",
    ],
    capabilities: ["commands.execute", "gateway.hooks", "storage.plugin"],
    contributes: {
      commands: [{ command: "fixture.inspect", title: "Inspect fixture" }],
      gatewayHooks: [
        {
          name: "gateway.request.beforeSend",
          priority: 10,
          failurePolicy: "fail-open",
          timeoutMs: 5000,
        },
      ],
      ui: {
        "settings.sections": [
          {
            id: "fixture.settings",
            title: "Fixture settings",
            schema: {
              type: "section",
              fields: [
                {
                  type: "boolean",
                  key: "enabled",
                  label: "Enabled",
                },
              ],
            },
          },
        ],
      },
    },
    hostCompatibility: {
      app: ">=0.60.0 <1.0.0",
      pluginApi: "^1.0.0",
      platforms: ["windows", "macos", "linux"],
    },
    configSchema: {
      type: "object",
      properties: { enabled: { type: "boolean", default: true } },
    },
  };
}

function pluginCorpus() {
  const valid = representativePluginManifest();
  const withoutMain = structuredClone(valid);
  delete withoutMain.main;
  const apiV2 = { ...structuredClone(valid), apiVersion: "2.0.0" };
  const unknownHook = structuredClone(valid);
  unknownHook.contributes.gatewayHooks[0].name = "gateway.fixture.unknown";
  const unknownSlot = structuredClone(valid);
  unknownSlot.contributes.ui = {
    "fixture.unknown.slot": unknownSlot.contributes.ui["settings.sections"],
  };
  const legacyRuntime = { ...structuredClone(valid), runtime: { kind: "wasm" } };
  return {
    cases: [
      { id: "valid-v1", path: "valid-v1.json", expectedStage: "valid", expectedCode: null },
      {
        id: "malformed-json",
        path: "malformed-json.json",
        expectedStage: "parse",
        expectedCode: "PLUGIN_INVALID_MANIFEST",
      },
      {
        id: "missing-main",
        path: "missing-main.json",
        expectedStage: "runtime",
        expectedCode: "PLUGIN_MISSING_MAIN",
      },
      {
        id: "api-v2",
        path: "api-v2.json",
        expectedStage: "compatibility",
        expectedCode: "PLUGIN_INCOMPATIBLE_API",
      },
      {
        id: "unknown-hook",
        path: "unknown-hook.json",
        expectedStage: "contributions",
        expectedCode: "PLUGIN_UNKNOWN_HOOK",
      },
      {
        id: "unknown-slot",
        path: "unknown-slot.json",
        expectedStage: "contributions",
        expectedCode: "PLUGIN_UNKNOWN_UI_SLOT",
      },
      {
        id: "legacy-wasm-runtime",
        path: "legacy-wasm-runtime.json",
        expectedStage: "parse",
        expectedCode: "PLUGIN_UNSUPPORTED_RUNTIME",
      },
    ],
    files: new Map([
      ["valid-v1.json", canonicalJson(valid)],
      ["malformed-json.json", '{"id":"fixture.malformed",\n'],
      ["missing-main.json", canonicalJson(withoutMain)],
      ["api-v2.json", canonicalJson(apiV2)],
      ["unknown-hook.json", canonicalJson(unknownHook)],
      ["unknown-slot.json", canonicalJson(unknownSlot)],
      ["legacy-wasm-runtime.json", canonicalJson(legacyRuntime)],
    ]),
  };
}

const REPRESENTATIVE_PLUGIN_CONTRIBUTION_HASH =
  "03ebd7a25255c34fe6f38d284bf9a6d818838c78841903885d61a19b6e6b7335";

function extensionHostTranscripts(plugin) {
  const handshakeParams = {
    pluginId: plugin.id,
    version: plugin.version,
    apiVersion: plugin.apiVersion,
    contributionHash: REPRESENTATIVE_PLUGIN_CONTRIBUTION_HASH,
  };
  const valid = [
    {
      direction: "worker-to-host",
      message: { jsonrpc: "2.0", method: "extension.ready", params: { workerVersion: 1 } },
    },
    {
      direction: "host-to-worker",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "extension.handshake",
        params: handshakeParams,
      },
    },
    {
      direction: "worker-to-host",
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          pluginId: plugin.id,
          version: plugin.version,
          apiVersion: plugin.apiVersion,
          workerVersion: 1,
        },
      },
    },
    {
      direction: "host-to-worker",
      message: { jsonrpc: "2.0", id: 2, method: "extension.activate", params: null },
    },
    {
      direction: "worker-to-host",
      message: { jsonrpc: "2.0", id: 2, result: { activated: true } },
    },
    {
      direction: "host-to-worker",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "commands.execute",
        params: { command: "fixture.inspect", args: { source: "fixture" } },
      },
    },
    {
      direction: "worker-to-host",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "host.call",
        params: { method: "storage.get", params: { key: "fixture" } },
      },
    },
    {
      direction: "host-to-worker",
      message: { jsonrpc: "2.0", id: 1, result: { value: null } },
    },
    {
      direction: "worker-to-host",
      message: { jsonrpc: "2.0", id: 3, result: { inspected: true } },
    },
    {
      direction: "host-to-worker",
      message: {
        jsonrpc: "2.0",
        id: 4,
        method: "gatewayHooks.execute",
        params: { hook: "gateway.request.beforeSend", context: { traceId: "fixture-trace" } },
      },
    },
    { direction: "worker-to-host", message: { jsonrpc: "2.0", id: 4, result: { action: "pass" } } },
    {
      direction: "host-to-worker",
      message: { jsonrpc: "2.0", id: 5, method: "extension.deactivate", params: null },
    },
    {
      direction: "worker-to-host",
      message: { jsonrpc: "2.0", id: 5, result: { deactivated: true } },
    },
  ];
  const invalid = [
    {
      direction: "host-to-worker",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "extension.handshake",
        params: { ...handshakeParams, pluginId: "fixture.invalid-handshake" },
      },
    },
    {
      direction: "worker-to-host",
      message: {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "extension host handshake metadata did not match manifest",
          data: { code: "PLUGIN_EXTENSION_HOST_HANDSHAKE_FAILED" },
        },
      },
    },
  ];
  const encode = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  return { valid: encode(valid), invalid: encode(invalid) };
}

const TEST_UPDATER_SIGNATURE =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRMFlhMml3K1YzOUwvOFppWFYyRnlac1hOazZnU2I1ZHF0Z0lnbHl2QTJPZ05tK3hVS2RLZkxuUmhCcUxUYnBxNGhxSlpNZ3pQUE05dTFkVE9CWDBiOC94eHR1K0R0YXc0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg0MTE1MzcwCWZpbGU6Zml4dHVyZS1hc3NldC5iaW4KMFA5SG1pNEgrSGo5c2oycTlPVUR2ZnZyNDVZdk9nZ2R5dVNpY284ZFE3bkpZS3draWxRejlmKzNKN3QwcnlRVWF6Wm5xMUVvMWt1VjE5Tm9LMFB4Q1E9PQo=";
const TEST_UPDATER_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY0NzdFNUMzQTJBRDYxMzQKUldRMFlhMml3K1YzOUNaL0pUY01mUUc2WHRhanVtVlVCdW11bFc4Ni8zT3JNYldocEZUdmxja3gK";

function updaterCorpus() {
  const platforms = Object.fromEntries(
    ["windows-x86_64", "darwin-x86_64", "darwin-aarch64", "linux-x86_64"].map((platform) => [
      platform,
      {
        signature: TEST_UPDATER_SIGNATURE,
        url: `https://fixture.invalid/releases/v0.60.13/aio-coding-hub-${platform}.bin`,
      },
    ])
  );
  const valid = {
    version: "0.60.13",
    notes: "Synthetic updater fixture; never install.",
    pub_date: "2026-07-15T00:00:00Z",
    platforms,
  };
  const missingPlatform = structuredClone(valid);
  delete missingPlatform.platforms["linux-x86_64"];
  const invalidSignature = structuredClone(valid);
  invalidSignature.platforms["windows-x86_64"].signature = "not-base64";
  return {
    valid,
    cases: [
      { id: "truncated", path: "truncated.json", expectedStage: "parse" },
      { id: "missing-platform", path: "missing-platform.json", expectedStage: "target-lookup" },
      { id: "invalid-signature", path: "invalid-signature.json", expectedStage: "signature" },
    ],
    files: new Map([
      ["truncated.json", '{"version":"0.60.13",\n'],
      ["missing-platform.json", canonicalJson(missingPlatform)],
      ["invalid-signature.json", canonicalJson(invalidSignature)],
    ]),
  };
}

export function buildTextFixtures() {
  const requestLogs = buildRequestLogFixture();
  const plugin = representativePluginManifest();
  const corpus = pluginCorpus();
  const transcripts = extensionHostTranscripts(plugin);
  const updater = updaterCorpus();
  const fixtures = new Map();

  fixtures.set(
    "README.md",
    `# egui migration fixtures\n\nVersioned synthetic inputs for compatibility and Tauri baseline checks. All mutable tests must copy these files into a runner-owned temporary home. The SQLite v25 database was generated from commit \`5e399f7c25c33a13f3e91d8a05a9973270d00728\` (blob \`6dce028754f13dec607e108b7a9e04da82e4d0f7\`) with its complete v0-to-v25 migration chain.\n\nRun \`pnpm check:egui-fixtures\` for byte/hash validation and a full-tree scan for credentials, private keys, and absolute personal paths. Regeneration is explicit and never reads or writes the real application data directory.\n`
  );
  fixtures.set(
    "data/fresh/fixture.json",
    canonicalJson({
      schemaVersion: 1,
      kind: "empty-home",
      expectedDatabaseState: "absent",
      instruction: "copy this directory into a runner-owned temporary home before startup",
    })
  );
  fixtures.set("request-logs/request-logs-10000.jsonl", requestLogs.jsonl);
  fixtures.set(
    "request-logs/metadata.json",
    canonicalJson({
      schemaVersion: 1,
      rowCount: requestLogs.rows.length,
      sha256: requestLogs.sha256,
      fixedEpochMs: FIXED_EPOCH_MS,
      uniqueSessionCount: new Set(requestLogs.rows.map((row) => row.session_id)).size,
      source: "scripts/egui-fixtures.mjs deterministic formula",
    })
  );
  fixtures.set("plugins/plugin-api-v1/representative/plugin.json", canonicalJson(plugin));
  fixtures.set(
    "plugins/plugin-api-v1/representative/config.json",
    canonicalJson({ enabled: true })
  );
  fixtures.set(
    "plugins/plugin-api-v1/representative/contributions.json",
    canonicalJson(plugin.contributes)
  );
  fixtures.set(
    "plugins/manifest-corpus/cases.json",
    canonicalJson({ schemaVersion: 1, cases: corpus.cases })
  );
  for (const [path, content] of corpus.files) {
    fixtures.set(`plugins/manifest-corpus/${path}`, content);
  }
  fixtures.set("plugins/transcripts/valid-lifecycle.jsonl", transcripts.valid);
  fixtures.set("plugins/transcripts/invalid-handshake.jsonl", transcripts.invalid);
  fixtures.set("updater/valid/latest.json", canonicalJson(updater.valid));
  fixtures.set(
    "updater/valid/fixture-asset.bin",
    "AIO Coding Hub updater compatibility fixture. Never install.\n"
  );
  fixtures.set("updater/valid/fixture-asset.bin.sig", `${TEST_UPDATER_SIGNATURE}\n`);
  fixtures.set("updater/valid/test-public-key.txt", `${TEST_UPDATER_PUBLIC_KEY}\n`);
  fixtures.set(
    "updater/invalid/cases.json",
    canonicalJson({ schemaVersion: 1, cases: updater.cases })
  );
  for (const [path, content] of updater.files) {
    fixtures.set(`updater/invalid/${path}`, content);
  }
  return fixtures;
}

function parseArgs(args) {
  let root = defaultRoot;
  let fixtureRoot;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--write") {
      write = true;
      continue;
    }
    if (token !== "--root" && token !== "--fixtures") fail(`unexpected argument: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${token}`);
    if (token === "--root") root = resolve(value);
    else fixtureRoot = resolve(value);
    index += 1;
  }
  return {
    root: resolve(root),
    fixtureRoot: fixtureRoot ?? resolve(root, FIXTURE_RELATIVE_ROOT),
    write,
  };
}

function ensureInside(root, candidate, label) {
  const canonicalRoot = canonicalizePath(root);
  const canonicalCandidate = canonicalizePath(candidate);
  const rel = relative(canonicalRoot, canonicalCandidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`${label} must be a child of the repository root: ${candidate}`);
  }
}

function canonicalizePath(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) fail(`cannot canonicalize path: ${path}`);
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), relative(ancestor, absolute));
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function fixtureArtifactPath(fixtureRoot, path, label = "fixture artifact") {
  const absolute = join(fixtureRoot, path);
  ensureInside(fixtureRoot, absolute, label);
  return absolute;
}

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`fixture tree must not contain symlinks: ${absolute}`);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
    else fail(`unsupported fixture artifact type: ${absolute}`);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function validateFixtureSafety(fixtureRoot) {
  for (const path of walkFiles(fixtureRoot)) {
    if (SENSITIVE_FIXTURE_PATH_PATTERN.test(path)) {
      fail(`sensitive fixture path is forbidden: ${path}`);
    }

    const text = readFileSync(join(fixtureRoot, path)).toString("utf8");
    validateStructuredSensitiveValues(path, text);
    for (const match of text.matchAll(JSON_STRING_FIELD_PATTERN)) {
      let key = match[1];
      let value = match[2];
      try {
        key = JSON.parse(`"${key}"`);
        value = JSON.parse(`"${value}"`);
      } catch {
        // Malformed corpus files still receive the conservative raw-value check.
      }
      if (SENSITIVE_VALUE_KEY_PATTERN.test(String(key)) && String(value).trim() !== "") {
        fail(`sensitive value is forbidden in fixture artifact: ${path}`);
      }
    }
    for (const rule of FIXTURE_SAFETY_RULES) {
      if (rule.pattern.test(text)) {
        fail(`${rule.label} is forbidden in fixture artifact: ${path}`);
      }
    }
  }
}

function valueIsEmpty(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function inspectStructuredSensitiveValues(path, value) {
  if (Array.isArray(value)) {
    for (const item of value) inspectStructuredSensitiveValues(path, item);
    return;
  }
  if (value == null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_VALUE_KEY_PATTERN.test(key) && !valueIsEmpty(nested)) {
      fail(`sensitive value is forbidden in fixture artifact: ${path}`);
    }
    inspectStructuredSensitiveValues(path, nested);
  }
}

function validateStructuredSensitiveValues(path, text) {
  const documents = path.endsWith(".jsonl") ? text.split(/\r?\n/u).filter(Boolean) : [text];
  if (!path.endsWith(".json") && !path.endsWith(".jsonl")) return;
  for (const document of documents) {
    try {
      inspectStructuredSensitiveValues(path, JSON.parse(document));
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
}

function sqliteMetadata(fixtureRoot, databasePath) {
  const schemaPath = databasePath.replace(/aio-coding-hub\.db$/, "schema.json");
  const schemaBytes = readFileSync(join(fixtureRoot, schemaPath));
  const database = new DatabaseSync(join(fixtureRoot, databasePath), { readOnly: true });
  try {
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();
    const rowCounts = {};
    for (const { name } of tables) {
      const identifier = String(name).replaceAll('"', '""');
      rowCounts[name] = database
        .prepare(`SELECT COUNT(*) AS count FROM "${identifier}"`)
        .get().count;
    }
    return {
      normalizedSchemaSha256: sha256(schemaBytes),
      rowCounts,
      schemaPath,
      userVersion,
    };
  } finally {
    database.close();
  }
}

function buildManifest(root, fixtureRoot) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const artifacts = {};
  for (const path of walkFiles(fixtureRoot).filter((path) => path !== "manifest.json")) {
    const bytes = readFileSync(join(fixtureRoot, path));
    artifacts[path] = {
      bytes: bytes.length,
      sha256: sha256(bytes),
      kind: path.endsWith(".db") ? "sqlite" : path.endsWith(".jsonl") ? "jsonl" : "file",
      ...(path.endsWith(".db") ? { sqlite: sqliteMetadata(fixtureRoot, path) } : {}),
    };
  }
  return canonicalJson({
    schemaVersion: 1,
    sourceVersion: packageJson.version,
    generatedBy: "scripts/egui-fixtures.mjs",
    fixedEpochMs: FIXED_EPOCH_MS,
    sqliteV25Provenance: {
      commit: "5e399f7c25c33a13f3e91d8a05a9973270d00728",
      sourcePath: "src-tauri/src/infra/db.rs",
      sourceBlob: "6dce028754f13dec607e108b7a9e04da82e4d0f7",
      sourceSchemaVersion: 25,
      migrationClockEpochSeconds: FIXED_EPOCH_MS / 1_000,
    },
    artifacts,
  });
}

function validateExternalArtifacts(fixtureRoot) {
  for (const path of EXTERNAL_RUST_ARTIFACTS) {
    const absolute = fixtureArtifactPath(
      fixtureRoot,
      path,
      `Rust-generated fixture artifact ${path}`
    );
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      fail(`missing Rust-generated fixture artifact: ${path}`);
    }
  }
  for (const path of EXTERNAL_RUST_ARTIFACTS.filter((path) => path.endsWith(".db"))) {
    const header = readFileSync(join(fixtureRoot, path)).subarray(0, 16).toString("ascii");
    if (header !== "SQLite format 3\u0000") fail(`invalid SQLite header: ${path}`);
  }
}

function expectedArtifactPaths(fixtures) {
  return [...fixtures.keys(), ...EXTERNAL_RUST_ARTIFACTS, "manifest.json"].sort((left, right) =>
    left.localeCompare(right, "en")
  );
}

function validateArtifactSet(fixtureRoot, fixtures) {
  const actual = walkFiles(fixtureRoot);
  const expected = expectedArtifactPaths(fixtures);
  const unexpected = actual.filter((path) => !expected.includes(path));
  const missing = expected.filter((path) => !actual.includes(path));
  if (unexpected.length > 0) fail(`unexpected fixture artifact: ${unexpected[0]}`);
  if (missing.length > 0) fail(`missing fixture artifact: ${missing[0]}`);
}

function validateGeneratedArtifacts(fixtureRoot, fixtures) {
  for (const [path, expected] of fixtures) {
    const absolute = fixtureArtifactPath(fixtureRoot, path, `generated fixture ${path}`);
    if (!existsSync(absolute)) fail(`missing generated fixture: ${path}`);
    const actual = readFileSync(absolute);
    const expectedBytes = Buffer.from(expected);
    if (!actual.equals(expectedBytes)) fail(`generated fixture drift detected: ${path}`);
  }
}

function validateCompleteFixtureTree(root, fixtureRoot, fixtures) {
  validateFixtureSafety(fixtureRoot);
  validateGeneratedArtifacts(fixtureRoot, fixtures);
  validateExternalArtifacts(fixtureRoot);
  validateArtifactSet(fixtureRoot, fixtures);
  const manifest = buildManifest(root, fixtureRoot);
  const manifestPath = fixtureArtifactPath(fixtureRoot, "manifest.json", "fixture manifest");
  if (readFileSync(manifestPath, "utf8") !== manifest) {
    fail("fixture manifest drift detected; review sources and run with --write");
  }
}

function preflightTargetTree(root, fixtureRoot, fixtures) {
  ensureInside(root, fixtureRoot, "fixture root");
  if (!existsSync(fixtureRoot) || !statSync(fixtureRoot).isDirectory()) {
    fail(`fixture root must be an existing directory: ${fixtureRoot}`);
  }
  walkFiles(fixtureRoot);
  for (const path of expectedArtifactPaths(fixtures)) {
    fixtureArtifactPath(fixtureRoot, path, `fixture target ${path}`);
  }
}

function copyExternalArtifacts(sourceRoot, stagingRoot) {
  for (const path of EXTERNAL_RUST_ARTIFACTS) {
    const source = fixtureArtifactPath(sourceRoot, path, `Rust-generated fixture source ${path}`);
    const destination = fixtureArtifactPath(
      stagingRoot,
      path,
      `staged Rust-generated fixture artifact ${path}`
    );
    mkdirSync(dirname(destination), { recursive: true });
    fixtureArtifactPath(stagingRoot, path, `staged Rust-generated fixture artifact ${path}`);
    copyFileSync(source, destination);
  }
}

function writeGeneratedArtifacts(stagingRoot, fixtures) {
  for (const [path, content] of fixtures) {
    const destination = fixtureArtifactPath(stagingRoot, path, `staged generated fixture ${path}`);
    mkdirSync(dirname(destination), { recursive: true });
    fixtureArtifactPath(stagingRoot, path, `staged generated fixture ${path}`);
    atomicWrite(destination, content);
  }
}

function publishStagedTree(fixtureRoot, stagingRoot) {
  const backupRoot = `${stagingRoot}.previous`;
  renameSync(fixtureRoot, backupRoot);
  try {
    renameSync(stagingRoot, fixtureRoot);
  } catch (error) {
    try {
      renameSync(backupRoot, fixtureRoot);
    } catch (rollbackError) {
      fail(
        `failed to publish fixture tree and restore the previous tree: ${error}; rollback: ${rollbackError}`
      );
    }
    throw error;
  }
  rmSync(backupRoot, { recursive: true, force: true });
}

function writeFixtureTree(root, fixtureRoot, fixtures) {
  preflightTargetTree(root, fixtureRoot, fixtures);
  validateExternalArtifacts(fixtureRoot);

  const stagingRoot = mkdtempSync(join(dirname(fixtureRoot), `.${basename(fixtureRoot)}-staging-`));
  ensureInside(root, stagingRoot, "fixture staging root");
  try {
    copyExternalArtifacts(fixtureRoot, stagingRoot);
    writeGeneratedArtifacts(stagingRoot, fixtures);
    validateExternalArtifacts(stagingRoot);
    const manifest = buildManifest(root, stagingRoot);
    atomicWrite(
      fixtureArtifactPath(stagingRoot, "manifest.json", "staged fixture manifest"),
      manifest
    );
    validateCompleteFixtureTree(root, stagingRoot, fixtures);
    publishStagedTree(fixtureRoot, stagingRoot);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function main() {
  const { root, fixtureRoot, write } = parseArgs(process.argv.slice(2));
  const fixtures = buildTextFixtures();

  if (write) {
    writeFixtureTree(root, fixtureRoot, fixtures);
  } else {
    preflightTargetTree(root, fixtureRoot, fixtures);
    validateCompleteFixtureTree(root, fixtureRoot, fixtures);
  }
  console.error(`[egui-fixtures] ${write ? "wrote" : "checked"} ${fixtureRoot}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
