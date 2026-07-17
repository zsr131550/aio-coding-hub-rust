import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const canonicalOwner = "zsr131550";
const canonicalRepository = "aio-coding-hub-rust";
const forbiddenPaths = new Set([
  ".github/workflows/sync-upstream.yml",
  ".github/workflows/sync-upstream.yaml",
  ".github/workflows/release.yml",
  ".github/workflows/release.yaml",
  ".github/workflows/release-pr-sync-cargo-lock.yml",
  ".github/workflows/release-pr-sync-cargo-lock.yaml",
  "release-please-config.json",
  ".release-please-manifest.json",
  "scripts/fetch-checked-file.mjs",
]);
const allowedWorkflowPaths = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/dev-build.yml",
]);
const productReferencePatterns = [
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?:\.git)?(?=[/?#\s"'<>()[\]]|$)/gi,
  /(?:https?:\/\/)?api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?=[/?#\s"'<>()[\]]|$)/gi,
  /(?:https?:\/\/)?raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?=[/?#\s"'<>()[\]]|$)/gi,
  /(?:https?:\/\/)?img\.shields\.io\/github\/(?:[^/?#\s"'<>]+\/){1,3}([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?=[/?#\s"'<>()[\]]|$)/gi,
  /[?&](?:repo|repos)=([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?=[&#\s"'<>]|$)/gi,
  /git@github\.com:([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?:\.git)?(?=[/?#\s"'<>()[\]]|$)/gi,
  /^\s*repository:\s*["']?([A-Za-z0-9_.-]+)\/(aio-coding-hub(?:-rust)?)(?:\.git)?["']?(?:\s*(?:#.*)?$)/gim,
];

function parseArgs(argv) {
  let root = defaultRoot;
  let staged = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--staged") {
      staged = true;
      continue;
    }
    if (arg !== "--root" || !argv[index + 1]) {
      throw new Error(arg === "--root" ? "--root requires a path" : `unknown argument: ${arg}`);
    }
    root = resolve(argv[index + 1]);
    index += 1;
  }
  return { root, staged };
}

function gitTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw new Error(`failed to start git ls-files: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed with status ${result.status}\n${result.stderr}`);
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function readTrackedText(root, file, staged) {
  let contents;
  if (staged) {
    const result = spawnSync("git", ["show", `:${file}`], {
      cwd: root,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    if (result.error) throw new Error(`failed to read staged ${file}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`failed to read staged ${file} (status ${result.status})`);
    }
    contents = result.stdout;
  } else {
    const absolute = join(root, file);
    if (!existsSync(absolute)) return null;
    contents = readFileSync(absolute);
  }
  if (contents.includes(0)) return null;
  return contents.toString("utf8");
}

function historicalOwnerFromLicense(root, tracked, staged, failures) {
  const file = "LICENSE";
  if (!tracked.has(file)) {
    failures.push(`${file}: retained MIT license must be tracked`);
    return null;
  }
  const source = readTrackedText(root, file, staged);
  const match = source?.match(/^Copyright\s+\(c\)\s+\d{4}(?:-\d{4})?\s+(.+?)\s*$/im);
  if (!match) {
    failures.push(`${file}: retained copyright owner could not be identified`);
    return null;
  }
  return match[1].trim();
}

function auditProductReferences(file, source, failures) {
  for (const pattern of productReferencePatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const owner = match[1].toLowerCase();
      const repository = match[2].toLowerCase();
      if (owner !== canonicalOwner || repository !== canonicalRepository) {
        failures.push(
          `${file}:${lineNumberAt(source, match.index)} product repository URL must target ${canonicalOwner}/${canonicalRepository}`
        );
        return;
      }
    }
  }
}

function auditHistoricalOwner(file, source, historicalOwner, failures) {
  if (file === "LICENSE" || historicalOwner == null) return;
  const escaped = historicalOwner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "im").exec(source);
  if (match) {
    failures.push(
      `${file}:${lineNumberAt(source, match.index)} historical owner identity is allowed only in LICENSE`
    );
  }
}

function auditWorkflow(file, source, failures) {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file)) return;
  if (!allowedWorkflowPaths.has(file)) {
    failures.push(`${file}: only ci.yml and dev-build.yml are allowed during the Rust rewrite`);
  }
  if (/^\s*contents:\s*write\s*(?:#.*)?$/im.test(source)) {
    failures.push(`${file}: workflow contents permission must remain read-only`);
  }
  if (/(?:softprops\/action-gh-release|ncipollo\/release-action)@/i.test(source)) {
    failures.push(`${file}: release publication actions are disabled during the Rust rewrite`);
  }
  if (/\bgit\s+remote\s+(?:add|set-url)\b/i.test(source)) {
    failures.push(`${file}: workflow must not add a project source remote`);
  }
  if (/\bgit\s+(?:fetch|pull)(?:\s+--[^\s]+)*\s+(?:upstream|source)\b/i.test(source)) {
    failures.push(`${file}: workflow must not fetch from a secondary source repository`);
  }
  if (/\bgh\s+repo\s+sync\b/i.test(source)) {
    failures.push(`${file}: workflow must not synchronize from another repository`);
  }
  if (/\b(?:SYNC_TOKEN|UPSTREAM_TOKEN|UPSTREAM_REPO)\b/i.test(source)) {
    failures.push(`${file}: workflow must not use a synchronization token or source repository`);
  }
  if (/\brelease-please\b/i.test(source)) {
    failures.push(`${file}: release-please automation is disabled during the Rust rewrite`);
  }
  if (
    /\bgh\s+release\s+(?:create|edit|upload)\b/i.test(source) ||
    /\bgit\s+tag\b/i.test(source) ||
    /\bgit\s+push[^\r\n]*(?:--tags|refs\/tags)/i.test(source)
  ) {
    failures.push(
      `${file}: release or tag publication automation is disabled during the Rust rewrite`
    );
  }
}

function auditCargoAuthors(root, tracked, staged, failures) {
  const file = "src-tauri/Cargo.toml";
  if (!tracked.has(file)) {
    failures.push(`${file}: root Cargo manifest must be tracked`);
    return;
  }
  const source = readTrackedText(root, file, staged);
  if (source == null || !/^authors\s*=\s*\[\s*"zsr131550"\s*\]\s*$/m.test(source)) {
    failures.push(`${file}: root Cargo authors must be ["${canonicalOwner}"]`);
  }
}

function auditUpdaterConfigurations(root, tracked, staged, failures) {
  const mainFile = "src-tauri/tauri.conf.json";
  if (!tracked.has(mainFile)) {
    failures.push(`${mainFile}: Tauri configuration must be tracked`);
    return;
  }
  const configFiles = [...tracked].filter((file) =>
    /^src-tauri\/tauri(?:\.[^/]+)?\.conf\.json$/i.test(file)
  );
  for (const file of configFiles) {
    const source = readTrackedText(root, file, staged);
    if (source == null) {
      failures.push(`${file}: Tauri configuration must be readable text`);
      continue;
    }
    let config;
    try {
      config = JSON.parse(source);
    } catch (error) {
      failures.push(`${file}: invalid JSON (${error.message})`);
      continue;
    }
    const updater = config?.plugins?.updater;
    if (updater != null && typeof updater === "object") {
      if (Object.hasOwn(updater, "endpoints")) {
        failures.push(`${file}: updater endpoints must be absent`);
      }
      if (Object.hasOwn(updater, "pubkey")) {
        failures.push(`${file}: updater public key must be absent`);
      }
    }
    if (Object.hasOwn(config?.bundle ?? {}, "createUpdaterArtifacts")) {
      failures.push(`${file}: updater artifact generation must be absent`);
    }
  }
}

export function auditRepositoryIndependence(root, { staged = false } = {}) {
  const failures = [];
  const files = gitTrackedFiles(root);
  const tracked = new Set(files);
  const historicalOwner = historicalOwnerFromLicense(root, tracked, staged, failures);

  for (const file of forbiddenPaths) {
    if (tracked.has(file) && (staged || existsSync(join(root, file)))) {
      failures.push(`${file}: forbidden workflow or release configuration is present`);
    }
  }

  for (const file of files) {
    const source = readTrackedText(root, file, staged);
    if (source == null) continue;
    auditProductReferences(file, source, failures);
    auditHistoricalOwner(file, source, historicalOwner, failures);
    auditWorkflow(file, source, failures);
  }
  auditCargoAuthors(root, tracked, staged, failures);
  auditUpdaterConfigurations(root, tracked, staged, failures);
  return { files: files.length, failures };
}

function main() {
  const { root, staged } = parseArgs(process.argv.slice(2));
  const result = auditRepositoryIndependence(root, { staged });
  if (result.failures.length > 0) {
    console.error("[repository-independence] failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `[repository-independence] passed (${result.files} tracked files, ${staged ? "staged" : "working-tree"} view, canonical repository ${canonicalOwner}/${canonicalRepository})`
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[repository-independence] ${error.message}`);
    process.exit(1);
  }
}
