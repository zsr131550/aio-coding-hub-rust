import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateBaselineResult, validateCompleteBaselineResult } from "./result.mjs";
import { extractRunMetrics, requiredMilestones } from "./runner.mjs";
import { GATEWAY_STUB_PROTOCOL } from "./gateway-stub.mjs";
import { supportedHostTarget } from "./release-provenance.mjs";
import { processCollectorCapabilities } from "./process-tree.mjs";
import { aggregateValues } from "./stats.mjs";

const scenarios = [
  "startup-cold-process",
  "startup-warm-process",
  "first-interactive",
  "visible-idle",
  "hidden-tray",
  "logs-10k",
  "gateway-load",
];

function gatewayTimingData(seed) {
  return {
    throughputRequestsPerSecond: 100 + seed,
    nonStreamTtfbMs: [4 + seed, 6 + seed],
    streamRequests: 4,
    streamDataEvents: 5,
    streamDoneEvents: 1,
    streamEventIntervalMs: 20,
    streamTtfbMs: [8 + seed, 8 + seed, 10 + seed, 10 + seed],
    streamInterEventMs: [...Array(10).fill(18 + seed), ...Array(10).fill(22 + seed)],
    observedStreamTransportChunks: Array(4).fill(6),
  };
}

function successfulRun(scenario, index) {
  const runId = `${scenario}-run-${index}`;
  const launchStartedUnixMs = 1_000_000 + index * 1_000;
  const formalDurationMs =
    scenario === "visible-idle" ? 60_000 : scenario === "hidden-tray" ? 600_000 : null;
  const processIdentity = {
    pid: 10,
    ppid: 1,
    birthToken: `root-${index}`,
    identityPrecision: "exact",
    imageName: "fixture-app",
  };
  const milestoneNames = requiredMilestones(scenario, runId);
  const scenarioCompletedIndex = milestoneNames.indexOf("scenario_completed");
  const milestones = milestoneNames.map((milestone, milestoneIndex) => {
    const elapsedMs =
      milestoneIndex +
      1 +
      (formalDurationMs != null && milestoneIndex >= scenarioCompletedIndex ? formalDurationMs : 0);
    return {
      schemaVersion: 1,
      runId,
      scenario,
      seq: milestoneIndex + 1,
      milestone,
      elapsedMs,
      wallClockUnixMs: launchStartedUnixMs + elapsedMs,
      data:
        milestone === "process_entry"
          ? { appVersion: "0.60.13" }
          : milestone === "window_visible" || milestone === "window_hidden"
            ? {
                physicalWidth: 1500,
                physicalHeight: 900,
                logicalWidth: 1500,
                logicalHeight: 900,
                scaleFactor: 1,
              }
            : milestone === "logs_dataset_ready"
              ? { durationMs: 30 + index }
              : milestone === "logs_filter_painted"
                ? { durationMs: 40 + index }
                : milestone === "logs_select_painted"
                  ? { durationMs: 50 + index }
                  : milestone === "gateway_load_idle_completed"
                    ? gatewayTimingData(index)
                    : milestone === "gateway_load_active_completed"
                      ? gatewayTimingData(index + 1)
                      : milestone === "gateway_load_completed"
                        ? { activeFrameCount: 3 }
                        : {},
    };
  });
  const processSample = (atMs, sampleIndex) => {
    const process = {
      ...processIdentity,
      workingSetBytes: 1_000 + index + sampleIndex * 10,
      privateBytes: 500 + index + sampleIndex * 5,
      cpuTimeMs: 5 + index + sampleIndex * 2,
    };
    return {
      atMs,
      atUnixMs: launchStartedUnixMs + atMs,
      processes: [process],
      totals: {
        processCount: 1,
        workingSetBytes: process.workingSetBytes,
        privateBytes: process.privateBytes,
        cpuTimeMs: process.cpuTimeMs,
      },
    };
  };
  let samples;
  if (formalDurationMs == null) {
    samples = [processSample(1, 0), processSample(50, 1)];
  } else {
    const startMs = milestones.find((row) => row.milestone === "startup_ready").elapsedMs;
    const endMs = milestones.find((row) => row.milestone === "scenario_completed").elapsedMs;
    samples = [];
    for (let atMs = startMs; atMs <= endMs; atMs += 1_000) {
      samples.push(processSample(atMs, samples.length));
    }
    if (samples.at(-1).atMs !== endMs) samples.push(processSample(endMs, samples.length));
  }
  const run = {
    index,
    runId,
    scenario,
    launchStartedUnixMs,
    exitCode: 0,
    signal: null,
    durationMs: formalDurationMs ?? 100,
    milestones,
    samples,
    stdout: "",
    stderr: "",
    warnings: [],
    failures: [],
    metrics: {},
    isolation: {
      home: "$RUN_HOME",
      appData: "$RUN_HOME/.aio-coding-hub",
      roamingAppData: "$RUN_HOME/AppData/Roaming",
      localAppData: "$RUN_HOME/AppData/Local",
      xdgConfigHome: "$RUN_HOME/.config",
      xdgDataHome: "$RUN_HOME/.local/share",
      xdgCacheHome: "$RUN_HOME/.cache",
      temp: "$RUN_HOME/tmp",
      codexHome: "$RUN_HOME/.codex",
      webviewData: "$RUN_HOME/.aio-benchmark/webview",
    },
  };
  run.metrics = extractRunMetrics(run);
  if (scenario === "gateway-load") {
    run.gatewayStub = {
      protocol: GATEWAY_STUB_PROTOCOL,
      counters: {
        requests: 56,
        authenticatedRequests: 56,
        nonStreamRequests: 48,
        streamRequests: 8,
        rejectedRequests: 0,
        streamSchedules: Array.from({ length: 8 }, (_, requestIndex) => ({
          requestIndex: requestIndex + 1,
          eventWriteOffsetsMs: [0, 20, 40, 60, 80, 100],
          intervalDeviationsMs: [0, 0, 0, 0, 0],
        })),
      },
    };
  }
  return run;
}

function baselineResult(scenario = "first-interactive") {
  const fixturePlatform = "win32";
  const fixtureArch = "x64";
  const rawRuns = Array.from({ length: 10 }, (_, index) => successfulRun(scenario, index));
  const aggregates = Object.fromEntries(
    Object.keys(rawRuns[0].metrics).map((name) => [
      name,
      aggregateValues(rawRuns.map((run) => run.metrics[name])),
    ])
  );
  const fixtureArtifacts = {
    "aio-coding-hub.db": { bytes: 1, sha256: "1".repeat(64) },
    "settings.json": { bytes: 1, sha256: "2".repeat(64) },
    ...(scenario === "logs-10k"
      ? {
          "request-logs-10000.jsonl": {
            bytes: 1,
            sha256: "3".repeat(64),
            rowCount: 10_000,
          },
        }
      : {}),
  };
  const fixtureHash = createHash("sha256")
    .update(
      Object.entries(fixtureArtifacts)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([name, metadata]) => `${name}\u0000${metadata.sha256}`)
        .join("\n")
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    status: "complete",
    tool: { name: "egui-baseline", version: 1 },
    repository: {
      commit: "0".repeat(40),
      dirty: true,
      statusSha256: "4".repeat(64),
    },
    app: {
      version: "0.60.13",
      executable: "fixture",
      executableSha256: "0".repeat(64),
      executableBytes: 1,
      installers: [{ kind: "file", path: "bundle/fixture.msi", bytes: 1, sha256: "5".repeat(64) }],
      buildProvenance: {
        path: "fixture.build-provenance.json",
        sha256: "6".repeat(64),
        profile: "release",
        target: supportedHostTarget(fixturePlatform, fixtureArch),
        producer: "scripts/tauri-build.mjs",
        configOverlaySha256: null,
      },
    },
    environment: {
      platform: fixturePlatform,
      arch: fixtureArch,
      osRelease: "fixture-os-release",
      kernelType: "FixtureKernel",
      cpuModel: null,
      logicalCpuCount: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      nodeVersion: process.version,
      locale: "C.UTF-8",
      timezone: "UTC",
      gpuRenderer: null,
      webViewRuntime: null,
      power: null,
      processMetrics: processCollectorCapabilities(fixturePlatform),
    },
    protocol: {
      warmups: 2,
      runs: 10,
      sampleIntervalMs: 1_000,
      processTree: "pid-birth-image identity descendants; retained after reparent",
      percentile: "nearest-rank",
      median: "midpoint for even sample counts",
    },
    scenario: {
      id: scenario,
      fixture: "current",
      fixtureHash,
      fixtureArtifacts,
      durationMs:
        scenario === "visible-idle" ? 60_000 : scenario === "hidden-tray" ? 600_000 : null,
      window: {
        width: 1500,
        height: 900,
        startMinimized: scenario === "hidden-tray",
      },
    },
    warmupSummaries: Array.from({ length: 2 }, (_, index) => ({
      index,
      exitCode: 0,
      durationMs: 100 + index,
      warnings: [],
      failures: [],
    })),
    rawRuns,
    aggregates,
    warnings: [],
    failures: [],
    pendingPlatforms: ["darwin", "linux"],
  };
}

let passed = 0;
const failures = [];

function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`[egui-baseline:result:selftest] ok - ${name}`);
  } catch (error) {
    failures.push(error);
    console.error(`[egui-baseline:result:selftest] FAIL - ${name}: ${error.message}`);
  }
}

test("accepts complete successful baselines for every formal scenario", () => {
  for (const scenario of scenarios) {
    const result = baselineResult(scenario);
    assert.equal(validateBaselineResult(result), result);
  }
});

test("rejects an unsupported platform architecture even when its target is null", () => {
  const result = baselineResult("first-interactive");
  result.environment.arch = "x128";
  result.app.buildProvenance.target = null;

  assert.throws(
    () => validateBaselineResult(result),
    /unsupported.*(?:platform|architecture|target)/i
  );
});

test("accepts explicit macOS process capability limits for non-idle results", () => {
  const result = baselineResult("first-interactive");
  result.environment.platform = "darwin";
  result.app.buildProvenance.target = supportedHostTarget("darwin", result.environment.arch);
  result.environment.processMetrics = processCollectorCapabilities("darwin");
  result.pendingPlatforms = ["win32", "linux"];
  assert.equal(validateBaselineResult(result), result);
});

test("rejects process capabilities that contradict the declared platform collector", () => {
  const result = baselineResult();
  result.environment.processMetrics.metrics.privateBytes.source = "guessed-private-counter";
  assert.throws(() => validateBaselineResult(result), /capabilities contradict/);
});

test("macOS idle results remain legal diagnostics but cannot be marked successful", () => {
  const successful = baselineResult("visible-idle");
  successful.environment.platform = "darwin";
  successful.app.buildProvenance.target = supportedHostTarget(
    "darwin",
    successful.environment.arch
  );
  successful.environment.processMetrics = processCollectorCapabilities("darwin");
  successful.pendingPlatforms = ["win32", "linux"];
  assert.throws(() => validateBaselineResult(successful), /cannot satisfy idle process metrics/);

  const diagnostic = baselineResult("visible-idle");
  diagnostic.environment.platform = "darwin";
  diagnostic.app.buildProvenance.target = supportedHostTarget(
    "darwin",
    diagnostic.environment.arch
  );
  diagnostic.environment.processMetrics = processCollectorCapabilities("darwin");
  diagnostic.pendingPlatforms = ["win32", "linux"];
  diagnostic.status = "diagnostic";
  diagnostic.failures = [];
  for (const [runIndex, run] of diagnostic.rawRuns.entries()) {
    const failure = {
      code: "PROCESS_METRIC_UNAVAILABLE",
      message: "macOS collector cannot provide exact private bytes or identity-safe CPU delta",
    };
    run.failures = [failure];
    diagnostic.failures.push({ runIndex, ...failure });
  }
  diagnostic.aggregates = {};
  assert.equal(validateBaselineResult(diagnostic), diagnostic);
});

test("rejects a formal result without installer and build provenance evidence", () => {
  const withoutInstaller = baselineResult();
  withoutInstaller.app.installers = [];
  assert.throws(() => validateBaselineResult(withoutInstaller), /installer|build provenance/i);

  const withoutProvenance = baselineResult();
  delete withoutProvenance.app.buildProvenance;
  assert.throws(() => validateBaselineResult(withoutProvenance), /installer|build provenance/i);

  const unknownTarget = baselineResult();
  unknownTarget.app.buildProvenance.target = "unknown-host-target";
  assert.throws(() => validateBaselineResult(unknownTarget), /installer|build provenance/i);

  for (const mutate of [
    (result) => (result.app.executable = "C:\\Users\\Fixture\\app.exe"),
    (result) => (result.app.buildProvenance.path = "/tmp/app.build-provenance.json"),
    (result) => (result.app.installers[0].path = "../stale.msi"),
  ]) {
    const unsafePath = baselineResult();
    mutate(unsafePath);
    assert.throws(() => validateBaselineResult(unsafePath), /installer|build provenance/i);
  }
});

test("requires the repository status hash even when every measured run failed", () => {
  const missing = baselineResult();
  for (const run of missing.rawRuns) {
    run.milestones = [];
    run.samples = [];
    run.metrics = {};
    run.failures = [{ code: "SCENARIO_FAILED", message: "fixture failure" }];
  }
  missing.failures = missing.rawRuns.map((_, runIndex) => ({
    runIndex,
    code: "SCENARIO_FAILED",
    message: "fixture failure",
  }));
  missing.status = "diagnostic";
  missing.aggregates = {};
  assert.equal(validateBaselineResult(missing), missing);
  assert.throws(() => validateCompleteBaselineResult(missing), /complete.*registry/i);
  delete missing.repository.statusSha256;
  assert.throws(() => validateBaselineResult(missing), /repository metadata/);

  const malformed = baselineResult();
  malformed.repository.statusSha256 = "not-a-sha256";
  assert.throws(() => validateBaselineResult(malformed), /repository metadata/);
});

test("requires complete environment metadata while allowing nullable platform evidence", () => {
  const requiredFields = [
    "osRelease",
    "kernelType",
    "cpuModel",
    "logicalCpuCount",
    "totalMemoryBytes",
    "nodeVersion",
    "locale",
    "timezone",
    "gpuRenderer",
    "webViewRuntime",
    "power",
  ];
  for (const field of requiredFields) {
    const result = baselineResult();
    delete result.environment[field];
    assert.throws(() => validateBaselineResult(result), /environment metadata/, field);
  }

  const collected = baselineResult();
  collected.environment.cpuModel = "Fixture CPU";
  collected.environment.gpuRenderer = "Fixture GPU";
  collected.environment.webViewRuntime = "Fixture WebView";
  collected.environment.power = { source: "fixture", mode: "balanced" };
  assert.equal(validateBaselineResult(collected), collected);

  const malformed = baselineResult();
  malformed.environment.gpuRenderer = 42;
  assert.throws(() => validateBaselineResult(malformed), /environment metadata/);
});

test("requires the fixed process-tree and aggregate algorithms", () => {
  for (const [field, value] of [
    ["processTree", "pid-only"],
    ["percentile", "linear-interpolation"],
    ["median", "lower-middle"],
  ]) {
    const result = baselineResult();
    result.protocol[field] = value;
    assert.throws(() => validateBaselineResult(result), /protocol/, field);
  }
});

test("requires the fixed scenario window and hidden state", () => {
  const missing = baselineResult();
  delete missing.scenario.window;
  assert.throws(() => validateBaselineResult(missing), /scenario window/);

  const resized = baselineResult();
  resized.scenario.window.width = 1499;
  assert.throws(() => validateBaselineResult(resized), /scenario window/);

  const visibleHidden = baselineResult();
  visibleHidden.scenario.window.startMinimized = true;
  assert.throws(() => validateBaselineResult(visibleHidden), /scenario window/);

  const hiddenVisible = baselineResult("hidden-tray");
  hiddenVisible.scenario.window.startMinimized = false;
  assert.throws(() => validateBaselineResult(hiddenVisible), /scenario window/);
});

test("requires one successful structured summary per warmup", () => {
  const warned = baselineResult();
  warned.warmupSummaries[0].warnings.push({
    code: "PROCESS_SAMPLE_FAILED",
    message: "one warmup sample was unavailable",
  });
  assert.equal(validateBaselineResult(warned), warned);

  const wrongCount = baselineResult();
  wrongCount.warmupSummaries.pop();
  assert.throws(() => validateBaselineResult(wrongCount), /warmupSummaries/);

  for (const mutate of [
    (summary) => {
      summary.index = 1;
    },
    (summary) => {
      summary.exitCode = 1;
    },
    (summary) => {
      summary.durationMs = -1;
    },
    (summary) => {
      summary.warnings = ["warning"];
    },
    (summary) => {
      summary.failures = [{ code: "WARMUP_FAILED", message: "failed" }];
    },
  ]) {
    const result = baselineResult();
    mutate(result.warmupSummaries[0]);
    assert.throws(() => validateBaselineResult(result), /warmup summary/);
  }
});

test("validates global warnings and mirrors run-scoped warnings", () => {
  const result = baselineResult();
  const scoped = { code: "PROCESS_SAMPLE_FAILED", message: "one sample was unavailable" };
  result.rawRuns[0].warnings.push(scoped);
  result.warnings.push({ runIndex: 0, ...scoped });
  result.warnings.push({
    code: "INSTALLER_ARTIFACT_NOT_FOUND",
    message: "no installer was found",
  });
  assert.equal(validateBaselineResult(result), result);

  const invalidScope = baselineResult();
  invalidScope.warnings.push({ runIndex: "0", code: "WARNING", message: "bad index" });
  assert.throws(() => validateBaselineResult(invalidScope), /structured warning/);

  const unmirrored = baselineResult();
  unmirrored.warnings.push({ runIndex: 0, code: "WARNING", message: "not in raw run" });
  assert.throws(() => validateBaselineResult(unmirrored), /warning.*not mirrored/);

  const rawOnly = baselineResult();
  rawOnly.rawRuns[0].warnings.push({ code: "WARNING", message: "not promoted" });
  assert.throws(() => validateBaselineResult(rawOnly), /warning.*missing/);
});

test("rejects a successful run missing first_interactive", () => {
  const result = baselineResult();
  result.rawRuns[0].milestones = result.rawRuns[0].milestones.filter(
    (row) => row.milestone !== "first_interactive"
  );
  result.rawRuns[0].milestones.forEach((row, index) => {
    row.seq = index + 1;
  });
  assert.throws(() => validateBaselineResult(result), /first_interactive/);
});

test("rejects a successful run whose embedded app version is missing or stale", () => {
  const missing = baselineResult();
  for (const run of missing.rawRuns) {
    delete run.milestones.find((row) => row.milestone === "process_entry").data.appVersion;
  }
  assert.throws(() => validateBaselineResult(missing), /embedded app version/i);

  const stale = baselineResult();
  for (const run of stale.rawRuns) {
    run.milestones.find((row) => row.milestone === "process_entry").data.appVersion = "0.0.0";
  }
  assert.throws(() => validateBaselineResult(stale), /embedded app version/i);
});

test("rejects persisted absolute paths in isolation and diagnostics", () => {
  const isolatedLeak = baselineResult();
  isolatedLeak.rawRuns[0].isolation.home = "C:\\Users\\Alice\\benchmark-home";
  assert.throws(() => validateBaselineResult(isolatedLeak), /persisted path|isolation/i);

  const diagnosticLeak = baselineResult();
  diagnosticLeak.rawRuns[0].stderr = "failed while reading /tmp/alice/secret.json";
  assert.throws(() => validateBaselineResult(diagnosticLeak), /persisted path|diagnostic/i);

  const sampleLeak = baselineResult();
  sampleLeak.rawRuns[0].samples[0].processes[0].imageName = "/Users/alice/AIO Coding Hub";
  assert.throws(() => validateBaselineResult(sampleLeak), /persisted path|diagnostic/i);

  const extraFailureFieldLeak = baselineResult();
  extraFailureFieldLeak.rawRuns[0].failures.push({
    code: "FIXTURE_FAILURE",
    message: "fixture failed",
    artifact: "C:\\Users\\Alice\\fixture.json",
  });
  extraFailureFieldLeak.failures.push({
    runIndex: 0,
    code: "FIXTURE_FAILURE",
    message: "fixture failed",
    artifact: "C:\\Users\\Alice\\fixture.json",
  });
  assert.throws(
    () => validateBaselineResult(extraFailureFieldLeak),
    /persisted path|diagnostic|structured failure/i
  );
});

test("rejects incomplete release provenance and pending-platform evidence", () => {
  const missingOverlayEvidence = baselineResult();
  delete missingOverlayEvidence.app.buildProvenance.configOverlaySha256;
  assert.throws(() => validateBaselineResult(missingOverlayEvidence), /build provenance/i);

  const missingInstallerKind = baselineResult();
  delete missingInstallerKind.app.installers[0].kind;
  assert.throws(() => validateBaselineResult(missingInstallerKind), /installer metadata/i);

  const wrongPendingPlatforms = baselineResult();
  wrongPendingPlatforms.pendingPlatforms = [];
  assert.throws(() => validateBaselineResult(wrongPendingPlatforms), /pendingPlatforms/i);
});

test("rejects a successful run missing process sample totals", () => {
  const result = baselineResult();
  delete result.rawRuns[0].samples[0].totals;
  assert.throws(() => validateBaselineResult(result), /sample totals/);
});

test("rejects process totals that do not recompute from raw rows", () => {
  const result = baselineResult();
  result.rawRuns[0].samples[0].totals.workingSetBytes += 1;
  assert.throws(() => validateBaselineResult(result), /totals mismatch/);
});

test("rejects non-increasing process sample timestamps", () => {
  const result = baselineResult();
  result.rawRuns[0].samples[1].atMs = result.rawRuns[0].samples[0].atMs;
  assert.throws(() => validateBaselineResult(result), /invalid sample/);
});

test("rejects a successful gateway run missing key stream timing", () => {
  const result = baselineResult("gateway-load");
  const milestone = result.rawRuns[0].milestones.find(
    (row) => row.milestone === "gateway_load_idle_completed"
  );
  delete milestone.data.streamInterEventMs;
  assert.throws(() => validateBaselineResult(result), /gateway_load_idle_completed.*stream timing/);
});

test("rejects a successful gateway run without authenticated stub evidence", () => {
  const result = baselineResult("gateway-load");
  delete result.rawRuns[0].gatewayStub.counters.authenticatedRequests;
  assert.throws(() => validateBaselineResult(result), /gateway stub.*authenticated/i);
});

test("rejects a gateway active phase without a committed UI frame", () => {
  const result = baselineResult("gateway-load");
  result.rawRuns[0].milestones.find(
    (row) => row.milestone === "gateway_load_completed"
  ).data.activeFrameCount = 0;
  assert.throws(() => validateBaselineResult(result), /committed React frame/);
});

test("rejects a successful run missing its scenario metric", () => {
  const result = baselineResult();
  delete result.rawRuns[0].metrics.launchToFirstInteractiveMs;
  assert.throws(() => validateBaselineResult(result), /launchToFirstInteractiveMs/);
});

test("rejects a successful result missing its scenario aggregate", () => {
  const result = baselineResult();
  delete result.aggregates.launchToFirstInteractiveMs;
  assert.throws(() => validateBaselineResult(result), /aggregate launchToFirstInteractiveMs/);
});

test("rejects diluted formal idle durations", () => {
  const result = baselineResult("hidden-tray");
  result.scenario.durationMs = 1;
  assert.throws(() => validateBaselineResult(result), /durationMs/);
});

test("allows incomplete failed runs only with structured mirrored failures", () => {
  const result = baselineResult();
  const run = result.rawRuns[0];
  run.milestones = [];
  run.samples = [{ atMs: 0 }];
  run.metrics = {};
  run.failures = [{ code: "ROOT_NOT_OBSERVED", message: "fixture root was not observed" }];
  result.status = "diagnostic";
  result.failures = [
    {
      runIndex: 0,
      code: "ROOT_NOT_OBSERVED",
      message: "fixture root was not observed",
    },
  ];
  for (const [name, aggregate] of Object.entries(result.aggregates)) {
    aggregate.samples.shift();
    result.aggregates[name] = aggregateValues(aggregate.samples);
  }
  assert.equal(validateBaselineResult(result), result);
});

test("excludes diagnostic metrics from failed runs when validating aggregates", () => {
  const result = baselineResult();
  const run = result.rawRuns[0];
  run.metrics.launchToFirstInteractiveMs = 999_999;
  run.failures = [{ code: "SCENARIO_FAILED", message: "fixture scenario failed" }];
  result.status = "diagnostic";
  result.failures = [{ runIndex: 0, code: "SCENARIO_FAILED", message: "fixture scenario failed" }];
  for (const [name, aggregate] of Object.entries(result.aggregates)) {
    aggregate.samples.shift();
    result.aggregates[name] = aggregateValues(aggregate.samples);
  }
  assert.equal(validateBaselineResult(result), result);
});

test("rejects an incomplete run whose failure is not structured", () => {
  const result = baselineResult();
  result.rawRuns[0].milestones = [];
  result.rawRuns[0].failures = ["failed"];
  result.failures = ["failed"];
  assert.throws(() => validateBaselineResult(result), /structured failure/);
});

test("rejects a status that contradicts raw run completion", () => {
  const completeAsDiagnostic = baselineResult();
  completeAsDiagnostic.status = "diagnostic";
  assert.throws(() => validateBaselineResult(completeAsDiagnostic), /status must be complete/i);

  const failedAsComplete = baselineResult();
  const failure = { code: "SCENARIO_FAILED", message: "fixture scenario failed" };
  failedAsComplete.rawRuns[0].failures = [failure];
  failedAsComplete.failures = [{ runIndex: 0, ...failure }];
  for (const [name, aggregate] of Object.entries(failedAsComplete.aggregates)) {
    aggregate.samples.shift();
    failedAsComplete.aggregates[name] = aggregateValues(aggregate.samples);
  }
  assert.throws(() => validateBaselineResult(failedAsComplete), /status must be diagnostic/i);
});

if (failures.length > 0) {
  throw new AggregateError(failures, `${failures.length} result selftests failed`);
}
console.log(`[egui-baseline:result:selftest] ${passed} tests passed`);
