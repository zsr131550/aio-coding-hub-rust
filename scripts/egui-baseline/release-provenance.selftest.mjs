import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { delimiter } from "node:path";
import { promisify } from "node:util";
import {
  collectReleaseBuildInputs,
  collectFormalReleaseProvenance,
  releaseBuildManifestPath,
  supportedHostTarget,
  writeReleaseBuildManifest,
} from "./release-provenance.mjs";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "aio-release-provenance-selftest-"));
const executable = path.join(root, "src-tauri", "target", "release", "aio-coding-hub.exe");
const installer = path.join(root, "src-tauri", "target", "release", "bundle", "msi", "aio.msi");
const appBundleExecutable = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "AIO Coding Hub.app",
  "Contents",
  "MacOS",
  "aio-coding-hub"
);
const hostTarget = supportedHostTarget();
assert.ok(hostTarget, "release provenance selftest requires a supported host");
const overlayContents = '{"bundle":{"createUpdaterArtifacts":false}}\n';
const overlayPath = path.join(root, ".local", "tauri.build.local.json");
const buildConfiguration = {
  formalCompatible: true,
  bundles:
    hostTarget === "x86_64-pc-windows-msvc"
      ? "msi"
      : hostTarget.includes("apple")
        ? "app"
        : "deb,appimage",
  configOverlay: {
    path: ".local/tauri.build.local.json",
    sha256: createHash("sha256").update(overlayContents).digest("hex"),
  },
};

try {
  await mkdir(path.dirname(installer), { recursive: true });
  await mkdir(path.dirname(appBundleExecutable), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "target/\n.local/\n");
  await mkdir(path.dirname(overlayPath), { recursive: true });
  await writeFile(overlayPath, overlayContents);
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.2.3"}\n');
  await writeFile(path.join(root, "source.txt"), "source-v1\n");
  await writeFile(executable, "release-executable-v1\n");
  await writeFile(installer, "release-installer-v1\n");
  await writeFile(appBundleExecutable, "app-bundle-executable\n");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  const dirtyTracked = path.join(root, "source.txt");
  const dirtyUntracked = path.join(root, "notes.txt");
  await writeFile(dirtyTracked, "dirty-tracked-v1\n");
  await writeFile(dirtyUntracked, "dirty-untracked-v1\n");

  const releaseBuildInputs = async (profile) =>
    collectReleaseBuildInputs({
      repositoryRoot: root,
      profile,
      target: hostTarget,
      buildConfiguration,
    });
  const manifest = await writeReleaseBuildManifest({
    repositoryRoot: root,
    executable,
    buildInputs: await releaseBuildInputs("release"),
  });
  const evidence = await collectFormalReleaseProvenance({
    repositoryRoot: root,
    executable,
  });
  assert.equal(evidence.packageVersion, "1.2.3");
  assert.equal(evidence.releaseArtifacts.installers.length, 2);
  const appBundle = evidence.releaseArtifacts.installers.find((item) => item.kind === "app-bundle");
  assert.equal(appBundle.path, "bundle/macos/AIO Coding Hub.app");
  assert.equal(appBundle.bytes, Buffer.byteLength("app-bundle-executable\n"));
  assert.match(appBundle.sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.buildManifest.sha256.length, 64);
  assert.equal(evidence.buildManifest.profile, "release");
  assert.equal(evidence.buildManifest.configOverlaySha256, buildConfiguration.configOverlay.sha256);
  assert.equal(
    JSON.parse(await readFile(releaseBuildManifestPath(executable), "utf8")).executable.sha256,
    manifest.executable.sha256
  );

  const stagedResult = path.join(root, ".local", "egui-baselines", "first-scenario.json");
  await mkdir(path.dirname(stagedResult), { recursive: true });
  await writeFile(stagedResult, '{"status":"complete"}\n');
  assert.equal(
    (await collectFormalReleaseProvenance({ repositoryRoot: root, executable })).repository
      .statusSha256,
    manifest.repository.statusSha256,
    "a completed result in gitignored staging must not invalidate the next scenario"
  );

  await writeFile(overlayPath, '{"bundle":{"createUpdaterArtifacts":true}}\n');
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /config overlay/i
  );
  await writeFile(overlayPath, overlayContents);

  await writeFile(dirtyTracked, "dirty-tracked-v2\n");
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /repository state changed/i
  );
  await writeFile(dirtyTracked, "dirty-tracked-v1\n");
  await writeFile(dirtyUntracked, "dirty-untracked-v2\n");
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /repository state changed/i
  );
  await writeFile(dirtyUntracked, "dirty-untracked-v1\n");

  const marker = path.join(root, "docs", "baselines", "result.json.inprogress");
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, "runner-owned marker\n");
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /repository state changed/i
  );
  assert.equal(
    (
      await collectFormalReleaseProvenance({
        repositoryRoot: root,
        executable,
        ignoredUntrackedPaths: [marker],
      })
    ).repository.statusSha256,
    manifest.repository.statusSha256
  );
  const unrelated = path.join(root, "unrelated-untracked.txt");
  await writeFile(unrelated, "must remain observable\n");
  await assert.rejects(
    () =>
      collectFormalReleaseProvenance({
        repositoryRoot: root,
        executable,
        ignoredUntrackedPaths: [marker],
      }),
    /repository state changed/i
  );
  await rm(marker);
  await rm(unrelated);

  await writeFile(executable, "tampered-executable\n");
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /executable.*manifest|manifest.*executable/i
  );
  await writeFile(executable, "release-executable-v1\n");

  const withoutInstaller = structuredClone(manifest);
  withoutInstaller.installers = [];
  await writeFile(
    releaseBuildManifestPath(executable),
    `${JSON.stringify(withoutInstaller, null, 2)}\n`
  );
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /at least one installer/i
  );

  const wrongTarget = structuredClone(manifest);
  wrongTarget.target =
    hostTarget === "x86_64-pc-windows-msvc" ? "x86_64-unknown-linux-gnu" : "x86_64-pc-windows-msvc";
  await writeFile(
    releaseBuildManifestPath(executable),
    `${JSON.stringify(wrongTarget, null, 2)}\n`
  );
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /target.*host|host.*target/i
  );

  const nonCanonicalBuild = structuredClone(manifest);
  nonCanonicalBuild.build.formalCompatible = false;
  await writeFile(
    releaseBuildManifestPath(executable),
    `${JSON.stringify(nonCanonicalBuild, null, 2)}\n`
  );
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /canonical formal build arguments/i
  );

  await writeReleaseBuildManifest({
    repositoryRoot: root,
    executable,
    buildInputs: await releaseBuildInputs("debug"),
  });
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /release profile/i
  );

  await writeReleaseBuildManifest({
    repositoryRoot: root,
    executable,
    buildInputs: await releaseBuildInputs("release"),
  });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.2.4"}\n');
  await assert.rejects(
    () => collectFormalReleaseProvenance({ repositoryRoot: root, executable }),
    /package metadata changed/i
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("[egui-baseline:release-provenance:selftest] 1 test passed");

const wrapperRoot = await mkdtemp(path.join(os.tmpdir(), "aio-build-wrapper-provenance-selftest-"));
try {
  const fakeBin = path.join(wrapperRoot, "bin");
  const targetRoot = path.join(wrapperRoot, "target");
  const releaseDirectory = path.join(targetRoot, "x86_64-pc-windows-msvc", "release");
  const wrapperExecutable = path.join(releaseDirectory, "aio-coding-hub.exe");
  const staleInstaller = path.join(releaseDirectory, "bundle", "msi", "stale.msi");
  const fakeTauri = path.join(fakeBin, process.platform === "win32" ? "tauri.cmd" : "tauri");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.dirname(staleInstaller), { recursive: true });
  await writeFile(staleInstaller, "stale-installer\n");
  await writeFile(
    fakeTauri,
    process.platform === "win32"
      ? [
          "@echo off",
          'mkdir "%CARGO_TARGET_DIR%\\x86_64-pc-windows-msvc\\release\\bundle\\msi"',
          '> "%CARGO_TARGET_DIR%\\x86_64-pc-windows-msvc\\release\\aio-coding-hub.exe" echo executable',
          '> "%CARGO_TARGET_DIR%\\x86_64-pc-windows-msvc\\release\\bundle\\msi\\aio.msi" echo installer',
          "exit /b 0",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'mkdir -p "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/msi"',
          'printf "executable\\n" > "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/aio-coding-hub.exe"',
          'printf "installer\\n" > "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/msi/aio.msi"',
          "",
        ].join("\n")
  );
  if (process.platform !== "win32") await chmod(fakeTauri, 0o755);
  await execFileAsync(
    process.execPath,
    [path.resolve("scripts/tauri-build.mjs"), "--target", "x86_64-pc-windows-msvc"],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        CI: "true",
        CARGO_TARGET_DIR: targetRoot,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      },
    }
  );
  const wrapperManifest = JSON.parse(
    await readFile(releaseBuildManifestPath(wrapperExecutable), "utf8")
  );
  assert.equal(wrapperManifest.profile, "release");
  assert.equal(wrapperManifest.target, "x86_64-pc-windows-msvc");
  assert.equal(wrapperManifest.installers.length, 1);
  assert.equal(wrapperManifest.installers[0].path, "bundle/msi/aio.msi");
} finally {
  await rm(wrapperRoot, { recursive: true, force: true });
}

console.log("[egui-baseline:release-provenance:selftest] 2 tests passed");
