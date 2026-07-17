import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const CAPABILITY_PLUGIN_IDENTIFIERS = Object.freeze([
  "tauri_plugin_clipboard_manager",
  "tauri_plugin_dialog",
  "tauri_plugin_opener",
  "tauri_plugin_notification",
  "tauri_plugin_autostart",
  "tauri_plugin_updater",
]);
const CAPABILITY_PLUGIN_EXACT_ALLOWLIST = new Set([
  "src-tauri/src/app/plugin_registry.rs",
  "src-tauri/src/app/bootstrap.rs",
  "src-tauri/src/app/heartbeat_watchdog.rs",
  "src-tauri/src/egui_fixture_contract.rs",
]);

const POLICIES = Object.freeze({
  "aio-contract": Object.freeze({
    normal: new Set(["serde", "specta"]),
    dev: new Set(["serde_json"]),
    build: new Set(),
  }),
  "aio-core": Object.freeze({
    normal: new Set(["aio-contract", "aio-platform", "thiserror", "tokio"]),
    dev: new Set(["serde_json", "tempfile", "tokio"]),
    build: new Set(),
  }),
  "aio-platform": Object.freeze({
    normal: new Set(["serde", "specta", "thiserror", "url"]),
    dev: new Set(["serde_json"]),
    build: new Set(),
  }),
});

function parseArgs(argv) {
  let root = defaultRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { root };
}

function normalizedPath(path) {
  const canonical = realpathSync(path).replaceAll("\\", "/");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function loadMetadata(tauriRoot) {
  const manifestPath = join(tauriRoot, "Cargo.toml");
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifestPath],
    {
      cwd: tauriRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    }
  );
  if (result.error) {
    throw new Error(`failed to start cargo metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed with status ${result.status}\n${result.stderr || result.stdout}`
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`cargo metadata returned invalid JSON: ${error.message}`);
  }
}

function dependencyKind(dependency) {
  return dependency.kind ?? "normal";
}

function isForbiddenDependency(name) {
  const normalized = name.toLowerCase();
  return (
    normalized === "tauri" ||
    normalized.startsWith("tauri-") ||
    [
      "egui",
      "eframe",
      "winit",
      "wry",
      "webview2-com",
      "webkit2gtk",
      "webkit2gtk-sys",
      "rfd",
      "arboard",
      "tray-icon",
      "notify-rust",
    ].includes(normalized)
  );
}

function packageForName(metadata, name, failures) {
  const matches = metadata.packages.filter((pkg) => pkg.name === name);
  if (matches.length !== 1) {
    failures.push(`workspace must contain exactly one ${name} package (found ${matches.length})`);
    return null;
  }
  return matches[0];
}

function auditDirectDependencies(pkg, policy, failures) {
  for (const dependency of pkg.dependencies) {
    const kind = dependencyKind(dependency);
    const allowed = policy[kind];
    if (!allowed || !allowed.has(dependency.name)) {
      failures.push(
        `${pkg.name}: disallowed ${kind} dependency '${dependency.name}' in Cargo metadata`
      );
    }
  }
}

function dependencyIds(node) {
  if (Array.isArray(node.deps)) {
    return node.deps.map((dependency) => dependency.pkg);
  }
  return node.dependencies ?? [];
}

function auditForbiddenDependencyClosure(metadata, rootPackage, failures) {
  if (!metadata.resolve?.nodes) {
    failures.push("cargo metadata did not include a resolved dependency graph");
    return;
  }

  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const queue = [{ id: rootPackage.id, path: [rootPackage.name] }];
  const visited = new Set([rootPackage.id]);

  while (queue.length > 0) {
    const current = queue.shift();
    const node = nodes.get(current.id);
    if (!node) {
      failures.push(`${rootPackage.name}: missing resolve node for ${current.id}`);
      continue;
    }
    for (const dependencyId of dependencyIds(node)) {
      const dependencyPackage = packages.get(dependencyId);
      if (!dependencyPackage) {
        failures.push(`${rootPackage.name}: missing package metadata for ${dependencyId}`);
        continue;
      }
      const dependencyPath = [...current.path, dependencyPackage.name];
      if (isForbiddenDependency(dependencyPackage.name)) {
        failures.push(
          `${rootPackage.name}: prohibited resolved dependency '${dependencyPackage.name}' via ${dependencyPath.join(" -> ")}`
        );
      }
      if (!visited.has(dependencyId)) {
        visited.add(dependencyId);
        queue.push({ id: dependencyId, path: dependencyPath });
      }
    }
  }
}

function collectRustSources(crateRoot, failures) {
  const files = [];
  const roots = ["src", "tests", "examples", "benches"]
    .map((name) => join(crateRoot, name))
    .filter((path) => existsSync(path));
  const buildScript = join(crateRoot, "build.rs");
  if (existsSync(buildScript)) {
    roots.push(buildScript);
  }

  function visit(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      failures.push(
        `${relative(crateRoot, path)}: symbolic links are not allowed in headless crates`
      );
      return;
    }
    if (info.isFile()) {
      if (path.endsWith(".rs")) {
        files.push(path);
      }
      return;
    }
    if (!info.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visit(join(path, entry.name));
    }
  }

  for (const root of roots) {
    visit(root);
  }
  files.sort();
  return files;
}

function rawStringStart(source, index) {
  const match = /^(?:br|rb|r)(#{0,255})"/.exec(source.slice(index));
  if (!match) {
    return null;
  }
  return { length: match[0].length, terminator: `"${match[1]}` };
}

function stripRustNonCode(source) {
  const output = [...source];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output[index] = " ";
        index += 1;
      }
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          output[index] = " ";
          output[index + 1] = " ";
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          output[index] = " ";
          output[index + 1] = " ";
          index += 2;
        } else {
          if (source[index] !== "\n") {
            output[index] = " ";
          }
          index += 1;
        }
      }
      continue;
    }

    const raw = rawStringStart(source, index);
    if (raw) {
      const end = source.indexOf(raw.terminator, index + raw.length);
      const stop = end === -1 ? source.length : end + raw.terminator.length;
      while (index < stop) {
        if (source[index] !== "\n") {
          output[index] = " ";
        }
        index += 1;
      }
      continue;
    }

    const stringPrefixLength = source.startsWith('b"', index) ? 2 : source[index] === '"' ? 1 : 0;
    if (stringPrefixLength > 0) {
      let escaped = false;
      const start = index;
      index += stringPrefixLength;
      while (index < source.length) {
        const char = source[index];
        index += 1;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          break;
        }
      }
      for (let cursor = start; cursor < index; cursor += 1) {
        if (source[cursor] !== "\n") {
          output[cursor] = " ";
        }
      }
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
    }
  }
  return line;
}

function auditRustSource(crateName, crateRoot, repoRoot, failures) {
  const sources = collectRustSources(crateRoot, failures);
  const prohibited =
    /\b(?:tauri(?:_[A-Za-z0-9_]+)?|egui|eframe|winit|wry|webview2_com|webkit2gtk(?:_sys)?|rfd|arboard|tray_icon|notify_rust)\b/g;

  for (const sourcePath of sources) {
    const size = statSync(sourcePath).size;
    const displayPath = relative(repoRoot, sourcePath).replaceAll("\\", "/");
    if (size > MAX_SOURCE_BYTES) {
      failures.push(`${crateName}: ${displayPath} exceeds ${MAX_SOURCE_BYTES} bytes`);
      continue;
    }
    const source = readFileSync(sourcePath, "utf8");
    const code = stripRustNonCode(source);
    for (const match of code.matchAll(prohibited)) {
      failures.push(
        `${crateName}: ${displayPath}:${lineNumberAt(code, match.index)} uses prohibited Rust identifier '${match[0]}'`
      );
    }
  }
  return sources.length;
}

function collectProductionRustSources(sourceRoot, failures) {
  const files = [];

  function visit(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      failures.push(
        `${relative(sourceRoot, path).replaceAll("\\", "/")}: symbolic links are not allowed in production Rust source`
      );
      return;
    }
    if (info.isFile()) {
      if (path.endsWith(".rs")) {
        files.push(path);
      }
      return;
    }
    if (!info.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(path)) {
      visit(join(path, entry));
    }
  }

  if (existsSync(sourceRoot)) {
    visit(sourceRoot);
  }
  return files;
}

function isCapabilityPluginUseAllowed(displayPath) {
  const normalized = displayPath.toLowerCase();
  return (
    normalized.startsWith("src-tauri/src/app/platform/") ||
    CAPABILITY_PLUGIN_EXACT_ALLOWLIST.has(normalized)
  );
}

function auditProductionCapabilityPluginUse(tauriRoot, repoRoot, failures) {
  const sourceRoot = join(tauriRoot, "src");
  for (const sourcePath of collectProductionRustSources(sourceRoot, failures)) {
    const displayPath = relative(repoRoot, sourcePath).replaceAll("\\", "/");
    if (isCapabilityPluginUseAllowed(displayPath)) {
      continue;
    }
    const size = statSync(sourcePath).size;
    if (size > MAX_SOURCE_BYTES) {
      failures.push(`${displayPath}: Rust source exceeds ${MAX_SOURCE_BYTES} bytes`);
      continue;
    }

    const code = stripRustNonCode(readFileSync(sourcePath, "utf8"));
    const reported = new Set();
    for (const identifier of CAPABILITY_PLUGIN_IDENTIFIERS) {
      const pattern = new RegExp(`\\b${identifier}\\b`, "g");
      for (const match of code.matchAll(pattern)) {
        const line = lineNumberAt(code, match.index ?? 0);
        const key = `${identifier}:${line}`;
        if (reported.has(key)) {
          continue;
        }
        reported.add(key);
        failures.push(
          `${displayPath}:${line}: capability plugin '${identifier}' may only be used by approved platform adapters or shell lifecycle files`
        );
      }
    }
  }
}

function auditBoundary(repoRoot) {
  const failures = [];
  const tauriRoot = join(repoRoot, "src-tauri");
  if (!existsSync(join(tauriRoot, "Cargo.toml"))) {
    throw new Error(`missing Cargo workspace: ${tauriRoot}`);
  }
  const metadata = loadMetadata(tauriRoot);
  let sourceCount = 0;

  for (const [crateName, policy] of Object.entries(POLICIES)) {
    const pkg = packageForName(metadata, crateName, failures);
    if (!pkg) {
      continue;
    }
    const expectedRoot = join(tauriRoot, "crates", crateName);
    const expectedManifest = join(expectedRoot, "Cargo.toml");
    if (normalizedPath(pkg.manifest_path) !== normalizedPath(expectedManifest)) {
      failures.push(
        `${crateName}: manifest must be ${relative(repoRoot, expectedManifest).replaceAll("\\", "/")}`
      );
      continue;
    }

    auditDirectDependencies(pkg, policy, failures);
    if (crateName === "aio-core") {
      const contractDependency = pkg.dependencies.find(
        (dependency) =>
          dependency.name === "aio-contract" && dependencyKind(dependency) === "normal"
      );
      if (
        !contractDependency?.path ||
        normalizedPath(contractDependency.path) !==
          normalizedPath(join(tauriRoot, "crates", "aio-contract"))
      ) {
        failures.push("aio-core: aio-contract must be a direct path dependency on ../aio-contract");
      }
      const platformDependency = pkg.dependencies.find(
        (dependency) =>
          dependency.name === "aio-platform" && dependencyKind(dependency) === "normal"
      );
      if (
        !platformDependency?.path ||
        normalizedPath(platformDependency.path) !==
          normalizedPath(join(tauriRoot, "crates", "aio-platform"))
      ) {
        failures.push("aio-core: aio-platform must be a direct path dependency on ../aio-platform");
      }
    }
    auditForbiddenDependencyClosure(metadata, pkg, failures);
    sourceCount += auditRustSource(crateName, expectedRoot, repoRoot, failures);
  }

  auditProductionCapabilityPluginUse(tauriRoot, repoRoot, failures);

  return { failures, sourceCount, packageCount: metadata.packages.length };
}

function main() {
  let root;
  try {
    ({ root } = parseArgs(process.argv.slice(2)));
    const result = auditBoundary(root);
    if (result.failures.length > 0) {
      console.error("[headless-core-boundary] failed:");
      for (const failure of result.failures) {
        console.error(`- ${failure}`);
      }
      process.exit(1);
    }
    console.log(
      `[headless-core-boundary] checked aio-contract, aio-core, and aio-platform: ${result.sourceCount} Rust files, ${result.packageCount} resolved packages`
    );
  } catch (error) {
    console.error(`[headless-core-boundary] ${error.message}`);
    process.exit(1);
  }
}

main();
