import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectFormalReleaseProvenance } from "./egui-baseline/release-provenance.mjs";
import { validateBaselineResult } from "./egui-baseline/result.mjs";
import { runBaseline } from "./egui-baseline/runner.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const formalBaselineStagingRoot = path.join(repositoryRoot, ".local", "egui-baselines");

const scenarios = new Set([
  "startup-cold-process",
  "startup-warm-process",
  "first-interactive",
  "visible-idle",
  "hidden-tray",
  "logs-10k",
  "gateway-load",
]);
const fixtures = new Set(["fresh", "v25", "current"]);

function requireAbsolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}

function requireBaselineOutput(value) {
  const output = requireAbsolute(value, "output");
  if (path.extname(output).toLocaleLowerCase("en-US") !== ".json") {
    throw new Error("output must be a .json file");
  }
  return output;
}

function requireFormalBaselineOutput(value) {
  const output = requireBaselineOutput(value);
  const relative = path.relative(formalBaselineStagingRoot, output);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "."
  ) {
    throw new Error(
      "formal output must be a direct child of the gitignored .local/egui-baselines staging directory"
    );
  }
  return output;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function parseBaselineArgs(args) {
  const cliArgs = args[0] === "--" ? args.slice(1) : args;
  const values = {};
  for (let index = 0; index < cliArgs.length; index += 2) {
    const flag = cliArgs[index];
    const value = cliArgs[index + 1];
    if (!flag?.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    if (values[flag] != null) throw new Error(`duplicate argument: ${flag}`);
    values[flag] = value;
  }
  const allowed = new Set([
    "--executable",
    "--fixture",
    "--scenario",
    "--warmups",
    "--runs",
    "--output",
    "--duration-ms",
    "--sample-interval-ms",
  ]);
  for (const flag of Object.keys(values)) {
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
  }

  const executable = requireAbsolute(values["--executable"] ?? "", "executable");
  const executableSegments = executable.split(/[\\/]/).map((segment) => segment.toLowerCase());
  if (!executableSegments.includes("release")) {
    throw new Error("benchmark requires a release executable path");
  }
  const fixture = values["--fixture"];
  if (!fixtures.has(fixture)) throw new Error(`unsupported fixture: ${fixture}`);
  if (fixture !== "current") throw new Error("formal benchmark requires the current fixture");
  const scenario = values["--scenario"];
  if (!scenarios.has(scenario)) throw new Error(`unsupported scenario: ${scenario}`);
  const warmups = parsePositiveInteger(values["--warmups"], "warmups");
  if (warmups < 2) throw new Error("formal benchmark requires at least 2 warmups");
  const runs = parsePositiveInteger(values["--runs"], "runs");
  if (runs < 10) throw new Error("formal benchmark requires at least 10 runs");
  const output = requireFormalBaselineOutput(values["--output"] ?? "");
  if (output === executable) throw new Error("output must not overwrite the executable");
  const durationMs = values["--duration-ms"]
    ? parsePositiveInteger(values["--duration-ms"], "duration-ms")
    : null;
  if (durationMs != null && durationMs > 1_800_000) {
    throw new Error("duration-ms must not exceed 1800000");
  }
  const formalDurationMs =
    scenario === "visible-idle" ? 60_000 : scenario === "hidden-tray" ? 600_000 : null;
  if (durationMs != null && formalDurationMs == null) {
    throw new Error("duration-ms is only allowed for formal idle scenarios");
  }
  if (durationMs != null && durationMs !== formalDurationMs) {
    throw new Error(`formal ${scenario} duration-ms must be ${formalDurationMs}`);
  }
  const sampleIntervalMs = values["--sample-interval-ms"]
    ? parsePositiveInteger(values["--sample-interval-ms"], "sample-interval-ms")
    : 1_000;
  if (sampleIntervalMs < 100 || sampleIntervalMs > 10_000) {
    throw new Error("sample-interval-ms must be between 100 and 10000");
  }
  return { executable, fixture, scenario, warmups, runs, output, durationMs, sampleIntervalMs };
}

export function baselineInProgressPath(output) {
  const normalizedOutput = requireBaselineOutput(output);
  const parent = path.dirname(normalizedOutput);
  const marker = path.join(parent, `${path.basename(normalizedOutput)}.inprogress`);
  if (path.dirname(marker) !== parent) {
    throw new Error("in-progress marker must remain beside the output");
  }
  return marker;
}

async function assertPathDoesNotExist(target, label) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${target}`);
}

async function unlinkIfExists(target) {
  try {
    await unlink(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeExclusiveFile(target, contents, mode = 0o600) {
  const handle = await open(target, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlinkIfExists(target).catch(() => {});
    throw error;
  }
  await handle.close();
}

async function createInProgressMarker(options) {
  const output = requireBaselineOutput(options.output);
  const markerPath = baselineInProgressPath(output);
  await mkdir(path.dirname(output), { recursive: true });
  await assertPathDoesNotExist(output, "baseline output");
  const owner = randomUUID();
  const marker = {
    schemaVersion: 1,
    kind: "egui-baseline-in-progress",
    owner,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    outputFile: path.basename(output),
    executableFile: path.basename(options.executable),
    scenario: options.scenario,
    fixture: options.fixture,
    warmups: options.warmups,
    runs: options.runs,
    durationMs: options.durationMs,
    sampleIntervalMs: options.sampleIntervalMs,
  };
  try {
    await writeExclusiveFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`in-progress marker already exists: ${markerPath}`, { cause: error });
    }
    throw error;
  }

  try {
    await assertPathDoesNotExist(output, "baseline output");
  } catch (error) {
    await removeOwnedMarker({ markerPath, owner });
    throw error;
  }
  return { output, markerPath, owner };
}

async function removeOwnedMarker(transaction) {
  const marker = JSON.parse(await readFile(transaction.markerPath, "utf8"));
  if (marker.kind !== "egui-baseline-in-progress" || marker.owner !== transaction.owner) {
    throw new Error(`in-progress marker ownership changed: ${transaction.markerPath}`);
  }
  await unlink(transaction.markerPath);
}

async function writeResult(output, result) {
  validateBaselineResult(result);
  const normalizedOutput = requireBaselineOutput(output);
  const parent = path.dirname(normalizedOutput);
  const temporary = path.join(
    parent,
    `.${path.basename(normalizedOutput)}.${process.pid}-${randomUUID()}.tmp`
  );
  await mkdir(parent, { recursive: true });
  try {
    await writeExclusiveFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 0o644);
    // A same-directory hard link publishes the complete inode without replacing an existing result.
    await link(temporary, normalizedOutput);
  } finally {
    await unlinkIfExists(temporary);
  }
}

export async function runBaselineCommand(
  options,
  {
    runBaselineImpl = runBaseline,
    collectReleaseProvenanceImpl = ({ executable }) =>
      collectFormalReleaseProvenance({ repositoryRoot, executable }),
  } = {}
) {
  const output = requireBaselineOutput(options.output);
  await assertPathDoesNotExist(output, "baseline output");
  await assertPathDoesNotExist(baselineInProgressPath(output), "in-progress marker");
  const releaseProvenance = await collectReleaseProvenanceImpl(options);
  const transaction = await createInProgressMarker(options);
  try {
    const result = await runBaselineImpl({
      ...options,
      releaseProvenance,
      inProgressMarker: transaction.markerPath,
    });
    await writeResult(transaction.output, result);
    await removeOwnedMarker(transaction);
    return result;
  } catch (error) {
    throw new Error(
      `${error?.message ?? error}; in-progress marker retained at ${transaction.markerPath}`,
      { cause: error }
    );
  }
}

async function main() {
  const options = parseBaselineArgs(process.argv.slice(2));
  const result = await runBaselineCommand(options);
  console.log(
    `[egui-baseline] wrote ${options.output} (${result.rawRuns.length} runs, ${result.failures.length} failures)`
  );
  if (result.failures.length > 0) process.exitCode = 1;
}

const isMain =
  process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`[egui-baseline] ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}

export { writeResult };
