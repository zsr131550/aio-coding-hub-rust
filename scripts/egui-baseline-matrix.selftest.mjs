import assert from "node:assert/strict";
import {
  copyFile as fsCopyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink as fsUnlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FORMAL_BASELINE_SCENARIOS,
  parseMatrixArgs,
  preflightBaselineMatrix,
  promoteBaselineMatrix,
  runMatrixCommand,
  validateBaselineRegistry,
} from "./egui-baseline-matrix.mjs";

const EXPECTED_SCENARIOS = [
  "startup-cold-process",
  "startup-warm-process",
  "first-interactive",
  "visible-idle",
  "hidden-tray",
  "logs-10k",
  "gateway-load",
];

async function snapshotDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map(async (entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        bytes: entry.isFile() ? await readFile(path.join(directory, entry.name), "utf8") : null,
      }))
  );
}

function syntheticResult(
  scenario,
  { platform = "win32", arch = "x64", version = "0.60.13", buildSeed = "a" } = {}
) {
  return {
    status: "complete",
    scenario: {
      id: scenario,
      fixtureArtifacts: {
        "aio-coding-hub.db": { sha256: "1".repeat(64) },
        "settings.json": { sha256: "2".repeat(64) },
      },
    },
    environment: { platform, arch },
    protocol: {
      warmups: 2,
      runs: 10,
      sampleIntervalMs: 1_000,
      processTree: "pid-birth-image identity descendants; retained after reparent",
      percentile: "nearest-rank",
      median: "midpoint for even sample counts",
    },
    app: {
      version,
      executableSha256: buildSeed.repeat(64),
      buildProvenance: { sha256: "b".repeat(64) },
    },
    repository: {
      commit: "c".repeat(40),
      dirty: true,
      statusSha256: buildSeed.repeat(64),
    },
  };
}

async function writeSyntheticMatrix(stagingRoot, options = {}) {
  for (const scenario of EXPECTED_SCENARIOS) {
    const result = syntheticResult(scenario, options);
    const fileName = `tauri-${result.environment.platform}-${result.environment.arch}-${scenario}-${result.app.version}.json`;
    await writeFile(
      path.join(stagingRoot, fileName),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8"
    );
  }
}

async function createMatrixCase(name) {
  const root = path.join(tempRoot, name);
  const stagingRoot = path.join(root, "staging");
  const registryRoot = path.join(root, "registry");
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  await writeFile(path.join(registryRoot, "README.md"), "registry\n", "utf8");
  await writeSyntheticMatrix(stagingRoot);
  return { stagingRoot, registryRoot };
}

async function readJsonBytesByName(root) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(root))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => [name, await readFile(path.join(root, name), "utf8")])
    )
  );
}

function acceptSyntheticResult(value) {
  assert.equal(value.status, "complete");
  return value;
}

function unsupportedTargetProbe() {
  return {
    schemaVersion: 1,
    status: "complete",
    tool: { name: "egui-baseline", version: 1 },
    repository: {
      commit: "c".repeat(40),
      dirty: true,
      statusSha256: "d".repeat(64),
    },
    app: {
      version: "0.60.13",
      executable: "src-tauri/target/release/aio-coding-hub",
      executableSha256: "a".repeat(64),
      executableBytes: 1,
      installers: [
        {
          kind: "file",
          path: "bundle/aio-coding-hub.pkg",
          bytes: 1,
          sha256: "e".repeat(64),
        },
      ],
      buildProvenance: {
        path: "src-tauri/target/release/aio-coding-hub.exe.build-provenance.json",
        sha256: "b".repeat(64),
        profile: "release",
        target: null,
        producer: "scripts/tauri-build.mjs",
        configOverlaySha256: null,
      },
    },
    environment: {
      platform: "win32",
      arch: "x128",
    },
  };
}

async function test(name, body) {
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aio-egui-baseline-matrix-"));
try {
  await test("preflight validates the exact seven-scenario matrix without changing files", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("read-only");

    const before = {
      staging: await snapshotDirectory(stagingRoot),
      registry: await snapshotDirectory(registryRoot),
    };
    const validatedScenarios = [];
    const matrix = await preflightBaselineMatrix({
      stagingRoot,
      registryRoot,
      validateResult(value) {
        assert.equal(value.status, "complete");
        validatedScenarios.push(value.scenario.id);
        return value;
      },
    });

    assert.deepEqual(FORMAL_BASELINE_SCENARIOS, EXPECTED_SCENARIOS);
    assert.deepEqual(
      matrix.entries.map((entry) => entry.scenario),
      EXPECTED_SCENARIOS
    );
    assert.deepEqual(validatedScenarios.sort(), [...EXPECTED_SCENARIOS].sort());
    assert.deepEqual(
      {
        staging: await snapshotDirectory(stagingRoot),
        registry: await snapshotDirectory(registryRoot),
      },
      before
    );
  });

  await test("preflight binds every filename to platform arch scenario and version", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("filename-binding");
    const expected = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.13.json");
    const forged = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.12.json");
    await rename(expected, forged);

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /baseline filename does not match validated result/
    );
  });

  await test("preflight rejects a matrix assembled from different build identities", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("mixed-builds");
    const oldPath = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.13.json");
    const mixed = JSON.parse(await readFile(oldPath, "utf8"));
    mixed.app.version = "0.60.14";
    const newPath = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.14.json");
    await writeFile(newPath, `${JSON.stringify(mixed, null, 2)}\n`, "utf8");
    await rm(oldPath);

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /formal baseline matrix mixes build identities/
    );
  });

  await test("preflight rejects a matrix assembled from different core fixtures", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("mixed-fixtures");
    const resultPath = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.13.json");
    const mixed = JSON.parse(await readFile(resultPath, "utf8"));
    mixed.scenario.fixtureArtifacts["settings.json"].sha256 = "9".repeat(64);
    await writeFile(resultPath, `${JSON.stringify(mixed, null, 2)}\n`, "utf8");

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /formal baseline matrix mixes build identities/
    );
  });

  await test("preflight permits the hidden-tray start-minimized settings overlay", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("hidden-settings-overlay");
    const resultPath = path.join(stagingRoot, "tauri-win32-x64-hidden-tray-0.60.13.json");
    const overlaid = JSON.parse(await readFile(resultPath, "utf8"));
    overlaid.scenario.fixtureArtifacts["settings.json"].sha256 = "9".repeat(64);
    await writeFile(resultPath, `${JSON.stringify(overlaid, null, 2)}\n`, "utf8");

    const matrix = await preflightBaselineMatrix({
      stagingRoot,
      registryRoot,
      validateResult: acceptSyntheticResult,
    });

    assert.equal(matrix.entries.length, 7);
  });

  await test("preflight rejects results assembled from different machines", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("mixed-machines");
    const resultPath = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.13.json");
    const mixed = JSON.parse(await readFile(resultPath, "utf8"));
    mixed.environment.cpuModel = "synthetic second machine";
    mixed.environment.totalMemoryBytes = 987_654_321;
    await writeFile(resultPath, `${JSON.stringify(mixed, null, 2)}\n`, "utf8");

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /formal baseline matrix mixes build identities/
    );
  });

  await test("preflight rejects results assembled with different sampling protocols", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("mixed-protocols");
    const resultPath = path.join(stagingRoot, "tauri-win32-x64-gateway-load-0.60.13.json");
    const mixed = JSON.parse(await readFile(resultPath, "utf8"));
    mixed.protocol.sampleIntervalMs = 500;
    await writeFile(resultPath, `${JSON.stringify(mixed, null, 2)}\n`, "utf8");

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /formal baseline matrix mixes build identities/
    );
  });

  await test("preflight rejects an unfinished in-progress result", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("in-progress");
    await writeFile(
      path.join(stagingRoot, "tauri-win32-x64-visible-idle-0.60.13.json.inprogress"),
      "{}\n",
      "utf8"
    );

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /in-progress baseline marker/
    );
  });

  await test("preflight sends a claimed complete result through the real full validator", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("full-validator");

    await assert.rejects(
      preflightBaselineMatrix({ stagingRoot, registryRoot }),
      /baseline result schemaVersion must be 1/
    );
  });

  await test("the default validator rejects an unsupported platform architecture", async () => {
    const root = path.join(tempRoot, "unsupported-target");
    const stagingRoot = path.join(root, "staging");
    const registryRoot = path.join(root, "registry");
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(registryRoot, { recursive: true });
    await writeFile(
      path.join(stagingRoot, "tauri-win32-x128-first-interactive-0.60.13.json"),
      `${JSON.stringify(unsupportedTargetProbe(), null, 2)}\n`,
      "utf8"
    );

    await assert.rejects(
      preflightBaselineMatrix({ stagingRoot, registryRoot }),
      /unsupported.*(?:platform|architecture|target)/i
    );
  });

  await test("preflight rejects an extra duplicate complete result", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("duplicate");
    const duplicate = syntheticResult("first-interactive");
    await writeFile(
      path.join(stagingRoot, "tauri-win32-x64-first-interactive-copy-0.60.13.json"),
      `${JSON.stringify(duplicate, null, 2)}\n`,
      "utf8"
    );

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /baseline filename does not match validated result|duplicate formal baseline scenario/
    );
  });

  await test("preflight rejects non-regular JSON entries instead of ignoring them", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("non-regular-json");
    await mkdir(path.join(stagingRoot, "forged-complete.json"));

    await assert.rejects(
      preflightBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /baseline JSON entry must be a regular file/
    );
  });

  await test("promote validates the whole matrix before moving any file", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("validate-before-move");
    let validationCount = 0;

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult(value) {
          validationCount += 1;
          if (validationCount === EXPECTED_SCENARIOS.length) {
            throw new Error("synthetic final validation failure");
          }
          return value;
        },
      }),
      /synthetic final validation failure/
    );

    assert.equal(validationCount, EXPECTED_SCENARIOS.length);
    assert.equal(
      (await readdir(stagingRoot)).filter((name) => name.endsWith(".json")).length,
      EXPECTED_SCENARIOS.length
    );
    assert.deepEqual(await readdir(registryRoot), ["README.md"]);
  });

  await test("promote refuses an existing destination without overwriting or moving sources", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("no-overwrite");
    const existingName = "tauri-win32-x64-first-interactive-0.60.13.json";
    const existingPath = path.join(registryRoot, existingName);
    await writeFile(existingPath, "existing registry result\n", "utf8");

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /baseline registry destination already exists/
    );

    assert.equal(await readFile(existingPath, "utf8"), "existing registry result\n");
    assert.equal(
      (await readdir(stagingRoot)).filter((name) => name.endsWith(".json")).length,
      EXPECTED_SCENARIOS.length
    );
    assert.equal((await readdir(registryRoot)).filter((name) => name.endsWith(".json")).length, 1);
  });

  await test("promote moves the validated matrix together without changing result bytes", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("promote");
    const sourceBytes = Object.fromEntries(
      await Promise.all(
        (await readdir(stagingRoot))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => [name, await readFile(path.join(stagingRoot, name), "utf8")])
      )
    );

    const matrix = await promoteBaselineMatrix({
      stagingRoot,
      registryRoot,
      validateResult: acceptSyntheticResult,
    });

    assert.equal(matrix.entries.length, EXPECTED_SCENARIOS.length);
    assert.equal((await readdir(stagingRoot)).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(await readFile(path.join(registryRoot, "README.md"), "utf8"), "registry\n");
    for (const [name, bytes] of Object.entries(sourceBytes)) {
      assert.equal(await readFile(path.join(registryRoot, name), "utf8"), bytes);
    }
  });

  await test("promote rolls back already published destinations when a later publish fails", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("publish-rollback");
    let copyCalls = 0;

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
        fileSystem: {
          async copyFile(source, destination, mode) {
            copyCalls += 1;
            if (copyCalls === 3) throw new Error("synthetic publish failure");
            await fsCopyFile(source, destination, mode);
          },
          unlink: fsUnlink,
        },
      }),
      /synthetic publish failure/
    );

    assert.equal(
      (await readdir(stagingRoot)).filter((name) => name.endsWith(".json")).length,
      EXPECTED_SCENARIOS.length
    );
    assert.deepEqual(await readdir(registryRoot), ["README.md"]);
  });

  await test("promote restores removed sources when a later source removal fails", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("source-rollback");
    let sourceUnlinks = 0;

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
        fileSystem: {
          copyFile: fsCopyFile,
          async unlink(candidate) {
            if (path.dirname(candidate) === stagingRoot) {
              sourceUnlinks += 1;
              if (sourceUnlinks === 3) throw new Error("synthetic source removal failure");
            }
            await fsUnlink(candidate);
          },
        },
      }),
      /synthetic source removal failure/
    );

    assert.equal(
      (await readdir(stagingRoot)).filter((name) => name.endsWith(".json")).length,
      EXPECTED_SCENARIOS.length
    );
    assert.deepEqual(await readdir(registryRoot), ["README.md"]);
  });

  await test("promote treats an already absent source as successfully removed", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("source-already-removed");
    const expectedBytes = await readJsonBytesByName(stagingRoot);
    let sourceUnlinks = 0;

    await promoteBaselineMatrix({
      stagingRoot,
      registryRoot,
      validateResult: acceptSyntheticResult,
      fileSystem: {
        copyFile: fsCopyFile,
        async unlink(candidate) {
          if (path.dirname(candidate) === stagingRoot) {
            sourceUnlinks += 1;
            if (sourceUnlinks === 3) {
              await fsUnlink(candidate);
              await fsUnlink(candidate);
            }
          }
          await fsUnlink(candidate);
        },
      },
    });

    assert.deepEqual(await readdir(stagingRoot), []);
    for (const [name, bytes] of Object.entries(expectedBytes)) {
      assert.equal(await readFile(path.join(registryRoot, name), "utf8"), bytes);
    }
  });

  await test("promote restores every absent source before rolling back verified destinations", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("source-removed-before-error");
    const expectedBytes = await readJsonBytesByName(stagingRoot);
    let sourceUnlinks = 0;

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
        fileSystem: {
          copyFile: fsCopyFile,
          async unlink(candidate) {
            if (path.dirname(candidate) === stagingRoot) {
              sourceUnlinks += 1;
              if (sourceUnlinks === 3) {
                await fsUnlink(candidate);
                const error = new Error("synthetic failure after source removal");
                error.code = "EIO";
                throw error;
              }
            }
            await fsUnlink(candidate);
          },
        },
      }),
      /synthetic failure after source removal/
    );

    assert.deepEqual(await readJsonBytesByName(stagingRoot), expectedBytes);
    assert.deepEqual(await readdir(registryRoot), ["README.md"]);
  });

  await test("promote preserves the complete verified registry when staging restoration fails", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("source-restore-failure");
    const expectedBytes = await readJsonBytesByName(stagingRoot);
    let sourceUnlinks = 0;

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
        fileSystem: {
          async copyFile(source, destination, mode) {
            if (
              path.dirname(destination) === stagingRoot &&
              path.basename(destination).includes("first-interactive")
            ) {
              throw new Error("synthetic staging restoration failure");
            }
            await fsCopyFile(source, destination, mode);
          },
          async unlink(candidate) {
            if (path.dirname(candidate) === stagingRoot) {
              sourceUnlinks += 1;
              if (sourceUnlinks === 3) {
                await fsUnlink(candidate);
                const error = new Error("synthetic failure after source removal");
                error.code = "EIO";
                throw error;
              }
            }
            await fsUnlink(candidate);
          },
        },
      }),
      /baseline matrix promotion failed while removing staging sources/
    );

    for (const [name, bytes] of Object.entries(expectedBytes)) {
      assert.equal(await readFile(path.join(registryRoot, name), "utf8"), bytes);
    }
  });

  await test("promote rejects a staged result replaced after preflight validation", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("replace-after-preflight");
    let replaced = false;

    await assert.rejects(
      promoteBaselineMatrix({
        stagingRoot,
        registryRoot,
        validateResult: acceptSyntheticResult,
        fileSystem: {
          async copyFile(source, destination, mode) {
            if (!replaced && path.basename(source).includes("first-interactive")) {
              replaced = true;
              await writeFile(source, '{"status":"diagnostic"}\n', "utf8");
            }
            await fsCopyFile(source, destination, mode);
          },
          unlink: fsUnlink,
        },
      }),
      /baseline result changed after preflight validation/
    );

    assert.equal(replaced, true);
    assert.deepEqual(await readdir(registryRoot), ["README.md"]);
    assert.equal(
      (await readdir(stagingRoot)).filter((name) => name.endsWith(".json")).length,
      EXPECTED_SCENARIOS.length
    );
  });

  await test("promote publishes bytes independent from staging mutations during source removal", async () => {
    const { stagingRoot, registryRoot } = await createMatrixCase("mutate-during-unlink");
    const expectedBytes = Object.fromEntries(
      await Promise.all(
        (await readdir(stagingRoot))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => [name, await readFile(path.join(stagingRoot, name), "utf8")])
      )
    );
    let mutated = false;

    await promoteBaselineMatrix({
      stagingRoot,
      registryRoot,
      validateResult: acceptSyntheticResult,
      fileSystem: {
        copyFile: fsCopyFile,
        async unlink(candidate) {
          if (!mutated && path.dirname(candidate) === stagingRoot) {
            mutated = true;
            await writeFile(candidate, '{"status":"diagnostic"}\n', "utf8");
          }
          await fsUnlink(candidate);
        },
      },
    });

    assert.equal(mutated, true);
    for (const [name, bytes] of Object.entries(expectedBytes)) {
      assert.equal(await readFile(path.join(registryRoot, name), "utf8"), bytes);
    }
  });

  await test("matrix CLI defaults to preflight and requires an explicit promote flag", async () => {
    assert.deepEqual(parseMatrixArgs([]), { promote: false });
    assert.deepEqual(parseMatrixArgs(["--"]), { promote: false });
    assert.deepEqual(parseMatrixArgs(["--promote"]), { promote: true });
    assert.deepEqual(parseMatrixArgs(["--", "--promote"]), { promote: true });
    assert.throws(() => parseMatrixArgs(["--write"]), /unknown matrix argument/);
    assert.throws(
      () => parseMatrixArgs(["--promote", "--promote"]),
      /matrix command accepts only --promote/
    );

    const calls = [];
    const preflightResult = await runMatrixCommand(
      { promote: false },
      {
        async preflightImpl(options) {
          calls.push({ mode: "preflight", options });
          return { entries: [] };
        },
        async promoteImpl() {
          throw new Error("default command must not promote");
        },
      }
    );
    assert.deepEqual(preflightResult, { entries: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "preflight");
    assert.match(calls[0].options.stagingRoot, /[\\/]\.local[\\/]egui-baselines$/);
    assert.match(calls[0].options.registryRoot, /[\\/]docs[\\/]egui-migration[\\/]baselines$/);

    await runMatrixCommand(
      { promote: true },
      {
        async preflightImpl() {
          throw new Error("promote command must use the transactional implementation");
        },
        async promoteImpl(options) {
          calls.push({ mode: "promote", options });
          return { entries: [] };
        },
      }
    );
    assert.equal(calls.at(-1).mode, "promote");
  });

  await test("registry validation allows zero groups and validates every complete group", async () => {
    const emptyRegistry = path.join(tempRoot, "empty-registry");
    await mkdir(emptyRegistry, { recursive: true });
    await writeFile(path.join(emptyRegistry, "README.md"), "registry\n", "utf8");
    const empty = await validateBaselineRegistry({
      registryRoot: emptyRegistry,
      validateResult() {
        throw new Error("an empty registry has no result to validate");
      },
    });
    assert.deepEqual(empty.groups, []);
    assert.equal(empty.resultCount, 0);

    const multiRegistry = path.join(tempRoot, "multi-registry");
    await mkdir(multiRegistry, { recursive: true });
    await writeSyntheticMatrix(multiRegistry);
    await writeSyntheticMatrix(multiRegistry, {
      platform: "linux",
      arch: "x64",
      buildSeed: "e",
    });
    let validated = 0;
    const multi = await validateBaselineRegistry({
      registryRoot: multiRegistry,
      validateResult(value) {
        validated += 1;
        return acceptSyntheticResult(value);
      },
    });
    assert.equal(validated, 14);
    assert.equal(multi.resultCount, 14);
    assert.equal(multi.groups.length, 2);
    assert.deepEqual(
      multi.groups.map((group) => group.entries.length),
      [7, 7]
    );
  });

  await test("registry validation rejects any partial build group", async () => {
    const registryRoot = path.join(tempRoot, "partial-registry");
    await mkdir(registryRoot, { recursive: true });
    await writeSyntheticMatrix(registryRoot);
    await writeSyntheticMatrix(registryRoot, {
      platform: "linux",
      arch: "x64",
      buildSeed: "e",
    });
    await rm(path.join(registryRoot, "tauri-linux-x64-gateway-load-0.60.13.json"));

    await assert.rejects(
      validateBaselineRegistry({
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /registry group must contain each required scenario exactly once/
    );
  });

  await test("registry validation separates groups with different sampling protocols", async () => {
    const registryRoot = path.join(tempRoot, "mixed-protocol-registry");
    await mkdir(registryRoot, { recursive: true });
    await writeSyntheticMatrix(registryRoot);
    const resultPath = path.join(registryRoot, "tauri-win32-x64-gateway-load-0.60.13.json");
    const mixed = JSON.parse(await readFile(resultPath, "utf8"));
    mixed.protocol.sampleIntervalMs = 500;
    await writeFile(resultPath, `${JSON.stringify(mixed, null, 2)}\n`, "utf8");

    await assert.rejects(
      validateBaselineRegistry({
        registryRoot,
        validateResult: acceptSyntheticResult,
      }),
      /registry group must contain each required scenario exactly once/
    );
  });

  await test("matrix CLI exposes a separate read-only registry check", async () => {
    assert.deepEqual(parseMatrixArgs(["--check-registry"]), {
      promote: false,
      checkRegistry: true,
    });
    assert.throws(
      () => parseMatrixArgs(["--promote", "--check-registry"]),
      /matrix command accepts one mode/
    );

    const calls = [];
    await runMatrixCommand(
      { promote: false, checkRegistry: true },
      {
        async preflightImpl() {
          throw new Error("registry mode must not inspect staging as one matrix");
        },
        async promoteImpl() {
          throw new Error("registry mode must not promote");
        },
        async validateRegistryImpl(options) {
          calls.push(options);
          return { groups: [], resultCount: 0 };
        },
      }
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].registryRoot, /[\\/]docs[\\/]egui-migration[\\/]baselines$/);
  });
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
