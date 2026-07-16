import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = dirname(scriptDir);
const EXPECTED_GENERATED_COMMANDS = 195;
const EXPECTED_RUNTIME_ONLY_COMMAND = "desktop_updater_download_and_install";
const EXPECTED_RISKY_OPERATIONS = 6;
const EXPECTED_CONFIRM_ERROR_CODES = 7;
const EXPECTED_OFFICIAL_TARGETS = 4;

function fail(message) {
  throw new Error(`[egui-compat-contract] ${message}`);
}

function parseArgs(rawArgs) {
  const args = new Map();
  const flags = new Set();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--write") {
      flags.add(token);
      continue;
    }
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const value = rawArgs[index + 1];
    if (value == null || value.startsWith("--")) fail(`missing value for ${token}`);
    args.set(token, value);
    index += 1;
  }
  return { args, flags };
}

function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`failed to read ${label} JSON at ${path}: ${error}`);
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function resolveInside(root, path, label) {
  const absolute = resolve(root, path);
  const canonicalRoot = canonicalizePath(root);
  const canonicalAbsolute = canonicalizePath(absolute);
  const rel = relative(canonicalRoot, canonicalAbsolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return absolute;
  }
  fail(`${label} escapes contract root: ${path}`);
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

function normalizeRelativePath(root, path, label) {
  const absolute = resolveInside(root, path, label);
  return relative(root, absolute).split(sep).join("/");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function runJsonCommand(command, commandArgs, options, label) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status ?? "signal"}):\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`${label} did not emit JSON: ${error}`);
  }
}

function loadRustContract(root, explicitPath) {
  if (explicitPath) return readJson(resolve(explicitPath), "Rust compatibility contract");

  const tempRoot = mkdtempSync(join(tmpdir(), "aio-egui-rust-contract-"));
  const outputPath = join(tempRoot, "rust-contract.json");
  try {
    const result = spawnSync(
      "cargo",
      [
        "run",
        "--quiet",
        "--locked",
        "--manifest-path",
        join(root, "src-tauri", "Cargo.toml"),
        "--example",
        "export_compatibility_contract",
        "--",
        outputPath,
      ],
      { cwd: root, encoding: "utf8" }
    );
    if (result.status !== 0) {
      fail(`Rust compatibility exporter failed:\n${result.stderr || result.stdout}`);
    }
    return readJson(outputPath, "Rust compatibility contract");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function loadSupportMatrix(root, explicitPath) {
  if (explicitPath) return readJson(resolve(explicitPath), "support matrix contract");
  return runJsonCommand(
    process.execPath,
    [join(root, "scripts", "support-matrix.mjs"), "contract"],
    { cwd: root },
    "support matrix contract export"
  );
}

function validateRustContract(contract) {
  if (contract.schemaVersion !== 1) fail("Rust contract schemaVersion must be 1");
  const ipc = contract.ipc;
  if (ipc == null || typeof ipc !== "object") fail("Rust contract ipc section is missing");

  const generated = requireArray(ipc.generatedCommands, "ipc.generatedCommands");
  if (generated.length !== EXPECTED_GENERATED_COMMANDS) {
    fail(
      `expected ${EXPECTED_GENERATED_COMMANDS} generated commands, received ${generated.length}`
    );
  }
  generated.forEach((name, index) => requireString(name, `ipc.generatedCommands[${index}]`));
  assertUnique(generated, "ipc.generatedCommands");

  const runtimeOnly = requireArray(ipc.runtimeOnlyCommands, "ipc.runtimeOnlyCommands");
  if (
    runtimeOnly.length !== 1 ||
    runtimeOnly[0]?.name !== EXPECTED_RUNTIME_ONLY_COMMAND ||
    typeof runtimeOnly[0]?.reason !== "string"
  ) {
    fail(`runtime-only command must be the single ${EXPECTED_RUNTIME_ONLY_COMMAND} exception`);
  }
  if (ipc.runtimeCommandCount !== generated.length + runtimeOnly.length) {
    fail("ipc.runtimeCommandCount does not match generated + runtime-only commands");
  }

  const risky = requireArray(ipc.riskyOperations, "ipc.riskyOperations");
  if (risky.length !== EXPECTED_RISKY_OPERATIONS) {
    fail(`expected ${EXPECTED_RISKY_OPERATIONS} risky operations, received ${risky.length}`);
  }
  for (const [index, operation] of risky.entries()) {
    requireString(operation?.command, `ipc.riskyOperations[${index}].command`);
    requireString(operation?.action, `ipc.riskyOperations[${index}].action`);
    requireString(operation?.resourceTemplate, `ipc.riskyOperations[${index}].resourceTemplate`);
    if (
      !generated.includes(operation.command) &&
      operation.command !== EXPECTED_RUNTIME_ONLY_COMMAND
    ) {
      fail(`risky operation references an unknown command: ${operation.command}`);
    }
  }
  assertUnique(
    risky.map((item) => item.command),
    "ipc.riskyOperations command names"
  );

  const confirmErrors = requireArray(ipc.confirmErrorCodes, "ipc.confirmErrorCodes");
  if (confirmErrors.length !== EXPECTED_CONFIRM_ERROR_CODES) {
    fail(
      `expected ${EXPECTED_CONFIRM_ERROR_CODES} confirmation errors, received ${confirmErrors.length}`
    );
  }
  confirmErrors.forEach((code, index) => requireString(code, `ipc.confirmErrorCodes[${index}]`));
  assertUnique(confirmErrors, "ipc.confirmErrorCodes");

  const events = requireArray(contract.events, "events");
  for (const [index, event] of events.entries()) {
    requireString(event?.id, `events[${index}].id`);
    requireString(event?.name, `events[${index}].name`);
    requireString(event?.payloadType, `events[${index}].payloadType`);
    requireString(event?.fixturePath, `events[${index}].fixturePath`);
    requireString(event?.delivery, `events[${index}].delivery`);
  }
  assertUnique(
    events.map((event) => event.name),
    "event names"
  );

  const artifactPaths = requireArray(contract.artifactPaths, "artifactPaths");
  artifactPaths.forEach((path, index) => requireString(path, `artifactPaths[${index}]`));
  assertUnique(artifactPaths, "artifactPaths");
}

function validateRoutes(contract) {
  if (contract.schemaVersion !== 1) fail("route contract schemaVersion must be 1");
  const routes = requireArray(contract.routes, "routes");
  if (routes.filter((route) => route.kind === "index").length !== 1) {
    fail("route contract must contain exactly one index route");
  }
  if (routes.filter((route) => route.kind === "fallback").length !== 1) {
    fail("route contract must contain exactly one fallback route");
  }
  for (const [index, route] of routes.entries()) {
    requireString(route?.id, `routes[${index}].id`);
    requireString(route?.kind, `routes[${index}].kind`);
    requireString(route?.path, `routes[${index}].path`);
    requireString(route?.samplePath, `routes[${index}].samplePath`);
  }
  assertUnique(
    routes.map((route) => route.id),
    "route ids"
  );
  assertUnique(
    routes.map((route) => route.path),
    "route paths"
  );
  assertUnique(
    routes.map((route) => route.samplePath),
    "route sample paths"
  );
  return routes;
}

function validatePluginContract(contract) {
  requireString(contract.apiVersion, "plugin apiVersion");
  const allSlots = requireArray(contract.uiContributionSlots, "plugin uiContributionSlots");
  const activeSlots = requireArray(
    contract.activeUiContributionSlots,
    "plugin activeUiContributionSlots"
  );
  const manifestOnlySlots = requireArray(
    contract.manifestOnlyUiContributionSlots,
    "plugin manifestOnlyUiContributionSlots"
  );
  assertUnique(allSlots, "plugin uiContributionSlots");
  assertUnique(activeSlots, "plugin activeUiContributionSlots");
  assertUnique(manifestOnlySlots, "plugin manifestOnlyUiContributionSlots");
  const partition = [...activeSlots, ...manifestOnlySlots];
  assertUnique(partition, "plugin slot partition");
  if ([...partition].sort().join("\n") !== [...allSlots].sort().join("\n")) {
    fail("active and manifest-only plugin slots must partition uiContributionSlots");
  }
  return { allSlots, activeSlots, manifestOnlySlots };
}

function validateSupportMatrix(contract) {
  if (contract.schemaVersion !== 1) fail("support matrix contract schemaVersion must be 1");
  const targets = requireArray(contract.officialTargets, "support matrix officialTargets");
  if (targets.length !== EXPECTED_OFFICIAL_TARGETS) {
    fail(`expected ${EXPECTED_OFFICIAL_TARGETS} official targets, received ${targets.length}`);
  }
  for (const [index, target] of targets.entries()) {
    requireString(target?.id, `officialTargets[${index}].id`);
    requireString(target?.target, `officialTargets[${index}].target`);
    requireString(target?.updaterPlatform, `officialTargets[${index}].updaterPlatform`);
    requireString(target?.latestAssetName, `officialTargets[${index}].latestAssetName`);
    requireString(target?.latestSignatureName, `officialTargets[${index}].latestSignatureName`);
  }
  assertUnique(
    targets.map((target) => target.id),
    "official target ids"
  );
  assertUnique(
    targets.map((target) => target.updaterPlatform),
    "updater platform keys"
  );
  return targets;
}

function generateContract({ root, rustContract, supportMatrix }) {
  validateRustContract(rustContract);
  const packageJson = readJson(join(root, "package.json"), "package");
  const tauriConfig = readJson(join(root, "src-tauri", "tauri.conf.json"), "Tauri config");
  const routeContractPath = "src/app/app-routes.contract.json";
  const pluginContractPath = "docs/plugins/plugin-api-v1-contract.json";
  const routeContract = readJson(join(root, routeContractPath), "route contract");
  const pluginContract = readJson(join(root, pluginContractPath), "Plugin API contract");
  const routes = validateRoutes(routeContract);
  const slots = validatePluginContract(pluginContract);
  const officialTargets = validateSupportMatrix(supportMatrix);

  requireString(packageJson.version, "package version");
  requireString(tauriConfig.productName, "Tauri productName");
  requireString(tauriConfig.version, "Tauri version");
  requireString(tauriConfig.identifier, "Tauri identifier");
  if (packageJson.version !== tauriConfig.version) {
    fail(
      `package version ${packageJson.version} differs from Tauri version ${tauriConfig.version}`
    );
  }

  const updater = tauriConfig.plugins?.updater;
  const endpoints = requireArray(updater?.endpoints, "Tauri updater endpoints");
  if (endpoints.length !== 1) fail("Tauri updater must have exactly one stable endpoint");
  const publicKey = requireString(updater?.pubkey, "Tauri updater public key");

  const artifactPaths = new Set([
    normalizeRelativePath(root, rustContract.ipc.bindingsPath, "bindings path"),
    routeContractPath,
    pluginContractPath,
    "src-tauri/tauri.conf.json",
  ]);
  for (const event of rustContract.events) {
    artifactPaths.add(normalizeRelativePath(root, event.fixturePath, `fixture for ${event.name}`));
  }
  for (const path of rustContract.artifactPaths) {
    artifactPaths.add(normalizeRelativePath(root, path, "Rust artifact path"));
  }

  const artifactHashes = {};
  for (const path of [...artifactPaths].sort()) {
    const absolute = resolveInside(root, path, "artifact path");
    if (!existsSync(absolute)) fail(`contract artifact does not exist: ${path}`);
    artifactHashes[path] = sha256File(absolute);
  }

  return {
    schemaVersion: 1,
    sourceVersion: packageJson.version,
    appIdentity: {
      productName: tauriConfig.productName,
      identifier: tauriConfig.identifier,
      dotdirName: rustContract.data.dotdirName,
      databaseFileName: rustContract.data.databaseFileName,
      settingsFileName: rustContract.data.settingsFileName,
    },
    routes,
    globalSurfaces: requireArray(routeContract.globalSurfaces, "route globalSurfaces"),
    ipc: {
      generatedCommands: rustContract.ipc.generatedCommands,
      generatedCommandCount: rustContract.ipc.generatedCommands.length,
      runtimeOnlyCommands: rustContract.ipc.runtimeOnlyCommands,
      runtimeCommandCount: rustContract.ipc.runtimeCommandCount,
      riskyOperations: rustContract.ipc.riskyOperations,
      confirmErrorCodes: rustContract.ipc.confirmErrorCodes,
      confirmLimits: rustContract.ipc.confirmLimits,
      bindingsPath: normalizeRelativePath(root, rustContract.ipc.bindingsPath, "bindings path"),
    },
    events: rustContract.events.map((event) => ({
      ...event,
      fixturePath: normalizeRelativePath(root, event.fixturePath, `fixture for ${event.name}`),
    })),
    data: rustContract.data,
    plugins: {
      apiVersion: pluginContract.apiVersion,
      manifestVersion: pluginContract.manifestVersion ?? null,
      contractPath: pluginContractPath,
      runtimes: pluginContract.runtimes,
      uiContributionSlots: slots.allSlots,
      activeUiContributionSlots: slots.activeSlots,
      manifestOnlyUiContributionSlots: slots.manifestOnlySlots,
      extensionHost: rustContract.extensionHost,
    },
    release: {
      officialTargets,
      updaterEndpoint: endpoints[0],
      updaterPublicKeySha256: createHash("sha256").update(publicKey).digest("hex"),
      windowsInstallMode: updater.windows?.installMode ?? null,
    },
    artifactHashes,
  };
}

function writeAtomically(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  try {
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const root = resolve(args.get("--root") ?? process.env.AIO_EGUI_CONTRACT_ROOT ?? defaultRoot);
  const outputPath = resolveInside(
    root,
    args.get("--output") ?? join(root, "docs", "egui-migration", "compatibility-contract.json"),
    "output path"
  );
  const rustContract = loadRustContract(root, args.get("--rust-json"));
  const supportMatrix = loadSupportMatrix(root, args.get("--support-matrix-json"));
  const content = canonicalJson(generateContract({ root, rustContract, supportMatrix }));

  if (flags.has("--write")) {
    writeAtomically(outputPath, content);
    console.error(`[egui-compat-contract] wrote ${outputPath}`);
    return;
  }

  if (!existsSync(outputPath)) fail(`snapshot is missing: ${outputPath}; run with --write`);
  const current = readFileSync(outputPath, "utf8");
  if (current !== content) {
    fail(
      `compatibility contract drift detected at ${outputPath}; review sources and run with --write`
    );
  }
  console.error("[egui-compat-contract] snapshot is current");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
