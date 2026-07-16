/**
 * Usage:
 *   pnpm tauri:build -- [tauri build args...]
 *   pnpm tauri:build:mac:arm64 -- [tauri build args...]
 *
 * Purpose:
 * - Avoid failing local builds when updater signing is enabled in `tauri.conf.json`
 *   but `TAURI_SIGNING_PRIVATE_KEY` is not set.
 *
 * How it works:
 * - If running locally (not CI) and no signing private key is provided, we merge a small
 *   config overlay that disables `bundle.createUpdaterArtifacts`.
 * - CI/release builds (with signing keys) keep the default behavior and still generate
 *   updater artifacts + signatures.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectReleaseBuildInputs,
  releaseBuildManifestPath,
  writeReleaseBuildManifest,
} from "./egui-baseline/release-provenance.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const localDir = resolve(projectRoot, ".local");
const overlayPath = resolve(localDir, "tauri.build.local.json");
const DEFAULT_BUNDLES_BY_TARGET = Object.freeze({
  "x86_64-pc-windows-msvc": "msi",
  "x86_64-apple-darwin": "app",
  "aarch64-apple-darwin": "app",
  "universal-apple-darwin": "app",
  "x86_64-unknown-linux-gnu": "deb,appimage",
});

function hasNonWhitespace(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isCiEnv() {
  return process.env.GITHUB_ACTIONS === "true" || hasNonWhitespace(process.env.CI);
}

function ensureLocalBuildOverlayFileExists() {
  mkdirSync(localDir, { recursive: true });

  const overlay = {
    bundle: {
      createUpdaterArtifacts: false,
    },
  };

  const contents = JSON.stringify(overlay, null, 2) + "\n";
  writeFileSync(overlayPath, contents, "utf8");
  console.log(`[tauri:build] Wrote canonical local overlay: ${overlayPath}`);
  return {
    path: ".local/tauri.build.local.json",
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function resolveCliOptionValue(args, optionNames) {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    for (const optionName of optionNames) {
      if (current === optionName) {
        return args[index + 1] ?? null;
      }
      if (current.startsWith(`${optionName}=`)) {
        return current.slice(optionName.length + 1);
      }
    }
  }

  return null;
}

function hasCliOption(args, optionNames) {
  return args.some((current) =>
    optionNames.some((optionName) => current === optionName || current.startsWith(`${optionName}=`))
  );
}

function resolveHostTarget() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }

  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }

  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }

  return null;
}

function appendDefaultBundlesArg(tauriArgs, userArgs) {
  if (hasCliOption(userArgs, ["--bundles", "-b"])) {
    return;
  }

  const resolvedTarget = resolveCliOptionValue(userArgs, ["--target", "-t"]) ?? resolveHostTarget();
  const defaultBundles = resolvedTarget ? DEFAULT_BUNDLES_BY_TARGET[resolvedTarget] : null;
  if (!defaultBundles) {
    return;
  }

  console.log(
    `[tauri:build] Target ${resolvedTarget} defaults to --bundles ${defaultBundles} to match the support matrix.`
  );
  tauriArgs.push("--bundles", defaultBundles);
}

function expectedReleaseExecutable(userArgs) {
  const target = resolveCliOptionValue(userArgs, ["--target", "-t"]);
  const cargoTargetDirValue = process.env.CARGO_TARGET_DIR;
  const cargoTargetDir = cargoTargetDirValue
    ? isAbsolute(cargoTargetDirValue)
      ? resolve(cargoTargetDirValue)
      : resolve(projectRoot, "src-tauri", cargoTargetDirValue)
    : resolve(projectRoot, "src-tauri", "target");
  const profile = hasCliOption(userArgs, ["--debug", "-d"])
    ? "debug"
    : (resolveCliOptionValue(userArgs, ["--profile"]) ?? "release");
  const windowsTarget = target?.includes("windows") ?? process.platform === "win32";
  return resolve(
    cargoTargetDir,
    ...(target ? [target] : []),
    profile,
    `aio-coding-hub${windowsTarget ? ".exe" : ""}`
  );
}

function resolvedBuildProfile(userArgs) {
  return hasCliOption(userArgs, ["--debug", "-d"])
    ? "debug"
    : (resolveCliOptionValue(userArgs, ["--profile"]) ?? "release");
}

function resolvedBuildTarget(userArgs) {
  return resolveCliOptionValue(userArgs, ["--target", "-t"]) ?? resolveHostTarget();
}

function canonicalBuildConfiguration(userArgs, configOverlay) {
  const target = resolvedBuildTarget(userArgs);
  const profile = resolvedBuildProfile(userArgs);
  const expectedBundles = target ? (DEFAULT_BUNDLES_BY_TARGET[target] ?? null) : null;
  let argumentsAreCanonical = true;
  for (let index = 0; index < userArgs.length; index += 1) {
    const current = userArgs[index];
    if (["--target", "-t", "--bundles", "-b"].includes(current)) {
      index += 1;
      if (userArgs[index] == null) argumentsAreCanonical = false;
    } else if (
      !current.startsWith("--target=") &&
      !current.startsWith("-t=") &&
      !current.startsWith("--bundles=") &&
      !current.startsWith("-b=")
    ) {
      argumentsAreCanonical = false;
    }
  }
  const requestedBundles = resolveCliOptionValue(userArgs, ["--bundles", "-b"]) ?? expectedBundles;
  return {
    formalCompatible:
      argumentsAreCanonical &&
      profile === "release" &&
      target === resolveHostTarget() &&
      requestedBundles === expectedBundles,
    bundles: requestedBundles,
    configOverlay,
  };
}

function quarantineBuildOutput(target) {
  const backup = `${target}.aio-build-backup-${process.pid}`;
  if (existsSync(backup)) {
    throw new Error(`stale build-output backup already exists: ${backup}`);
  }
  if (!existsSync(target)) return { target, backup, moved: false };
  renameSync(target, backup);
  return { target, backup, moved: true };
}

function restoreBuildOutputs(outputs) {
  for (const output of [...outputs].reverse()) {
    rmSync(output.target, { recursive: true, force: true });
    if (output.moved) renameSync(output.backup, output.target);
  }
}

function discardBuildOutputBackups(outputs) {
  for (const output of outputs) {
    if (output.moved) rmSync(output.backup, { recursive: true, force: true });
  }
}

async function run() {
  const userArgs = process.argv.slice(2);

  // pnpm passes a literal `--` separator to the underlying command, and if the script
  // already has args (e.g. `--target ...`) it won't be at index 0. Strip it so flags
  // like `--verbose` go to `tauri build` by default. If you need to pass runner args,
  // use `pnpm <script> -- -- <runner-args...>` (two `--`).
  if (hasNonWhitespace(process.env.npm_lifecycle_event)) {
    const pnpmSeparatorIndex = userArgs.indexOf("--");
    if (pnpmSeparatorIndex !== -1) {
      userArgs.splice(pnpmSeparatorIndex, 1);
    }
  }

  const hasSigningKey = hasNonWhitespace(process.env.TAURI_SIGNING_PRIVATE_KEY);
  const shouldDisableUpdaterArtifacts = !isCiEnv() && !hasSigningKey;

  const tauriArgs = ["build"];
  let configOverlay = null;
  if (shouldDisableUpdaterArtifacts) {
    configOverlay = ensureLocalBuildOverlayFileExists();
    console.log(
      "[tauri:build] TAURI_SIGNING_PRIVATE_KEY not set; disabling bundle.createUpdaterArtifacts for local build."
    );
    tauriArgs.push("-c", overlayPath);
  }
  appendDefaultBundlesArg(tauriArgs, userArgs);
  tauriArgs.push(...userArgs);
  const expectedExecutable = expectedReleaseExecutable(userArgs);
  const buildProfile = resolvedBuildProfile(userArgs);
  const buildTarget = resolvedBuildTarget(userArgs) ?? "unknown-host-target";
  const buildConfiguration = canonicalBuildConfiguration(userArgs, configOverlay);
  let buildInputs;
  try {
    buildInputs = await collectReleaseBuildInputs({
      repositoryRoot: projectRoot,
      profile: buildProfile,
      target: buildTarget,
      buildConfiguration,
    });
  } catch (error) {
    console.error(`[tauri:build] failed to capture build inputs: ${error?.message ?? error}`);
    process.exitCode = 1;
    return;
  }
  const quarantinedOutputs = [];
  try {
    quarantinedOutputs.push(quarantineBuildOutput(expectedExecutable));
    quarantinedOutputs.push(quarantineBuildOutput(releaseBuildManifestPath(expectedExecutable)));
    quarantinedOutputs.push(quarantineBuildOutput(resolve(dirname(expectedExecutable), "bundle")));
  } catch (error) {
    restoreBuildOutputs(quarantinedOutputs);
    console.error(
      `[tauri:build] failed to prepare clean release outputs: ${error?.message ?? error}`
    );
    process.exit(1);
  }

  const child = spawn("tauri", tauriArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  // Wait for stdio to close before finalizing the wrapper. Calling process.exit()
  // from the earlier `exit` event can race the package runner on Windows and make
  // a failed build appear successful.
  child.once("close", async (code, signal) => {
    if (spawnError) {
      restoreBuildOutputs(quarantinedOutputs);
      console.error(`[tauri:build] failed to spawn tauri: ${spawnError?.message ?? spawnError}`);
      process.exitCode = 1;
      return;
    }
    if (signal) {
      restoreBuildOutputs(quarantinedOutputs);
      console.error(`[tauri:build] exited with signal: ${signal}`);
      process.exitCode = 1;
      return;
    }
    if (code !== 0) {
      restoreBuildOutputs(quarantinedOutputs);
      process.exitCode = typeof code === "number" && code > 0 ? code : 1;
      return;
    }
    if (!existsSync(expectedExecutable)) {
      restoreBuildOutputs(quarantinedOutputs);
      console.error(`[tauri:build] release executable was not produced: ${expectedExecutable}`);
      process.exitCode = 1;
      return;
    }
    try {
      const manifest = await writeReleaseBuildManifest({
        repositoryRoot: projectRoot,
        executable: expectedExecutable,
        buildInputs,
      });
      console.log(
        `[tauri:build] Wrote release provenance: ${expectedExecutable}.build-provenance.json (${manifest.installers.length} installer artifact(s))`
      );
      discardBuildOutputBackups(quarantinedOutputs);
    } catch (error) {
      restoreBuildOutputs(quarantinedOutputs);
      console.error(`[tauri:build] failed to write release provenance: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  });
}

run().catch((error) => {
  console.error(`[tauri:build] unexpected failure: ${error?.message ?? error}`);
  process.exitCode = 1;
});
