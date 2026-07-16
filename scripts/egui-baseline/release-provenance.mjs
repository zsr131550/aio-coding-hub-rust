import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_SUFFIX = ".build-provenance.json";
const INSTALLER_EXTENSIONS = new Set([".msi", ".exe", ".dmg", ".deb", ".rpm", ".appimage"]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedBundlesForTarget(target) {
  if (target === "x86_64-pc-windows-msvc") return "msi";
  if (target === "x86_64-apple-darwin" || target === "aarch64-apple-darwin") return "app";
  if (target === "x86_64-unknown-linux-gnu") return "deb,appimage";
  return null;
}

export async function sha256File(file) {
  return sha256Bytes(await readFile(file));
}

export function releaseBuildManifestPath(executable) {
  return `${path.resolve(executable)}${MANIFEST_SUFFIX}`;
}

export function supportedHostTarget(platform = process.platform, arch = process.arch) {
  return (
    {
      "win32/x64": "x86_64-pc-windows-msvc",
      "darwin/x64": "x86_64-apple-darwin",
      "darwin/arm64": "aarch64-apple-darwin",
      "linux/x64": "x86_64-unknown-linux-gnu",
    }[`${platform}/${arch}`] ?? null
  );
}

function repositoryRelativePath(repositoryRoot, file) {
  const relative = path.relative(repositoryRoot, file);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
    return relative.split(path.sep).join("/");
  }
  return path.resolve(file);
}

async function assertFormalReleaseLocation(repositoryRoot, executable) {
  const [canonicalRoot, canonicalExecutable] = await Promise.all([
    realpath(repositoryRoot),
    realpath(executable),
  ]);
  const relative = path.relative(canonicalRoot, canonicalExecutable);
  const segments = relative.split(path.sep);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    segments[0] !== "src-tauri" ||
    segments[1] !== "target" ||
    segments.at(-2) !== "release" ||
    segments.length < 4
  ) {
    throw new Error(
      "formal baseline executable must be inside the repository src-tauri/target/.../release tree"
    );
  }
}

async function hashAppBundle(directory) {
  const records = [];
  let bytes = 0;
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        records.push({ kind: "directory", path: relative });
        await visit(absolute);
      } else if (entry.isFile()) {
        const metadata = await stat(absolute);
        const sha256 = await sha256File(absolute);
        bytes += metadata.size;
        records.push({ kind: "file", path: relative, bytes: metadata.size, sha256 });
      } else if (entry.isSymbolicLink()) {
        records.push({ kind: "symlink", path: relative, target: await readlink(absolute) });
      } else {
        throw new Error(`unsupported app bundle entry: ${relative}`);
      }
    }
  };
  await visit(directory);
  return { bytes, sha256: sha256Bytes(JSON.stringify(records)) };
}

async function collectInstallerArtifacts(directory, releaseDirectory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const artifacts = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && path.extname(entry.name).toLocaleLowerCase("en-US") === ".app") {
      artifacts.push({
        kind: "app-bundle",
        path: path.relative(releaseDirectory, absolute).split(path.sep).join("/"),
        ...(await hashAppBundle(absolute)),
      });
    } else if (entry.isDirectory()) {
      artifacts.push(...(await collectInstallerArtifacts(absolute, releaseDirectory)));
    } else if (
      entry.isFile() &&
      INSTALLER_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase("en-US"))
    ) {
      const metadata = await stat(absolute);
      artifacts.push({
        kind: "file",
        path: path.relative(releaseDirectory, absolute).split(path.sep).join("/"),
        bytes: metadata.size,
        sha256: await sha256File(absolute),
      });
    }
  }
  return artifacts;
}

function ignoredRepositoryRelativePaths(repositoryRoot, paths) {
  return new Set(
    paths.map((file) => {
      const absolute = path.resolve(file);
      const relative = path.relative(repositoryRoot, absolute);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error("ignored untracked path must be a file inside the repository");
      }
      return relative.split(path.sep).join("/");
    })
  );
}

export async function collectGitMetadata(repositoryRoot, { ignoredUntrackedPaths = [] } = {}) {
  const [
    { stdout: commit },
    { stdout: statusOutput },
    { stdout: trackedDiff },
    { stdout: untrackedOutput },
  ] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }),
    execFileAsync("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: repositoryRoot,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repositoryRoot,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const revision = commit.trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("git did not return a full commit hash");
  const ignored = ignoredRepositoryRelativePaths(repositoryRoot, ignoredUntrackedPaths);
  const normalizedStatus = statusOutput
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => !line.startsWith("?? ") || !ignored.has(line.slice(3)))
    .join("\n");
  const stateDigest = createHash("sha256")
    .update("aio-repository-state-v2\0")
    .update(normalizedStatus)
    .update("\0tracked-diff\0")
    .update(trackedDiff)
    .update("\0untracked\0");
  const untrackedPaths = untrackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((relative) => !ignored.has(relative.split(path.sep).join("/")))
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const relative of untrackedPaths) {
    const absolute = path.resolve(repositoryRoot, relative);
    const withinRepository = path.relative(repositoryRoot, absolute);
    if (
      withinRepository === "" ||
      withinRepository === ".." ||
      withinRepository.startsWith(`..${path.sep}`)
    ) {
      throw new Error("git returned an untracked path outside the repository");
    }
    const metadata = await lstat(absolute);
    const canonicalRelative = relative.split(path.sep).join("/");
    stateDigest.update(`${canonicalRelative}\0`);
    if (metadata.isFile()) {
      stateDigest.update(`file\0${metadata.size}\0`).update(await readFile(absolute));
    } else if (metadata.isSymbolicLink()) {
      stateDigest.update("symlink\0").update(await readlink(absolute));
    } else {
      throw new Error(`unsupported untracked repository entry: ${canonicalRelative}`);
    }
    stateDigest.update("\0");
  }
  return {
    commit: revision.toLowerCase(),
    dirty: normalizedStatus.trim().length > 0,
    statusSha256: stateDigest.digest("hex"),
  };
}

export async function collectReleaseArtifacts(repositoryRoot, executable) {
  const executablePath = path.resolve(executable);
  const releaseDirectory = path.dirname(executablePath);
  const executableStats = await stat(executablePath);
  if (!executableStats.isFile()) throw new Error("release executable is not a regular file");
  const installers = await collectInstallerArtifacts(
    path.join(releaseDirectory, "bundle"),
    releaseDirectory
  );
  installers.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    executablePath: repositoryRelativePath(repositoryRoot, executablePath),
    executableFile: path.basename(executablePath),
    executableBytes: executableStats.size,
    executableSha256: await sha256File(executablePath),
    installers,
  };
}

async function readPackageMetadata(repositoryRoot) {
  const packageBytes = await readFile(path.join(repositoryRoot, "package.json"));
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json must contain a non-empty version");
  }
  return {
    version: packageJson.version,
    packageJsonSha256: sha256Bytes(packageBytes),
  };
}

async function assertBuildConfigurationFiles(repositoryRoot, buildConfiguration) {
  const overlay = buildConfiguration?.configOverlay;
  if (overlay == null) return;
  if (
    typeof overlay.path !== "string" ||
    overlay.path.length === 0 ||
    !/^[0-9a-f]{64}$/.test(overlay.sha256)
  ) {
    throw new Error("release build config overlay metadata is invalid");
  }
  const absolute = path.resolve(repositoryRoot, ...overlay.path.split("/"));
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("release build config overlay must stay inside the repository");
  }
  if (sha256Bytes(await readFile(absolute)) !== overlay.sha256) {
    throw new Error("release build config overlay changed during build");
  }
}

export async function collectReleaseBuildInputs({
  repositoryRoot,
  profile,
  target,
  buildConfiguration,
}) {
  if (typeof profile !== "string" || profile.length === 0) {
    throw new Error("release build profile is required");
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("release build target is required");
  }
  await assertBuildConfigurationFiles(repositoryRoot, buildConfiguration);
  const [repository, packageMetadata] = await Promise.all([
    collectGitMetadata(repositoryRoot),
    readPackageMetadata(repositoryRoot),
  ]);
  return {
    profile,
    target,
    build: structuredClone(buildConfiguration),
    repository,
    package: packageMetadata,
  };
}

export async function writeReleaseBuildManifest({ repositoryRoot, executable, buildInputs }) {
  const currentInputs = await collectReleaseBuildInputs({
    repositoryRoot,
    profile: buildInputs?.profile,
    target: buildInputs?.target,
    buildConfiguration: buildInputs?.build,
  });
  assertExactEvidence(
    "repository changed during build",
    buildInputs.repository,
    currentInputs.repository
  );
  assertExactEvidence(
    "package metadata changed during build",
    buildInputs.package,
    currentInputs.package
  );
  assertExactEvidence(
    "build configuration changed during build",
    buildInputs.build,
    currentInputs.build
  );
  const releaseArtifacts = await collectReleaseArtifacts(repositoryRoot, executable);
  const manifest = {
    schemaVersion: 1,
    producer: "scripts/tauri-build.mjs",
    profile: buildInputs.profile,
    target: buildInputs.target,
    build: buildInputs.build,
    repository: buildInputs.repository,
    package: buildInputs.package,
    executable: {
      file: releaseArtifacts.executableFile,
      bytes: releaseArtifacts.executableBytes,
      sha256: releaseArtifacts.executableSha256,
    },
    installers: releaseArtifacts.installers,
  };
  await writeFile(releaseBuildManifestPath(executable), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  return manifest;
}

function assertExactEvidence(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} does not match the build manifest`);
  }
}

export async function collectFormalReleaseProvenance({
  repositoryRoot,
  executable,
  ignoredUntrackedPaths = [],
}) {
  await assertFormalReleaseLocation(repositoryRoot, executable);
  const manifestPath = releaseBuildManifestPath(executable);
  const [manifestBytes, repository, packageMetadata, releaseArtifacts] = await Promise.all([
    readFile(manifestPath),
    collectGitMetadata(repositoryRoot, { ignoredUntrackedPaths }),
    readPackageMetadata(repositoryRoot),
    collectReleaseArtifacts(repositoryRoot, executable),
  ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`parse release build manifest: ${error.message}`);
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.producer !== "scripts/tauri-build.mjs" ||
    typeof manifest?.target !== "string" ||
    manifest.target.length === 0
  ) {
    throw new Error("release build manifest identity is invalid");
  }
  if (manifest.profile !== "release") {
    throw new Error("formal baseline requires a release profile build manifest");
  }
  const expectedTarget = supportedHostTarget();
  if (expectedTarget == null) {
    throw new Error(`formal baseline does not support host ${process.platform}/${process.arch}`);
  }
  if (manifest.target !== expectedTarget) {
    throw new Error(
      `release build manifest target ${manifest.target} does not match host target ${expectedTarget}`
    );
  }
  const expectedBundles = expectedBundlesForTarget(expectedTarget);
  if (
    manifest.build?.formalCompatible !== true ||
    manifest.build?.bundles !== expectedBundles ||
    !Object.hasOwn(manifest.build, "configOverlay")
  ) {
    throw new Error(
      "release build manifest does not describe the canonical formal build arguments"
    );
  }
  let configOverlaySha256 = null;
  if (manifest.build.configOverlay != null) {
    const overlay = manifest.build.configOverlay;
    if (
      overlay?.path !== ".local/tauri.build.local.json" ||
      !/^[0-9a-f]{64}$/.test(overlay.sha256)
    ) {
      throw new Error("release build manifest config overlay metadata is invalid");
    }
    const overlayBytes = await readFile(path.join(repositoryRoot, ...overlay.path.split("/")));
    if (sha256Bytes(overlayBytes) !== overlay.sha256) {
      throw new Error("release build config overlay changed since build");
    }
    let overlayValue;
    try {
      overlayValue = JSON.parse(overlayBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`parse release build config overlay: ${error.message}`);
    }
    if (
      JSON.stringify(overlayValue) !== JSON.stringify({ bundle: { createUpdaterArtifacts: false } })
    ) {
      throw new Error("release build config overlay is not the canonical local overlay");
    }
    configOverlaySha256 = overlay.sha256;
  }
  if (!Array.isArray(manifest.installers) || manifest.installers.length === 0) {
    throw new Error("formal baseline requires at least one installer in the build manifest");
  }
  assertExactEvidence("package metadata changed since build", manifest.package, packageMetadata);
  assertExactEvidence("repository state changed since build", manifest.repository, repository);
  assertExactEvidence("release executable", manifest.executable, {
    file: releaseArtifacts.executableFile,
    bytes: releaseArtifacts.executableBytes,
    sha256: releaseArtifacts.executableSha256,
  });
  assertExactEvidence("release installers", manifest.installers, releaseArtifacts.installers);
  return {
    repository,
    packageVersion: packageMetadata.version,
    packageJsonSha256: packageMetadata.packageJsonSha256,
    releaseArtifacts,
    buildManifest: {
      path: repositoryRelativePath(repositoryRoot, manifestPath),
      sha256: sha256Bytes(manifestBytes),
      profile: manifest.profile,
      target: manifest.target,
      producer: manifest.producer,
      configOverlaySha256,
    },
  };
}
