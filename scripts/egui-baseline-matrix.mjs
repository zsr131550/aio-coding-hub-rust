import { createHash } from "node:crypto";
import { COPYFILE_EXCL } from "node:constants";
import { copyFile, lstat, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateCompleteBaselineResult } from "./egui-baseline/result.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const formalBaselineStagingRoot = path.join(repositoryRoot, ".local", "egui-baselines");
export const formalBaselineRegistryRoot = path.join(
  repositoryRoot,
  "docs",
  "egui-migration",
  "baselines"
);

export const FORMAL_BASELINE_SCENARIOS = Object.freeze([
  "startup-cold-process",
  "startup-warm-process",
  "first-interactive",
  "visible-idle",
  "hidden-tray",
  "logs-10k",
  "gateway-load",
]);

function requireFileNameSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} cannot be represented in a formal baseline filename`);
  }
  return value;
}

function expectedResultFileName(value) {
  const platform = requireFileNameSegment(value.environment.platform, "platform");
  const arch = requireFileNameSegment(value.environment.arch, "architecture");
  const scenario = requireFileNameSegment(value.scenario.id, "scenario");
  const version = requireFileNameSegment(value.app.version, "app version");
  return `tauri-${platform}-${arch}-${scenario}-${version}.json`;
}

function buildIdentity(value) {
  return {
    platform: value.environment.platform,
    arch: value.environment.arch,
    version: value.app.version,
    repository: {
      commit: value.repository.commit,
      dirty: value.repository.dirty,
      statusSha256: value.repository.statusSha256,
    },
    executableSha256: value.app.executableSha256,
    buildProvenanceSha256: value.app.buildProvenance.sha256,
    protocol: {
      warmups: value.protocol.warmups,
      runs: value.protocol.runs,
      sampleIntervalMs: value.protocol.sampleIntervalMs,
      processTree: value.protocol.processTree,
      percentile: value.protocol.percentile,
      median: value.protocol.median,
    },
    machine: {
      osRelease: value.environment.osRelease,
      kernelType: value.environment.kernelType,
      cpuModel: value.environment.cpuModel,
      logicalCpuCount: value.environment.logicalCpuCount,
      totalMemoryBytes: value.environment.totalMemoryBytes,
      nodeVersion: value.environment.nodeVersion,
      locale: value.environment.locale,
      timezone: value.environment.timezone,
      gpuRenderer: value.environment.gpuRenderer,
      webViewRuntime: value.environment.webViewRuntime,
      power: value.environment.power,
      processMetrics: value.environment.processMetrics,
    },
    fixture: {
      databaseSha256: value.scenario.fixtureArtifacts?.["aio-coding-hub.db"]?.sha256,
    },
  };
}

function assertCanonicalSettingsIdentity(entries, label) {
  let expectedSha256 = null;
  for (const entry of entries) {
    if (entry.scenario === "hidden-tray") continue;
    const sha256 = entry.value.scenario.fixtureArtifacts?.["settings.json"]?.sha256;
    if (expectedSha256 == null) {
      expectedSha256 = sha256;
    } else if (sha256 !== expectedSha256) {
      throw new Error(`${label} mixes build identities: ${entry.fileName}`);
    }
  }
}

async function readValidatedResults({ root, label, validateResult }) {
  const directoryEntries = await readdir(root, { withFileTypes: true });
  const inProgress = directoryEntries.filter((entry) =>
    entry.name.toLowerCase().endsWith(".json.inprogress")
  );
  if (inProgress.length > 0) {
    throw new Error(
      `${label} contains an in-progress baseline marker: ${inProgress
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"))
        .join(", ")}`
    );
  }
  const jsonEntries = directoryEntries.filter(
    (entry) => path.extname(entry.name).toLowerCase() === ".json"
  );
  const nonFiles = jsonEntries.filter((entry) => !entry.isFile());
  if (nonFiles.length > 0) {
    throw new Error(
      `baseline JSON entry must be a regular file: ${nonFiles
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"))
        .join(", ")}`
    );
  }
  const resultFiles = jsonEntries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const validated = [];

  for (const resultFile of resultFiles) {
    const source = path.join(root, resultFile.name);
    let bytes;
    let value;
    try {
      bytes = await readFile(source);
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`failed to parse baseline result ${resultFile.name}: ${error.message}`, {
        cause: error,
      });
    }
    await validateResult(value);
    const expectedFileName = expectedResultFileName(value);
    if (resultFile.name !== expectedFileName) {
      throw new Error(
        `baseline filename does not match validated result: expected ${expectedFileName}, received ${resultFile.name}`
      );
    }
    validated.push({
      fileName: resultFile.name,
      source,
      scenario: value.scenario.id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      value,
    });
  }
  return validated;
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removePaths(paths, unlinkFile = unlink) {
  const failures = [];
  for (const candidate of paths) {
    try {
      await unlinkFile(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to roll back baseline matrix promotion");
  }
}

async function fileSha256(candidate) {
  const stats = await lstat(candidate);
  if (!stats.isFile()) {
    throw new Error(`baseline matrix path is not a regular file: ${candidate}`);
  }
  return createHash("sha256")
    .update(await readFile(candidate))
    .digest("hex");
}

async function requireExpectedSha256(candidate, expected, label) {
  if ((await fileSha256(candidate)) !== expected) {
    throw new Error(`${label} does not match its preflight SHA-256: ${candidate}`);
  }
}

async function restoreAndVerifyStagingMatrix(entries, fileSystem) {
  const failures = [];
  for (const entry of entries) {
    try {
      try {
        await requireExpectedSha256(entry.source, entry.sha256, "staging result");
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      await requireExpectedSha256(entry.destination, entry.sha256, "published result");
      await fileSystem.copyFile(entry.destination, entry.source, COPYFILE_EXCL);
      await requireExpectedSha256(entry.source, entry.sha256, "restored staging result");
    } catch (error) {
      failures.push(
        new Error(`failed to restore validated staging result: ${entry.fileName}`, { cause: error })
      );
    }
  }
  return failures;
}

export async function preflightBaselineMatrix({
  stagingRoot,
  registryRoot,
  validateResult = validateCompleteBaselineResult,
}) {
  const validated = (
    await readValidatedResults({
      root: stagingRoot,
      label: "formal baseline staging",
      validateResult,
    })
  ).map((entry) => ({
    ...entry,
    destination: path.join(registryRoot, entry.fileName),
  }));

  const byScenario = new Map();
  for (const entry of validated) {
    if (byScenario.has(entry.scenario)) {
      throw new Error(`duplicate formal baseline scenario: ${entry.scenario}`);
    }
    byScenario.set(entry.scenario, entry);
  }
  const missing = FORMAL_BASELINE_SCENARIOS.filter((scenario) => !byScenario.has(scenario));
  const unexpected = [...byScenario.keys()].filter(
    (scenario) => !FORMAL_BASELINE_SCENARIOS.includes(scenario)
  );
  if (missing.length > 0 || unexpected.length > 0 || validated.length !== 7) {
    throw new Error(
      `formal baseline matrix must contain each required scenario exactly once; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`
    );
  }

  const identity = buildIdentity(validated[0].value);
  for (const entry of validated.slice(1)) {
    if (JSON.stringify(buildIdentity(entry.value)) !== JSON.stringify(identity)) {
      throw new Error(`formal baseline matrix mixes build identities: ${entry.fileName}`);
    }
  }
  assertCanonicalSettingsIdentity(validated, "formal baseline matrix");

  const collisions = [];
  for (const entry of validated) {
    if (await pathExists(entry.destination)) collisions.push(entry.destination);
  }
  if (collisions.length > 0) {
    throw new Error(
      `baseline registry destination already exists: ${collisions
        .sort((left, right) => left.localeCompare(right, "en"))
        .join(", ")}`
    );
  }

  return {
    identity,
    entries: FORMAL_BASELINE_SCENARIOS.map((scenario) => byScenario.get(scenario)),
  };
}

export async function validateBaselineRegistry({
  registryRoot,
  validateResult = validateCompleteBaselineResult,
}) {
  const validated = await readValidatedResults({
    root: registryRoot,
    label: "baseline registry",
    validateResult,
  });
  const grouped = new Map();
  for (const entry of validated) {
    const identity = buildIdentity(entry.value);
    const key = JSON.stringify(identity);
    const group = grouped.get(key) ?? { identity, entries: [] };
    group.entries.push(entry);
    grouped.set(key, group);
  }

  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, group]) => {
      const byScenario = new Map();
      for (const entry of group.entries) {
        if (byScenario.has(entry.scenario)) {
          throw new Error(
            `registry group contains duplicate scenario ${entry.scenario}: ${entry.fileName}`
          );
        }
        byScenario.set(entry.scenario, entry);
      }
      const missing = FORMAL_BASELINE_SCENARIOS.filter((scenario) => !byScenario.has(scenario));
      const unexpected = [...byScenario.keys()].filter(
        (scenario) => !FORMAL_BASELINE_SCENARIOS.includes(scenario)
      );
      if (missing.length > 0 || unexpected.length > 0 || group.entries.length !== 7) {
        throw new Error(
          `registry group must contain each required scenario exactly once; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`
        );
      }
      assertCanonicalSettingsIdentity(group.entries, "registry group");
      return {
        identity: group.identity,
        entries: FORMAL_BASELINE_SCENARIOS.map((scenario) => byScenario.get(scenario)),
      };
    });

  return { groups, resultCount: validated.length };
}

export async function promoteBaselineMatrix(options) {
  const matrix = await preflightBaselineMatrix(options);
  const fileSystem = {
    copyFile: options.fileSystem?.copyFile ?? copyFile,
    unlink: options.fileSystem?.unlink ?? unlink,
  };
  const publishedDestinations = [];

  try {
    for (const entry of matrix.entries) {
      await fileSystem.copyFile(entry.source, entry.destination, COPYFILE_EXCL);
      publishedDestinations.push(entry.destination);
    }
    for (const entry of matrix.entries) {
      await requireExpectedSha256(
        entry.destination,
        entry.sha256,
        `baseline result changed after preflight validation: ${entry.fileName}; published result`
      );
    }
  } catch (error) {
    try {
      await removePaths([...publishedDestinations].reverse(), fileSystem.unlink);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "baseline matrix promotion failed while publishing destinations"
      );
    }
    throw error;
  }

  try {
    for (const entry of matrix.entries) {
      try {
        await fileSystem.unlink(entry.source);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    const rollbackFailures = await restoreAndVerifyStagingMatrix(matrix.entries, fileSystem);
    if (rollbackFailures.length === 0) {
      try {
        await removePaths([...publishedDestinations].reverse(), fileSystem.unlink);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "baseline matrix promotion failed while removing staging sources"
      );
    }
    throw error;
  }

  return matrix;
}

export function parseMatrixArgs(args) {
  const cliArgs = args[0] === "--" ? args.slice(1) : args;
  if (cliArgs.length === 0) return { promote: false };
  if (cliArgs.length === 1 && cliArgs[0] === "--promote") return { promote: true };
  if (cliArgs.length === 1 && cliArgs[0] === "--check-registry") {
    return { promote: false, checkRegistry: true };
  }
  const allowed = new Set(["--promote", "--check-registry"]);
  const unknown = cliArgs.find((argument) => !allowed.has(argument));
  if (unknown != null) throw new Error(`unknown matrix argument: ${unknown}`);
  if (cliArgs.includes("--promote") && cliArgs.includes("--check-registry")) {
    throw new Error("matrix command accepts one mode");
  }
  throw new Error("matrix command accepts only --promote");
}

export async function runMatrixCommand(
  options,
  {
    preflightImpl = preflightBaselineMatrix,
    promoteImpl = promoteBaselineMatrix,
    validateRegistryImpl = validateBaselineRegistry,
  } = {}
) {
  const paths = {
    stagingRoot: formalBaselineStagingRoot,
    registryRoot: formalBaselineRegistryRoot,
  };
  if (options.checkRegistry) {
    return validateRegistryImpl({ registryRoot: paths.registryRoot });
  }
  return options.promote ? promoteImpl(paths) : preflightImpl(paths);
}

async function main() {
  const options = parseMatrixArgs(process.argv.slice(2));
  const matrix = await runMatrixCommand(options);
  if (options.checkRegistry) {
    console.log(
      `[egui-baseline-matrix] validated ${matrix.resultCount} registry results in ${matrix.groups.length} complete groups`
    );
    return;
  }
  const action = options.promote ? "promoted" : "validated";
  console.log(
    `[egui-baseline-matrix] ${action} ${matrix.entries.length} results for ${matrix.identity.platform}/${matrix.identity.arch} ${matrix.identity.version}`
  );
}

const isMain =
  process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`[egui-baseline-matrix] ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
