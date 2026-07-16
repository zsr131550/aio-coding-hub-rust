import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { extractRunMetrics, validateMilestones, validateProcessSampleCoverage } from "./runner.mjs";
import {
  aggregateProcessSample,
  processCollectorCapabilities,
  processIdentityKey,
} from "./process-tree.mjs";
import { aggregateValues } from "./stats.mjs";
import { validateGatewayStubEvidence } from "./gateway-stub.mjs";
import { supportedHostTarget } from "./release-provenance.mjs";

const REQUIRED_SCENARIO_METRICS = {
  "startup-cold-process": [
    "launchToTauriSetupCompletedMs",
    "launchToDbReadyMs",
    "launchToGatewayReadyMs",
    "launchToStartupReadyMs",
    "launchToFirstInteractiveMs",
  ],
  "startup-warm-process": [
    "launchToTauriSetupCompletedMs",
    "launchToDbReadyMs",
    "launchToGatewayReadyMs",
    "launchToStartupReadyMs",
    "launchToFirstInteractiveMs",
  ],
  "first-interactive": ["launchToProcessEntryMs", "launchToFirstInteractiveMs"],
  "visible-idle": [
    "peakWorkingSetBytes",
    "medianWorkingSetBytes",
    "peakPrivateBytes",
    "cpuTimeDeltaMs",
    "maxProcessCount",
  ],
  "hidden-tray": [
    "peakWorkingSetBytes",
    "medianWorkingSetBytes",
    "peakPrivateBytes",
    "cpuTimeDeltaMs",
    "maxProcessCount",
  ],
  "logs-10k": ["logsDatasetReadyMs", "logsFilterPaintMs", "logsSelectPaintMs"],
  "gateway-load": [
    "gatewayIdleThroughputRequestsPerSecond",
    "gatewayIdleNonStreamTtfbMedianMs",
    "gatewayIdleNonStreamTtfbP95Ms",
    "gatewayIdleStreamTtfbMedianMs",
    "gatewayIdleStreamTtfbP95Ms",
    "gatewayIdleStreamInterEventMedianMs",
    "gatewayIdleStreamInterEventP95Ms",
    "gatewayActiveThroughputRequestsPerSecond",
    "gatewayActiveNonStreamTtfbMedianMs",
    "gatewayActiveNonStreamTtfbP95Ms",
    "gatewayActiveStreamTtfbMedianMs",
    "gatewayActiveStreamTtfbP95Ms",
    "gatewayActiveStreamInterEventMedianMs",
    "gatewayActiveStreamInterEventP95Ms",
  ],
};

const FIXED_PROTOCOL = {
  processTree: "pid-birth-image identity descendants; retained after reparent",
  percentile: "nearest-rank",
  median: "midpoint for even sample counts",
};

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNullableNonEmptyString(value) {
  return value === null || isNonEmptyString(value);
}

function isCleanRelativePath(value) {
  return (
    isNonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isStructuredFailure(value) {
  return (
    isObject(value) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isStructuredWarning(value, runCount) {
  if (!isStructuredFailure(value)) return false;
  if (!Object.hasOwn(value, "runIndex")) return true;
  return Number.isSafeInteger(value.runIndex) && value.runIndex >= 0 && value.runIndex < runCount;
}

const ISOLATION_PATH_FIELDS = [
  "home",
  "appData",
  "roamingAppData",
  "localAppData",
  "xdgConfigHome",
  "xdgDataHome",
  "xdgCacheHome",
  "temp",
  "codexHome",
  "webviewData",
];

function isTokenizedRunPath(value) {
  return (
    typeof value === "string" &&
    (value === "$RUN_HOME" || value.startsWith("$RUN_HOME/")) &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function containsAbsolutePath(value) {
  if (typeof value !== "string") return false;
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, "<url>");
  return (
    /(^|[\s"'(=:])[A-Za-z]:[\\/]/.test(withoutUrls) ||
    /(^|[\s"'(=:])\\\\/.test(withoutUrls) ||
    /(^|[\s"'(=:])\/(?!\/)/.test(withoutUrls)
  );
}

function diagnosticContainsAbsolutePath(value) {
  if (typeof value === "string") return containsAbsolutePath(value);
  if (Array.isArray(value)) return value.some(diagnosticContainsAbsolutePath);
  if (isObject(value)) return Object.values(value).some(diagnosticContainsAbsolutePath);
  return false;
}

function validatePersistedRunPaths(run, runIndex, successful) {
  if (run.isolation != null || successful) {
    if (
      !isObject(run.isolation) ||
      Object.keys(run.isolation).sort().join("\n") !==
        [...ISOLATION_PATH_FIELDS].sort().join("\n") ||
      !ISOLATION_PATH_FIELDS.every((field) => isTokenizedRunPath(run.isolation[field]))
    ) {
      throw new Error(`raw run ${runIndex} isolation contains an invalid persisted path`);
    }
  }
  if (
    containsAbsolutePath(run.stdout) ||
    containsAbsolutePath(run.stderr) ||
    diagnosticContainsAbsolutePath({
      cleanup: run.cleanup,
      milestones: run.milestones,
      samples: run.samples,
      gatewayStub: run.gatewayStub,
      warnings: run.warnings,
      failures: run.failures,
    })
  ) {
    throw new Error(`raw run ${runIndex} diagnostic contains an absolute persisted path`);
  }
}

function validateEnvironment(environment) {
  const nullablePowerMetadata =
    environment?.power === null ||
    isNonEmptyString(environment?.power) ||
    isObject(environment?.power);
  if (
    !isObject(environment) ||
    !isNonEmptyString(environment.platform) ||
    !isNonEmptyString(environment.arch) ||
    !isNonEmptyString(environment.osRelease) ||
    !isNonEmptyString(environment.kernelType) ||
    !isNullableNonEmptyString(environment.cpuModel) ||
    !Number.isSafeInteger(environment.logicalCpuCount) ||
    environment.logicalCpuCount < 1 ||
    !Number.isSafeInteger(environment.totalMemoryBytes) ||
    environment.totalMemoryBytes < 1 ||
    !isNonEmptyString(environment.nodeVersion) ||
    environment.locale !== "C.UTF-8" ||
    environment.timezone !== "UTC" ||
    !isNullableNonEmptyString(environment.gpuRenderer) ||
    !isNullableNonEmptyString(environment.webViewRuntime) ||
    !nullablePowerMetadata
  ) {
    throw new Error("baseline result environment metadata is invalid");
  }
  const expectedProcessMetrics = processCollectorCapabilities(environment.platform);
  if (!isDeepStrictEqual(environment.processMetrics, expectedProcessMetrics)) {
    throw new Error(
      "baseline result process metric capabilities contradict the platform collector"
    );
  }
}

function validateSuccessfulIdleCapabilities(environment, scenario, runIndex) {
  if (scenario !== "visible-idle" && scenario !== "hidden-tray") return;
  const processMetrics = environment.processMetrics;
  if (
    processMetrics.identity.precision !== "exact" ||
    processMetrics.metrics.workingSetBytes.availability !== "available" ||
    processMetrics.metrics.privateBytes.availability !== "available" ||
    processMetrics.metrics.cpuTimeMs.availability !== "available"
  ) {
    throw new Error(
      `successful raw run ${runIndex} cannot satisfy idle process metrics with ${processMetrics.collector}`
    );
  }
}

function validateWarmupSummaries(summaries, protocol) {
  if (!Array.isArray(summaries) || summaries.length !== protocol.warmups) {
    throw new Error("baseline result warmupSummaries must contain protocol.warmups entries");
  }
  for (const [index, summary] of summaries.entries()) {
    if (
      !isObject(summary) ||
      summary.index !== index ||
      summary.exitCode !== 0 ||
      !isNonNegativeFinite(summary.durationMs) ||
      !Array.isArray(summary.warnings) ||
      !summary.warnings.every(
        (warning) =>
          isStructuredFailure(warning) &&
          !Object.hasOwn(warning, "runIndex") &&
          !diagnosticContainsAbsolutePath(warning)
      ) ||
      !Array.isArray(summary.failures) ||
      summary.failures.length !== 0
    ) {
      throw new Error(`baseline result warmup summary ${index} is invalid`);
    }
  }
}

function validateSuccessfulSamples(samples, runIndex) {
  if (samples.length === 0) {
    throw new Error(`successful raw run ${runIndex} must contain process samples`);
  }
  let previousAtMs = -Infinity;
  for (const [sampleIndex, sample] of samples.entries()) {
    if (
      !isObject(sample) ||
      !isNonNegativeFinite(sample.atMs) ||
      sample.atMs <= previousAtMs ||
      !isNonNegativeFinite(sample.atUnixMs) ||
      !Array.isArray(sample.processes) ||
      sample.processes.length === 0
    ) {
      throw new Error(`successful raw run ${runIndex} has invalid sample ${sampleIndex}`);
    }
    previousAtMs = sample.atMs;
    const identities = new Set();
    for (const process of sample.processes) {
      if (
        !isObject(process) ||
        !Number.isSafeInteger(process.pid) ||
        process.pid < 1 ||
        !Number.isSafeInteger(process.ppid) ||
        process.ppid < 0 ||
        typeof process.birthToken !== "string" ||
        process.birthToken.length === 0 ||
        !["exact", "coarse"].includes(process.identityPrecision) ||
        typeof process.imageName !== "string" ||
        process.imageName.length === 0 ||
        !["workingSetBytes", "privateBytes", "cpuTimeMs"].every(
          (name) => process[name] === null || isNonNegativeFinite(process[name])
        )
      ) {
        throw new Error(
          `successful raw run ${runIndex} has invalid process at sample ${sampleIndex}`
        );
      }
      const identity = processIdentityKey(process);
      if (identities.has(identity)) {
        throw new Error(
          `successful raw run ${runIndex} has duplicate process identity at sample ${sampleIndex}`
        );
      }
      identities.add(identity);
    }
    const totals = sample.totals;
    if (
      !isObject(totals) ||
      !Number.isSafeInteger(totals.processCount) ||
      totals.processCount < 0 ||
      !["workingSetBytes", "privateBytes", "cpuTimeMs"].every(
        (name) => totals[name] === null || isNonNegativeFinite(totals[name])
      )
    ) {
      throw new Error(
        `successful raw run ${runIndex} has invalid process sample totals at index ${sampleIndex}`
      );
    }
    const expectedTotals = aggregateProcessSample(sample.processes);
    for (const name of ["processCount", "workingSetBytes", "privateBytes", "cpuTimeMs"]) {
      if (!Object.is(totals[name], expectedTotals[name])) {
        throw new Error(
          `successful raw run ${runIndex} process sample totals mismatch at index ${sampleIndex}`
        );
      }
    }
  }
}

function validateSuccessfulMilestoneRows(run, runIndex, expectedAppVersion) {
  if (typeof run.runId !== "string" || run.runId.length === 0) {
    throw new Error(`successful raw run ${runIndex} must contain a runId`);
  }
  if (!isNonNegativeFinite(run.launchStartedUnixMs)) {
    throw new Error(`successful raw run ${runIndex} must contain launchStartedUnixMs`);
  }
  for (const [milestoneIndex, milestone] of run.milestones.entries()) {
    if (
      !isObject(milestone) ||
      typeof milestone.milestone !== "string" ||
      milestone.milestone.length === 0 ||
      !isNonNegativeFinite(milestone.elapsedMs) ||
      !Number.isFinite(milestone.wallClockUnixMs) ||
      milestone.wallClockUnixMs < run.launchStartedUnixMs ||
      !isObject(milestone.data)
    ) {
      throw new Error(`successful raw run ${runIndex} has invalid milestone row ${milestoneIndex}`);
    }
  }
  const processEntry = run.milestones.find((milestone) => milestone.milestone === "process_entry");
  if (processEntry?.data?.appVersion !== expectedAppVersion) {
    throw new Error(
      `successful raw run ${runIndex} embedded app version does not match app.version`
    );
  }
}

function validateAggregate(name, aggregate, expectedSamples) {
  if (
    !isObject(aggregate) ||
    !Array.isArray(aggregate.samples) ||
    aggregate.samples.length === 0 ||
    !aggregate.samples.every(Number.isFinite)
  ) {
    throw new Error(`invalid aggregate: ${name}`);
  }
  if (
    aggregate.samples.length !== expectedSamples.length ||
    aggregate.samples.some((sample, index) => !Object.is(sample, expectedSamples[index]))
  ) {
    throw new Error(`aggregate ${name}.samples do not match raw run metrics`);
  }
  const expected = aggregateValues(expectedSamples);
  for (const field of ["min", "max", "median", "p95"]) {
    if (!Object.is(aggregate[field], expected[field])) {
      throw new Error(`invalid aggregate ${name}.${field}`);
    }
  }
}

export function validateBaselineResult(value) {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new Error("baseline result schemaVersion must be 1");
  }
  if (!new Set(["complete", "diagnostic"]).has(value.status)) {
    throw new Error("baseline result status must be complete or diagnostic");
  }
  if (!isObject(value.tool) || value.tool.name !== "egui-baseline" || value.tool.version !== 1) {
    throw new Error("baseline result tool identity is invalid");
  }
  if (
    !isObject(value.repository) ||
    !/^[0-9a-f]{40}$/.test(value.repository.commit) ||
    typeof value.repository.dirty !== "boolean" ||
    !/^[0-9a-f]{64}$/.test(value.repository.statusSha256)
  ) {
    throw new Error("baseline result repository metadata is invalid");
  }
  const expectedBuildTarget = supportedHostTarget(
    value.environment?.platform,
    value.environment?.arch
  );
  if (expectedBuildTarget == null) {
    throw new Error("baseline result uses an unsupported platform or architecture target");
  }
  if (
    !isObject(value.app) ||
    typeof value.app.version !== "string" ||
    !isCleanRelativePath(value.app.executable) ||
    !/^[0-9a-f]{64}$/.test(value.app.executableSha256) ||
    !Number.isSafeInteger(value.app.executableBytes) ||
    value.app.executableBytes < 1 ||
    !Array.isArray(value.app.installers) ||
    value.app.installers.length === 0 ||
    !isObject(value.app.buildProvenance) ||
    !isCleanRelativePath(value.app.buildProvenance.path) ||
    !/^[0-9a-f]{64}$/.test(value.app.buildProvenance.sha256) ||
    value.app.buildProvenance.profile !== "release" ||
    value.app.buildProvenance.target !== expectedBuildTarget ||
    value.app.buildProvenance.producer !== "scripts/tauri-build.mjs" ||
    (value.app.buildProvenance.configOverlaySha256 !== null &&
      !/^[0-9a-f]{64}$/.test(value.app.buildProvenance.configOverlaySha256))
  ) {
    throw new Error("baseline result app installer or build provenance metadata is invalid");
  }
  for (const installer of value.app.installers) {
    if (
      !isObject(installer) ||
      !["file", "app-bundle"].includes(installer.kind) ||
      !isCleanRelativePath(installer.path) ||
      !Number.isSafeInteger(installer.bytes) ||
      installer.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(installer.sha256)
    ) {
      throw new Error("baseline result installer metadata is invalid");
    }
  }
  validateEnvironment(value.environment);
  if (
    !isObject(value.protocol) ||
    !Number.isSafeInteger(value.protocol.warmups) ||
    value.protocol.warmups < 2 ||
    !Number.isSafeInteger(value.protocol.runs) ||
    value.protocol.runs < 10 ||
    !Number.isSafeInteger(value.protocol.sampleIntervalMs) ||
    value.protocol.sampleIntervalMs < 100 ||
    value.protocol.sampleIntervalMs > 10_000 ||
    value.protocol.processTree !== FIXED_PROTOCOL.processTree ||
    value.protocol.percentile !== FIXED_PROTOCOL.percentile ||
    value.protocol.median !== FIXED_PROTOCOL.median
  ) {
    throw new Error("baseline result protocol metadata is invalid");
  }
  if (
    !isObject(value.scenario) ||
    typeof value.scenario.id !== "string" ||
    value.scenario.fixture !== "current" ||
    !/^[0-9a-f]{64}$/.test(value.scenario.fixtureHash) ||
    !isObject(value.scenario.fixtureArtifacts) ||
    !Object.hasOwn(REQUIRED_SCENARIO_METRICS, value.scenario.id)
  ) {
    throw new Error("baseline result scenario metadata is invalid");
  }
  const expectedFixtureArtifactNames = [
    "aio-coding-hub.db",
    "settings.json",
    ...(value.scenario.id === "logs-10k" ? ["request-logs-10000.jsonl"] : []),
  ];
  if (
    Object.keys(value.scenario.fixtureArtifacts).sort().join("\n") !==
    expectedFixtureArtifactNames.sort().join("\n")
  ) {
    throw new Error("baseline result fixtureArtifacts do not match the formal scenario");
  }
  for (const [name, metadata] of Object.entries(value.scenario.fixtureArtifacts)) {
    if (
      !isObject(metadata) ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
      (name === "request-logs-10000.jsonl" && metadata.rowCount !== 10_000)
    ) {
      throw new Error(`baseline result fixture artifact metadata is invalid: ${name}`);
    }
  }
  const expectedFixtureHash = createHash("sha256")
    .update(
      Object.entries(value.scenario.fixtureArtifacts)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([name, metadata]) => `${name}\u0000${metadata.sha256}`)
        .join("\n")
    )
    .digest("hex");
  if (value.scenario.fixtureHash !== expectedFixtureHash) {
    throw new Error("baseline result fixtureHash does not match fixtureArtifacts");
  }
  const formalDurationMs =
    value.scenario.id === "visible-idle"
      ? 60_000
      : value.scenario.id === "hidden-tray"
        ? 600_000
        : null;
  if (value.scenario.durationMs !== formalDurationMs) {
    throw new Error(
      `baseline result scenario.durationMs must be ${formalDurationMs ?? "null"} for ${value.scenario.id}`
    );
  }
  if (
    !isObject(value.scenario.window) ||
    value.scenario.window.width !== 1500 ||
    value.scenario.window.height !== 900 ||
    value.scenario.window.startMinimized !== (value.scenario.id === "hidden-tray")
  ) {
    throw new Error("baseline result scenario window metadata is invalid");
  }
  validateWarmupSummaries(value.warmupSummaries, value.protocol);
  if (!Array.isArray(value.warnings) || !Array.isArray(value.failures)) {
    throw new Error("baseline result warnings and failures must be arrays");
  }
  for (const warning of value.warnings) {
    if (
      !isStructuredWarning(warning, value.protocol.runs) ||
      diagnosticContainsAbsolutePath(warning)
    ) {
      throw new Error("baseline result contains an invalid structured warning");
    }
  }
  for (const failure of value.failures) {
    if (
      !isStructuredFailure(failure) ||
      !Number.isSafeInteger(failure.runIndex) ||
      failure.runIndex < 0 ||
      failure.runIndex >= value.protocol.runs ||
      diagnosticContainsAbsolutePath(failure)
    ) {
      throw new Error("baseline result contains an invalid structured failure");
    }
  }
  if (!Array.isArray(value.rawRuns) || value.rawRuns.length !== value.protocol.runs) {
    throw new Error("rawRuns must contain protocol.runs entries");
  }
  const rawMetricSamples = new Map();
  for (const [runIndex, run] of value.rawRuns.entries()) {
    if (
      !isObject(run) ||
      !Array.isArray(run.milestones) ||
      !Array.isArray(run.samples) ||
      !isObject(run.metrics) ||
      !Array.isArray(run.warnings) ||
      !Array.isArray(run.failures) ||
      typeof run.stdout !== "string" ||
      typeof run.stderr !== "string"
    ) {
      throw new Error(
        "each raw run must contain milestones, samples, metrics, warnings, and failures"
      );
    }
    for (const warning of run.warnings) {
      if (!isStructuredFailure(warning) || Object.hasOwn(warning, "runIndex")) {
        throw new Error(`raw run ${runIndex} contains an invalid structured warning`);
      }
      if (
        !value.warnings.some(
          (globalWarning) =>
            globalWarning.runIndex === runIndex &&
            globalWarning.code === warning.code &&
            globalWarning.message === warning.message
        )
      ) {
        throw new Error(`raw run ${runIndex} warning is missing from baseline result warnings`);
      }
    }
    for (const failure of run.failures) {
      if (!isStructuredFailure(failure)) {
        throw new Error(`raw run ${runIndex} contains an invalid structured failure`);
      }
      if (
        !value.failures.some(
          (globalFailure) =>
            globalFailure.runIndex === runIndex &&
            globalFailure.code === failure.code &&
            globalFailure.message === failure.message
        )
      ) {
        throw new Error(`raw run ${runIndex} failure is missing from baseline result failures`);
      }
    }
    for (const [name, metric] of Object.entries(run.metrics)) {
      if (!isNonNegativeFinite(metric)) {
        throw new Error(`raw run ${runIndex} has invalid metric ${name}`);
      }
    }

    validatePersistedRunPaths(run, runIndex, run.failures.length === 0 && run.exitCode === 0);
    if (run.failures.length > 0) continue;
    if (run.exitCode !== 0) {
      throw new Error(`successful raw run ${runIndex} must have exitCode 0`);
    }
    validateSuccessfulIdleCapabilities(value.environment, value.scenario.id, runIndex);
    if (value.scenario.id === "gateway-load") {
      validateGatewayStubEvidence(run.gatewayStub);
    } else if (run.gatewayStub != null) {
      throw new Error(`successful raw run ${runIndex} contains unexpected gateway stub evidence`);
    }
    validateSuccessfulSamples(run.samples, runIndex);
    validateSuccessfulMilestoneRows(run, runIndex, value.app.version);
    const milestoneFailure = validateMilestones(run.milestones, run.runId, value.scenario.id)[0];
    if (milestoneFailure) {
      throw new Error(`successful raw run ${runIndex}: ${milestoneFailure.message}`);
    }
    const coverageFailure = validateProcessSampleCoverage(
      run,
      value.protocol.sampleIntervalMs,
      value.scenario.durationMs
    )[0];
    if (coverageFailure) {
      throw new Error(`successful raw run ${runIndex}: ${coverageFailure.message}`);
    }
    const extractedMetrics = extractRunMetrics(run);
    for (const [name, expectedMetric] of Object.entries(extractedMetrics)) {
      if (!Object.is(run.metrics[name], expectedMetric)) {
        throw new Error(`successful raw run ${runIndex} has invalid metric ${name}`);
      }
    }
    for (const name of REQUIRED_SCENARIO_METRICS[value.scenario.id]) {
      if (!Number.isFinite(extractedMetrics[name]) || !Number.isFinite(run.metrics[name])) {
        throw new Error(
          `successful raw run ${runIndex} is missing required scenario metric ${name}`
        );
      }
    }
    for (const [name, metric] of Object.entries(run.metrics)) {
      const samples = rawMetricSamples.get(name) ?? [];
      samples.push(metric);
      rawMetricSamples.set(name, samples);
    }
  }
  for (const failure of value.failures) {
    const matchingRunFailure = value.rawRuns[failure.runIndex].failures.some(
      (runFailure) => runFailure.code === failure.code && runFailure.message === failure.message
    );
    if (!matchingRunFailure) {
      throw new Error(`baseline result failure for raw run ${failure.runIndex} is not mirrored`);
    }
  }
  for (const warning of value.warnings) {
    if (!Object.hasOwn(warning, "runIndex")) continue;
    const matchingRunWarning = value.rawRuns[warning.runIndex].warnings.some(
      (runWarning) => runWarning.code === warning.code && runWarning.message === warning.message
    );
    if (!matchingRunWarning) {
      throw new Error(`baseline result warning for raw run ${warning.runIndex} is not mirrored`);
    }
  }
  if (!isObject(value.aggregates)) throw new Error("baseline result aggregates are required");
  for (const name of rawMetricSamples.keys()) {
    if (!Object.hasOwn(value.aggregates, name)) {
      throw new Error(`baseline result aggregate ${name} is required`);
    }
  }
  for (const [name, aggregate] of Object.entries(value.aggregates)) {
    validateAggregate(name, aggregate, rawMetricSamples.get(name) ?? []);
  }
  const expectedStatus = value.rawRuns.every(
    (run) => run.exitCode === 0 && run.failures.length === 0
  )
    ? "complete"
    : "diagnostic";
  if (value.status !== expectedStatus) {
    throw new Error(`baseline result status must be ${expectedStatus} for its raw runs`);
  }
  const expectedPendingPlatforms = ["win32", "darwin", "linux"].filter(
    (platform) => platform !== value.environment.platform
  );
  if (
    !Array.isArray(value.pendingPlatforms) ||
    !isDeepStrictEqual(value.pendingPlatforms, expectedPendingPlatforms)
  ) {
    throw new Error("baseline result pendingPlatforms do not match the measured host");
  }
  return value;
}

export function validateCompleteBaselineResult(value) {
  validateBaselineResult(value);
  if (value.status !== "complete") {
    throw new Error("only a complete baseline result may enter the versioned registry");
  }
  return value;
}
