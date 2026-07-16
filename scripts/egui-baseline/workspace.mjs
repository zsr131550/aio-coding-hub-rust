import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const fixtureRoot = path.join(repoRoot, "src-tauri", "tests", "fixtures", "egui-migration");
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PASSTHROUGH_ENVIRONMENT_KEYS = new Set([
  "ALLUSERSPROFILE",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]);

function canonicalPath(value) {
  return path.resolve(value).toLocaleLowerCase("en-US");
}

export function assertIsolatedHome(candidate, realHome = os.homedir()) {
  if (!path.isAbsolute(candidate)) throw new Error("benchmark home must be absolute");
  if (canonicalPath(candidate) === canonicalPath(realHome)) {
    throw new Error("benchmark home must not be the real user home");
  }
}

export function buildIsolatedProcessEnvironment(
  home,
  baseEnvironment = process.env,
  realHome = os.homedir()
) {
  assertIsolatedHome(home, realHome);
  if (!path.isAbsolute(realHome)) throw new Error("real user home must be absolute");

  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const normalized = key.toUpperCase();
    if (PASSTHROUGH_ENVIRONMENT_KEYS.has(normalized)) {
      environment[key] = value;
    }
  }

  return {
    ...environment,
    AIO_CODING_HUB_BENCHMARK_REAL_HOME: realHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    TMPDIR: path.join(home, "tmp"),
  };
}

async function preparedFixtureMetadata(appData, requestLogs = null) {
  const artifacts = {};
  for (const name of ["aio-coding-hub.db", "settings.json"]) {
    const file = path.join(appData, name);
    try {
      const bytes = await readFile(file);
      artifacts[name] = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (requestLogs) {
    const bytes = await readFile(requestLogs.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== requestLogs.sha256) {
      throw new Error("copied request-log fixture hash does not match metadata");
    }
    artifacts["request-logs-10000.jsonl"] = {
      bytes: bytes.length,
      sha256,
      rowCount: requestLogs.rowCount,
    };
  }
  const digestInput = Object.entries(artifacts)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, metadata]) => `${name}\u0000${metadata.sha256}`)
    .join("\n");
  return {
    artifacts,
    sha256: createHash("sha256").update(digestInput).digest("hex"),
  };
}

export async function createRunWorkspace({ root, runId, fixture, scenario }) {
  if (!path.isAbsolute(root)) throw new Error("benchmark workspace root must be absolute");
  if (!SAFE_RUN_ID.test(runId)) throw new Error("invalid benchmark run id");
  if (!new Set(["fresh", "v25", "current"]).has(fixture)) {
    throw new Error(`unsupported benchmark fixture: ${fixture}`);
  }

  const runRoot = path.join(root, runId);
  const home = path.join(runRoot, "home");
  assertIsolatedHome(home);
  const appData = path.join(home, ".aio-coding-hub");
  const reportDir = path.join(home, ".aio-benchmark");
  const webviewData = path.join(reportDir, "webview");
  await Promise.all(
    [
      appData,
      reportDir,
      webviewData,
      path.join(home, "AppData", "Roaming"),
      path.join(home, "AppData", "Local"),
      path.join(home, ".config"),
      path.join(home, ".local", "share"),
      path.join(home, ".cache"),
      path.join(home, "tmp"),
      path.join(home, ".codex"),
    ].map((directory) => mkdir(directory, { recursive: true }))
  );
  await writeFile(
    path.join(home, ".aio-benchmark-home.json"),
    `${JSON.stringify({ schemaVersion: 1, runId }, null, 2)}\n`,
    { flag: "wx" }
  );

  if (fixture !== "fresh") {
    const sourceDir = path.join(
      fixtureRoot,
      "data",
      fixture === "v25" ? "sqlite-v25" : "sqlite-current"
    );
    const sourceDb = path.join(sourceDir, "aio-coding-hub.db");
    if (!(await stat(sourceDb)).isFile()) throw new Error(`missing fixture database: ${sourceDb}`);
    await cp(sourceDb, path.join(appData, "aio-coding-hub.db"));

    const settings = JSON.parse(
      await readFile(path.join(fixtureRoot, "settings", "settings-current.json"), "utf8")
    );
    if (scenario === "hidden-tray") settings.start_minimized = true;
    await writeFile(path.join(appData, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  } else if (scenario === "hidden-tray") {
    throw new Error("hidden-tray requires the current or v25 settings fixture");
  }

  let requestLogs = null;
  if (scenario === "logs-10k") {
    const metadata = JSON.parse(
      await readFile(path.join(fixtureRoot, "request-logs", "metadata.json"), "utf8")
    );
    if (
      metadata.schemaVersion !== 1 ||
      metadata.rowCount !== 10_000 ||
      !/^[0-9a-f]{64}$/.test(metadata.sha256)
    ) {
      throw new Error("request-log fixture metadata is invalid");
    }
    const fixtureDirectory = path.join(reportDir, "fixtures");
    await mkdir(fixtureDirectory, { recursive: true });
    const fixturePath = path.join(fixtureDirectory, "request-logs-10000.jsonl");
    await cp(path.join(fixtureRoot, "request-logs", "request-logs-10000.jsonl"), fixturePath);
    requestLogs = {
      path: fixturePath,
      sha256: metadata.sha256,
      rowCount: metadata.rowCount,
    };
  }

  const reportPath = path.join(reportDir, "milestones.jsonl");
  const fixtureMetadata = await preparedFixtureMetadata(appData, requestLogs);
  return {
    runRoot,
    home,
    appData,
    webviewData,
    reportPath,
    requestLogs,
    fixtureArtifacts: fixtureMetadata.artifacts,
    fixtureHash: fixtureMetadata.sha256,
  };
}

export async function reuseRunWorkspace(workspace, runId) {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("invalid benchmark run id");
  assertIsolatedHome(workspace.home);
  await writeFile(
    path.join(workspace.home, ".aio-benchmark-home.json"),
    `${JSON.stringify({ schemaVersion: 1, runId }, null, 2)}\n`
  );
  return {
    ...workspace,
    reportPath: path.join(workspace.home, ".aio-benchmark", `${runId}.jsonl`),
  };
}

export { fixtureRoot, repoRoot };
