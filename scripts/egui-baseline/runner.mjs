import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ProcessTreeTracker,
  aggregateProcessSample,
  collectProcessSnapshot,
  processCollectorCapabilities,
  processIdentityKey,
} from "./process-tree.mjs";
import { aggregateValues } from "./stats.mjs";
import { startGatewayStub, validateGatewayStubEvidence } from "./gateway-stub.mjs";
import { collectFormalReleaseProvenance, sha256File } from "./release-provenance.mjs";
import {
  buildIsolatedProcessEnvironment,
  createRunWorkspace,
  reuseRunWorkspace,
} from "./workspace.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "..", "..");
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SAFE_FAILURE_CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_FAILURE_MESSAGE_LENGTH = 512;
const MAX_FAILURE_SUMMARY_LENGTH = 4_096;

function sanitizeFailureMessage(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]"
    )
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[URL]")
    .replace(/\b[A-Za-z]:[\\/][^\s]+/g, "[PATH]")
    .replace(/(^|\s)\/(?:[^/\s]+\/)+[^/\s]*/g, "$1[PATH]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function scenarioFailedDiagnostic(row) {
  const data = row?.data;
  const reportedCode = SAFE_FAILURE_CODE.test(data?.errorCode) ? data.errorCode : null;
  const context = [data?.condition, data?.stage].filter(
    (value) => typeof value === "string" && SAFE_FAILURE_CONTEXT.test(value)
  );
  const detail = sanitizeFailureMessage(data?.errorMessage);
  const qualifiers = [...context, ...(reportedCode == null ? [] : [reportedCode])];
  return {
    code: "SCENARIO_FAILED",
    ...(reportedCode == null ? {} : { reportedCode }),
    message: `frontend reported scenario_failed${
      qualifiers.length === 0 ? "" : ` [${qualifiers.join("/")}]`
    }${detail.length === 0 ? "" : `: ${detail}`}`,
  };
}

export function formatFailureSummary(failures) {
  const prioritized = [...failures].sort(
    (left, right) =>
      Number(right?.code === "SCENARIO_FAILED") - Number(left?.code === "SCENARIO_FAILED")
  );
  return prioritized
    .map((failure) => {
      const code = SAFE_FAILURE_CODE.test(failure?.code) ? failure.code : "UNKNOWN_FAILURE";
      const message = sanitizeFailureMessage(failure?.message);
      return message.length === 0 ? code : `${code}: ${message}`;
    })
    .join(", ")
    .slice(0, MAX_FAILURE_SUMMARY_LENGTH);
}

export function assertStableBenchmarkInput(label, expected, actual) {
  if (expected !== actual) throw new Error(`${label} changed during the benchmark run`);
}

export function mergePreparedFixtureEvidence(current, workspace) {
  if (
    !/^[0-9a-f]{64}$/.test(workspace?.fixtureHash) ||
    workspace?.fixtureArtifacts == null ||
    typeof workspace.fixtureArtifacts !== "object" ||
    Array.isArray(workspace.fixtureArtifacts)
  ) {
    throw new Error("prepared fixture evidence is incomplete");
  }
  const next = {
    fixtureHash: workspace.fixtureHash,
    fixtureArtifacts: workspace.fixtureArtifacts,
  };
  if (current == null) return next;
  assertStableBenchmarkInput("prepared fixture", current.fixtureHash, next.fixtureHash);
  assertStableBenchmarkInput(
    "prepared fixture artifacts",
    JSON.stringify(current.fixtureArtifacts),
    JSON.stringify(next.fixtureArtifacts)
  );
  return current;
}

function replacePathPrefix(value, source, token) {
  let redacted = value;
  const variants = new Set([source, source.replaceAll("\\", "/"), source.replaceAll("/", "\\")]);
  for (const variant of variants) {
    if (variant.length === 0) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "gi"), token);
  }
  return redacted;
}

function redactDiagnosticValue(value, replacements) {
  if (typeof value === "string") {
    return replacements
      .reduce((current, [source, token]) => replacePathPrefix(current, source, token), value)
      .replaceAll("\\", "/");
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, replacements));
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDiagnosticValue(item, replacements)])
    );
  }
  return value;
}

export function redactPersistedRunPaths(run, { workspace, realHome = os.homedir() }) {
  const replacements = [
    [workspace.home, "$RUN_HOME"],
    [workspace.runRoot, "$RUN_ROOT"],
    [path.dirname(workspace.runRoot), "$BENCH_ROOT"],
    [repositoryRoot, "$REPO"],
    [realHome, "$REAL_HOME"],
  ].sort(([left], [right]) => right.length - left.length);
  const redact = (value) => redactDiagnosticValue(value, replacements);
  return {
    ...run,
    isolation: Object.fromEntries(
      Object.entries(run.isolation ?? {}).map(([key, value]) => [
        key,
        redact(value).replaceAll("\\", "/"),
      ])
    ),
    cleanup: redact(run.cleanup),
    stdout: redact(run.stdout),
    stderr: redact(run.stderr),
    warnings: redact(run.warnings),
    failures: redact(run.failures),
  };
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function findRootIdentity(pid, deadlineMs = 5_000) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    const snapshot = await collectProcessSnapshot({ timeoutMs: remainingMs });
    const root = snapshot.find((row) => row.pid === pid);
    if (root) return { root, snapshot };
    await delay(25);
  }
  throw new Error(`spawned root PID ${pid} was not observable before timeout`);
}

export async function terminateTrackedDescendants(
  tracker,
  {
    collectSnapshot = collectProcessSnapshot,
    terminatePid = (pid) => process.kill(pid, "SIGKILL"),
  } = {}
) {
  const result = { terminated: [], skipped: [], errors: [] };
  let snapshot;
  try {
    snapshot = await collectSnapshot();
  } catch (error) {
    result.errors.push({ reason: "snapshot_failed", message: error.message });
    return result;
  }
  const candidates = tracker.acceptSnapshot(snapshot).sort((left, right) => right.pid - left.pid);
  const owned = [];
  for (const row of candidates) {
    if (tracker.owns(row)) owned.push(row);
    else if (row.identityPrecision !== "exact") {
      result.skipped.push({ pid: row.pid, reason: "identity_precision_coarse" });
    }
  }
  for (const row of owned) {
    let currentSnapshot;
    try {
      currentSnapshot = await collectSnapshot();
    } catch (error) {
      result.errors.push({ pid: row.pid, reason: "snapshot_failed", message: error.message });
      continue;
    }
    const current = currentSnapshot.find((candidate) => candidate.pid === row.pid);
    if (!current || processIdentityKey(current) !== processIdentityKey(row)) continue;
    try {
      terminatePid(row.pid);
      result.terminated.push(row.pid);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        result.errors.push({ pid: row.pid, reason: "terminate_failed", message: error.message });
      }
    }
  }
  return result;
}

function boundedOutput(stream, maxBytes = 64 * 1024) {
  let output = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    if (output.length < maxBytes) output += chunk.slice(0, maxBytes - output.length);
  });
  return () => output;
}

function gatewayPhaseOrder(runId) {
  const numericSuffix = /-([0-9]+)$/.exec(runId)?.[1];
  if (numericSuffix == null) return ["idle", "active"];
  const finalDigit = Number(numericSuffix.at(-1));
  return finalDigit % 2 === 0 ? ["active", "idle"] : ["idle", "active"];
}

function requiredMilestones(scenario, runId = "") {
  const milestones = [
    "process_entry",
    "tauri_setup_started",
    "tauri_setup_completed",
    "startup_run_started",
    "db_ready",
    "settings_ready",
    scenario === "hidden-tray" ? "window_hidden" : "window_visible",
    "gateway_bound",
    "gateway_ready",
    "startup_ready",
  ];
  if (scenario !== "hidden-tray") milestones.push("first_interactive");
  if (scenario === "logs-10k") {
    milestones.push("logs_dataset_ready", "logs_filter_painted", "logs_select_painted");
  }
  if (scenario === "gateway-load") {
    for (const condition of gatewayPhaseOrder(runId)) {
      milestones.push(`gateway_load_${condition}_started`, `gateway_load_${condition}_completed`);
    }
    milestones.push("gateway_load_ready", "gateway_load_completed");
  }
  milestones.push("scenario_completed", "shutdown_started", "shutdown_completed");
  return milestones;
}

function validateMilestones(rows, runId, scenario) {
  const failures = [];
  let previousElapsed = -Infinity;
  for (const [index, row] of rows.entries()) {
    if (
      row?.schemaVersion !== 1 ||
      row.runId !== runId ||
      row.scenario !== scenario ||
      row.seq !== index + 1 ||
      !Number.isFinite(row.elapsedMs) ||
      row.elapsedMs < previousElapsed
    ) {
      failures.push({
        code: "INVALID_MILESTONE_ROW",
        message: `invalid milestone row at index ${index}`,
      });
      break;
    }
    previousElapsed = row.elapsedMs;
  }
  const required = requiredMilestones(scenario, runId);
  const names = new Set(rows.map((row) => row.milestone));
  const counts = new Map();
  for (const row of rows) counts.set(row.milestone, (counts.get(row.milestone) ?? 0) + 1);
  for (const milestone of required) {
    if (!names.has(milestone)) {
      failures.push({ code: "MISSING_MILESTONE", milestone, message: `missing ${milestone}` });
    } else if (counts.get(milestone) !== 1) {
      failures.push({
        code: "MILESTONE_CARDINALITY_INVALID",
        milestone,
        message: `${milestone} must occur exactly once`,
      });
    }
  }
  const allowed = new Set([...required, "scenario_failed"]);
  const unexpected = rows.find((row) => !allowed.has(row.milestone));
  if (unexpected) {
    failures.push({
      code: "UNEXPECTED_MILESTONE",
      milestone: unexpected.milestone,
      message: `unexpected milestone ${unexpected.milestone}`,
    });
  }
  const assertOrder = (milestones, label) => {
    const indexes = milestones.map((milestone) =>
      rows.findIndex((row) => row.milestone === milestone)
    );
    if (
      indexes.every((index) => index >= 0) &&
      indexes.some((index, position) => position > 0 && index <= indexes[position - 1])
    ) {
      failures.push({
        code: "MILESTONE_ORDER_INVALID",
        message: `${label} milestone order must be ${milestones.join(" -> ")}`,
      });
    }
  };
  const windowMilestone = scenario === "hidden-tray" ? "window_hidden" : "window_visible";
  assertOrder(
    [
      "process_entry",
      "tauri_setup_started",
      "tauri_setup_completed",
      "startup_run_started",
      "db_ready",
      "settings_ready",
      windowMilestone,
      "gateway_bound",
      "gateway_ready",
      "startup_ready",
      "scenario_completed",
      "shutdown_started",
      "shutdown_completed",
    ],
    "core"
  );
  if (scenario !== "hidden-tray") {
    assertOrder(["startup_ready", "first_interactive", "scenario_completed"], "first interactive");
  }
  if (scenario === "logs-10k") {
    assertOrder(
      [
        "startup_ready",
        "logs_dataset_ready",
        "logs_filter_painted",
        "logs_select_painted",
        "scenario_completed",
      ],
      "logs"
    );
  }
  if (names.has("scenario_failed")) {
    failures.push(
      scenarioFailedDiagnostic(rows.find((row) => row.milestone === "scenario_failed"))
    );
  }
  const windowData = rows.find((row) => row.milestone === windowMilestone)?.data;
  const windowValues = [
    windowData?.physicalWidth,
    windowData?.physicalHeight,
    windowData?.logicalWidth,
    windowData?.logicalHeight,
    windowData?.scaleFactor,
  ];
  if (!windowValues.every((value) => Number.isFinite(value) && value > 0)) {
    failures.push({
      code: "MISSING_WINDOW_MEASUREMENT",
      milestone: windowMilestone,
      message: `${windowMilestone} did not report positive physical/logical size and scale`,
    });
  } else if (
    Math.abs(windowData.logicalWidth - 1500) > 1 ||
    Math.abs(windowData.logicalHeight - 900) > 1
  ) {
    failures.push({
      code: "WINDOW_SIZE_MISMATCH",
      milestone: windowMilestone,
      message: `${windowMilestone} measured ${windowData.logicalWidth}x${windowData.logicalHeight}; expected 1500x900 logical pixels`,
    });
  }
  if (scenario === "gateway-load") {
    for (const milestone of ["gateway_load_idle_completed", "gateway_load_active_completed"]) {
      const data = rows.find((row) => row.milestone === milestone)?.data;
      if (
        data?.streamRequests !== 4 ||
        data?.streamDataEvents !== 5 ||
        data?.streamDoneEvents !== 1 ||
        data?.streamEventIntervalMs !== 20 ||
        !Array.isArray(data?.streamTtfbMs) ||
        data.streamTtfbMs.length !== 4 ||
        !data.streamTtfbMs.every(Number.isFinite) ||
        !Array.isArray(data?.streamInterEventMs) ||
        data.streamInterEventMs.length !== 20 ||
        !data.streamInterEventMs.every(Number.isFinite) ||
        !Array.isArray(data?.observedStreamTransportChunks) ||
        data.observedStreamTransportChunks.length !== 4 ||
        !data.observedStreamTransportChunks.every(
          (count) => Number.isSafeInteger(count) && count > 0
        )
      ) {
        failures.push({
          code: "MISSING_GATEWAY_STREAM_TIMING",
          milestone,
          message: `${milestone} did not report stream timing samples`,
        });
      }
    }
    const activeFrameCount = rows.find((row) => row.milestone === "gateway_load_completed")?.data
      ?.activeFrameCount;
    if (!Number.isSafeInteger(activeFrameCount) || activeFrameCount < 1) {
      failures.push({
        code: "GATEWAY_ACTIVE_UI_NOT_COMMITTED",
        milestone: "gateway_load_completed",
        message: "gateway active load did not report a committed React frame",
      });
    }
    const expectedPhaseMilestones = gatewayPhaseOrder(runId).flatMap((condition) => [
      `gateway_load_${condition}_started`,
      `gateway_load_${condition}_completed`,
    ]);
    const actualPhaseMilestones = rows
      .map((row) => row.milestone)
      .filter((milestone) => /^gateway_load_(idle|active)_(started|completed)$/.test(milestone));
    const phaseEndIndex = Math.max(
      ...actualPhaseMilestones.map((milestone) =>
        rows.findIndex((row) => row.milestone === milestone)
      )
    );
    const readyIndex = rows.findIndex((row) => row.milestone === "gateway_load_ready");
    const completedIndex = rows.findIndex((row) => row.milestone === "gateway_load_completed");
    if (
      actualPhaseMilestones.length !== expectedPhaseMilestones.length ||
      actualPhaseMilestones.some(
        (milestone, index) => milestone !== expectedPhaseMilestones[index]
      ) ||
      readyIndex <= phaseEndIndex ||
      completedIndex <= readyIndex
    ) {
      failures.push({
        code: "GATEWAY_PHASE_ORDER_MISMATCH",
        message: `gateway phase milestones do not match ${expectedPhaseMilestones.join(" -> ")}`,
      });
    }
    assertOrder(
      [
        "startup_ready",
        ...expectedPhaseMilestones,
        "gateway_load_ready",
        "gateway_load_completed",
        "scenario_completed",
      ],
      "gateway"
    );
  }
  return failures;
}

export function validateEmbeddedAppVersion(milestones, expectedVersion) {
  const observedVersion = milestones.find((row) => row.milestone === "process_entry")?.data
    ?.appVersion;
  if (observedVersion === expectedVersion) return [];
  return [
    {
      code: "APP_VERSION_MISMATCH",
      message: `compiled app version ${observedVersion ?? "<missing>"} does not match build manifest package version ${expectedVersion}`,
    },
  ];
}

function medianOrNull(values) {
  return values.length === 0 ? null : aggregateValues(values).median;
}

function processTreeCpuDelta(samples) {
  const ranges = new Map();
  let sawProcess = false;
  for (const sample of samples) {
    for (const process of sample.processes ?? []) {
      sawProcess = true;
      if (process.identityPrecision !== "exact" || !Number.isFinite(process.cpuTimeMs)) {
        return null;
      }
      const key = processIdentityKey(process);
      const range = ranges.get(key) ?? { min: process.cpuTimeMs, max: process.cpuTimeMs };
      range.min = Math.min(range.min, process.cpuTimeMs);
      range.max = Math.max(range.max, process.cpuTimeMs);
      ranges.set(key, range);
    }
  }
  if (!sawProcess) return null;
  return [...ranges.values()].reduce((total, range) => total + range.max - range.min, 0);
}

function runnerElapsedAtMilestone(run, milestones, key) {
  const target = milestones.get(key);
  if (!target || !Number.isFinite(run.launchStartedUnixMs)) return null;
  const processEntry = milestones.get("process_entry");
  if (
    processEntry &&
    Number.isFinite(processEntry.wallClockUnixMs) &&
    Number.isFinite(processEntry.elapsedMs) &&
    Number.isFinite(target.elapsedMs)
  ) {
    const launchToEntryMs = processEntry.wallClockUnixMs - run.launchStartedUnixMs;
    const value = launchToEntryMs + target.elapsedMs - processEntry.elapsedMs;
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const value = target.wallClockUnixMs - run.launchStartedUnixMs;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function scenarioMeasurementWindow(run) {
  const scenario = run.scenario ?? run.milestones[0]?.scenario;
  if (scenario !== "visible-idle" && scenario !== "hidden-tray") return null;
  const milestones = new Map(run.milestones.map((row) => [row.milestone, row]));
  const startMs = runnerElapsedAtMilestone(run, milestones, "startup_ready");
  const endMs = runnerElapsedAtMilestone(run, milestones, "scenario_completed");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return { startMs, endMs };
}

function scenarioMetricSamples(run) {
  const window = scenarioMeasurementWindow(run);
  if (!window) return run.samples;
  return run.samples.filter(
    (sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs
  );
}

export function validateProcessSampleCoverage(run, sampleIntervalMs, durationMs) {
  const scenario = run.scenario ?? run.milestones[0]?.scenario;
  if (scenario !== "visible-idle" && scenario !== "hidden-tray") return [];
  const failures = [];
  const milestones = new Map(run.milestones.map((row) => [row.milestone, row]));
  const actualDurationMs =
    milestones.get("scenario_completed")?.elapsedMs - milestones.get("startup_ready")?.elapsedMs;
  if (!Number.isFinite(actualDurationMs) || actualDurationMs < durationMs) {
    failures.push({
      code: "IDLE_DURATION_TOO_SHORT",
      message: `${scenario} measured ${actualDurationMs}ms; expected at least ${durationMs}ms`,
    });
  }
  const window = scenarioMeasurementWindow(run);
  if (!window) {
    failures.push({
      code: "PROCESS_SAMPLE_WINDOW_MISSING",
      message: `${scenario} process sample window could not be aligned to startup milestones`,
    });
    return failures;
  }
  const samples = scenarioMetricSamples(run);
  const minimumSamples = Math.max(2, Math.floor((durationMs / sampleIntervalMs) * 0.9));
  if (samples.length < minimumSamples) {
    failures.push({
      code: "PROCESS_SAMPLE_COVERAGE_LOW",
      message: `${scenario} captured ${samples.length} in-window samples; expected at least ${minimumSamples}`,
    });
  }
  const boundaries = [window.startMs, ...samples.map((sample) => sample.atMs), window.endMs];
  const maximumGapMs = boundaries.reduce(
    (maximum, value, index) =>
      index === 0 ? maximum : Math.max(maximum, value - boundaries[index - 1]),
    0
  );
  if (maximumGapMs > sampleIntervalMs * 3) {
    failures.push({
      code: "PROCESS_SAMPLE_GAP_TOO_LARGE",
      message: `${scenario} process sample gap ${maximumGapMs}ms exceeds ${sampleIntervalMs * 3}ms`,
    });
  }
  return failures;
}

export function extractRunMetrics(run) {
  const milestone = new Map(run.milestones.map((row) => [row.milestone, row]));
  const metrics = {};
  for (const [name, key] of [
    ["tauriSetupCompletedMs", "tauri_setup_completed"],
    ["dbReadyMs", "db_ready"],
    ["gatewayReadyMs", "gateway_ready"],
    ["startupReadyMs", "startup_ready"],
    ["firstInteractiveMs", "first_interactive"],
    ["shutdownCompletedMs", "shutdown_completed"],
  ]) {
    const value = milestone.get(key)?.elapsedMs;
    if (Number.isFinite(value)) metrics[name] = value;
  }
  if (Number.isFinite(run.launchStartedUnixMs)) {
    for (const [name, key] of [
      ["launchToProcessEntryMs", "process_entry"],
      ["launchToTauriSetupCompletedMs", "tauri_setup_completed"],
      ["launchToDbReadyMs", "db_ready"],
      ["launchToGatewayReadyMs", "gateway_ready"],
      ["launchToStartupReadyMs", "startup_ready"],
      ["launchToFirstInteractiveMs", "first_interactive"],
      ["launchToShutdownCompletedMs", "shutdown_completed"],
    ]) {
      const value = runnerElapsedAtMilestone(run, milestone, key);
      if (Number.isFinite(value)) {
        metrics[name] = value;
      }
    }
  }
  const windowData =
    milestone.get("window_visible")?.data ?? milestone.get("window_hidden")?.data ?? null;
  if (windowData) {
    for (const [name, value] of [
      ["windowPhysicalWidth", windowData.physicalWidth],
      ["windowPhysicalHeight", windowData.physicalHeight],
      ["windowLogicalWidth", windowData.logicalWidth],
      ["windowLogicalHeight", windowData.logicalHeight],
      ["windowScaleFactor", windowData.scaleFactor],
    ]) {
      if (Number.isFinite(value)) metrics[name] = value;
    }
  }

  for (const [prefix, key] of [
    ["gatewayIdle", "gateway_load_idle_completed"],
    ["gatewayActive", "gateway_load_active_completed"],
  ]) {
    const data = milestone.get(key)?.data;
    if (!data) continue;
    if (Number.isFinite(data.throughputRequestsPerSecond)) {
      metrics[`${prefix}ThroughputRequestsPerSecond`] = data.throughputRequestsPerSecond;
    }
    for (const [suffix, values] of [
      ["NonStreamTtfb", data.nonStreamTtfbMs],
      ["StreamTtfb", data.streamTtfbMs],
      ["StreamInterEvent", data.streamInterEventMs],
    ]) {
      if (!Array.isArray(values) || values.length === 0 || !values.every(Number.isFinite)) continue;
      const aggregate = aggregateValues(values);
      metrics[`${prefix}${suffix}MedianMs`] = aggregate.median;
      metrics[`${prefix}${suffix}P95Ms`] = aggregate.p95;
    }
  }
  for (const [name, key] of [
    ["logsDatasetReadyMs", "logs_dataset_ready"],
    ["logsFilterPaintMs", "logs_filter_painted"],
    ["logsSelectPaintMs", "logs_select_painted"],
  ]) {
    const value = milestone.get(key)?.data?.durationMs;
    if (Number.isFinite(value)) metrics[name] = value;
  }

  const metricSamples = scenarioMetricSamples(run);
  const workingSet = metricSamples.map((sample) => sample.totals.workingSetBytes);
  const privateBytes = metricSamples.map((sample) => sample.totals.privateBytes);
  const processCounts = metricSamples.map((sample) => sample.totals.processCount);
  if (workingSet.length > 0 && workingSet.every(Number.isFinite)) {
    metrics.peakWorkingSetBytes = Math.max(...workingSet);
    metrics.medianWorkingSetBytes = medianOrNull(workingSet);
  }
  if (privateBytes.length > 0 && privateBytes.every(Number.isFinite)) {
    metrics.peakPrivateBytes = Math.max(...privateBytes);
  }
  const cpuTimeDeltaMs = processTreeCpuDelta(metricSamples);
  if (cpuTimeDeltaMs != null) metrics.cpuTimeDeltaMs = cpuTimeDeltaMs;
  if (processCounts.length > 0 && processCounts.every(Number.isFinite)) {
    metrics.maxProcessCount = Math.max(...processCounts);
  }
  return metrics;
}

const REQUIRED_IDLE_PROCESS_METRICS = [
  "peakWorkingSetBytes",
  "medianWorkingSetBytes",
  "peakPrivateBytes",
  "cpuTimeDeltaMs",
  "maxProcessCount",
];

export function validateIdleProcessMetrics(run) {
  const scenario = run.scenario ?? run.milestones?.[0]?.scenario;
  if (scenario !== "visible-idle" && scenario !== "hidden-tray") return [];
  return REQUIRED_IDLE_PROCESS_METRICS.filter((name) => !Number.isFinite(run.metrics?.[name])).map(
    (metric) => ({
      code: "PROCESS_METRIC_UNAVAILABLE",
      metric,
      message: `${scenario} could not derive required process metric ${metric}; unavailable counters remain null`,
    })
  );
}

export async function waitForProcessSampleInterval({
  exitPromise,
  sampleIntervalMs,
  waitMs = sampleIntervalMs,
  readExitInfo,
}) {
  await Promise.race([delay(waitMs), exitPromise]);
  return readExitInfo() == null;
}

export function processSampleWaitMs({
  launchedAtMs,
  sampleOrdinal,
  sampleIntervalMs,
  timeoutMs = Number.POSITIVE_INFINITY,
  nowMs,
}) {
  const nextSampleAtMs = launchedAtMs + sampleOrdinal * sampleIntervalMs;
  const deadlineAtMs = launchedAtMs + timeoutMs;
  return Math.max(0, Math.min(nextSampleAtMs, deadlineAtMs) - nowMs);
}

export function processSamplingDeadlineReached({ launchedAtMs, timeoutMs, nowMs }) {
  return nowMs - launchedAtMs >= timeoutMs;
}

export function appendProcessSample(samples, { atMs, atUnixMs, processes }) {
  if (processes.length === 0) return false;
  samples.push({
    atMs,
    atUnixMs,
    processes,
    totals: aggregateProcessSample(processes),
  });
  return true;
}

async function readMilestones(reportPath) {
  try {
    return parseJsonl(await readFile(reportPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function runApplicationOnce({
  executable,
  workspace,
  runId,
  scenario,
  durationMs,
  sampleIntervalMs,
  timeoutMs,
  gatewayUpstreamUrl,
}) {
  const env = {
    ...buildIsolatedProcessEnvironment(workspace.home),
    AIO_CODING_HUB_TEST_HOME: workspace.home,
    AIO_CODING_HUB_BENCHMARK_REPORT: workspace.reportPath,
    AIO_CODING_HUB_BENCHMARK_RUN_ID: runId,
    AIO_CODING_HUB_BENCHMARK_SCENARIO: scenario,
    CODEX_HOME: path.join(workspace.home, ".codex"),
    ...(durationMs == null ? {} : { AIO_CODING_HUB_BENCHMARK_DURATION_MS: String(durationMs) }),
    ...(scenario === "logs-10k"
      ? {
          AIO_CODING_HUB_BENCHMARK_FIXTURE: workspace.requestLogs.path,
          AIO_CODING_HUB_BENCHMARK_FIXTURE_SHA256: workspace.requestLogs.sha256,
          AIO_CODING_HUB_BENCHMARK_FIXTURE_ROW_COUNT: String(workspace.requestLogs.rowCount),
        }
      : {}),
    ...(gatewayUpstreamUrl == null
      ? {}
      : { AIO_CODING_HUB_BENCHMARK_UPSTREAM_URL: gatewayUpstreamUrl }),
  };

  const launchStartedUnixMs = Date.now();
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readStdout = boundedOutput(child.stdout);
  const readStderr = boundedOutput(child.stderr);
  if (child.pid == null) throw new Error("application process did not expose a PID");
  let exitInfo = null;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once("error", (error) => {
      exitInfo = { code: null, signal: null, spawnError: error.message };
      resolve(exitInfo);
    });
  });

  let tracker;
  const samples = [];
  const warnings = [];
  const failures = [];
  let cleanup = { terminated: [], skipped: [], errors: [] };
  const launchedAt = performance.now();

  const cleanupTrackedProcesses = async () => {
    if (!tracker) return;
    cleanup = await terminateTrackedDescendants(tracker);
    for (const skipped of cleanup.skipped) {
      failures.push({
        code: "PROCESS_CLEANUP_IDENTITY_COARSE",
        pid: skipped.pid,
        message: `refused to terminate PID ${skipped.pid} because its birth identity is coarse`,
      });
    }
    for (const error of cleanup.errors) {
      failures.push({
        code: "PROCESS_CLEANUP_FAILED",
        ...(error.pid == null ? {} : { pid: error.pid }),
        message: `process cleanup ${error.reason}: ${error.message}`,
      });
    }
  };
  try {
    const observed = await findRootIdentity(child.pid);
    tracker = new ProcessTreeTracker(observed.root);
    const processes = tracker.acceptSnapshot(observed.snapshot);
    const sampledAt = performance.now();
    appendProcessSample(samples, {
      atMs: sampledAt - launchedAt,
      atUnixMs: Date.now(),
      processes,
    });
  } catch (error) {
    failures.push({ code: "ROOT_NOT_OBSERVED", message: error.message });
  }

  let sampleOrdinal = 1;
  while (exitInfo == null && performance.now() - launchedAt < timeoutMs) {
    const waitMs = processSampleWaitMs({
      launchedAtMs: launchedAt,
      sampleOrdinal,
      sampleIntervalMs,
      timeoutMs,
      nowMs: performance.now(),
    });
    sampleOrdinal += 1;
    const shouldSample = await waitForProcessSampleInterval({
      exitPromise,
      sampleIntervalMs,
      waitMs,
      readExitInfo: () => exitInfo,
    });
    if (!shouldSample) break;
    if (
      processSamplingDeadlineReached({
        launchedAtMs: launchedAt,
        timeoutMs,
        nowMs: performance.now(),
      })
    ) {
      break;
    }
    if (!tracker) continue;
    try {
      const snapshot = await collectProcessSnapshot();
      const processes = tracker.acceptSnapshot(snapshot);
      const sampledAt = performance.now();
      appendProcessSample(samples, {
        atMs: sampledAt - launchedAt,
        atUnixMs: Date.now(),
        processes,
      });
    } catch (error) {
      warnings.push({ code: "PROCESS_SAMPLE_FAILED", message: error.message });
    }
  }

  if (exitInfo == null) {
    failures.push({ code: "PROCESS_TIMEOUT", message: `process exceeded ${timeoutMs}ms` });
    await cleanupTrackedProcesses();
    try {
      child.kill("SIGKILL");
    } catch {
      // Identity-checked descendants were already handled; root may have exited concurrently.
    }
    await Promise.race([exitPromise, delay(5_000)]);
  } else {
    await cleanupTrackedProcesses();
  }

  const milestones = await readMilestones(workspace.reportPath);
  failures.push(...validateMilestones(milestones, runId, scenario));
  failures.push(
    ...validateProcessSampleCoverage(
      { scenario, launchStartedUnixMs, milestones, samples },
      sampleIntervalMs,
      durationMs
    )
  );
  if (exitInfo?.code !== 0) {
    failures.push({
      code: "NON_ZERO_EXIT",
      message: `application exited with code=${exitInfo?.code} signal=${exitInfo?.signal}`,
    });
  }
  const run = {
    runId,
    scenario,
    launchStartedUnixMs,
    exitCode: exitInfo?.code ?? null,
    signal: exitInfo?.signal ?? null,
    durationMs: performance.now() - launchedAt,
    isolation: {
      home: env.HOME,
      appData: workspace.appData,
      roamingAppData: env.APPDATA,
      localAppData: env.LOCALAPPDATA,
      xdgConfigHome: env.XDG_CONFIG_HOME,
      xdgDataHome: env.XDG_DATA_HOME,
      xdgCacheHome: env.XDG_CACHE_HOME,
      temp: env.TEMP,
      codexHome: env.CODEX_HOME,
      webviewData: workspace.webviewData,
    },
    cleanup,
    milestones,
    samples,
    stdout: readStdout(),
    stderr: readStderr(),
    warnings,
    failures,
  };
  run.metrics = extractRunMetrics(run);
  run.failures.push(...validateIdleProcessMetrics(run));
  return redactPersistedRunPaths(run, { workspace });
}

function scenarioDuration(scenario, requested) {
  if (requested != null) return requested;
  if (scenario === "visible-idle") return 60_000;
  if (scenario === "hidden-tray") return 600_000;
  return null;
}

function scenarioTimeout(scenario, durationMs) {
  if (scenario === "hidden-tray" || scenario === "visible-idle") {
    return (durationMs ?? 0) + 120_000;
  }
  return scenario === "logs-10k" || scenario === "gateway-load" ? 240_000 : 120_000;
}

export async function validateFormalRunnerInputs(options) {
  if (options.releaseProvenance == null || typeof options.releaseProvenance !== "object") {
    throw new Error("formal runner release provenance is required");
  }
  if (!path.isAbsolute(options.output ?? "") || !path.isAbsolute(options.inProgressMarker ?? "")) {
    throw new Error("formal runner output and in-progress marker must be absolute paths");
  }
  const output = path.normalize(options.output);
  const expectedMarker = path.join(path.dirname(output), `${path.basename(output)}.inprogress`);
  if (path.normalize(options.inProgressMarker) !== expectedMarker) {
    throw new Error("formal runner in-progress marker must exactly match the output path");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(expectedMarker, "utf8"));
  } catch (error) {
    throw new Error(`read formal runner in-progress marker: ${error.message}`);
  }
  if (
    marker?.schemaVersion !== 1 ||
    marker.kind !== "egui-baseline-in-progress" ||
    typeof marker.owner !== "string" ||
    marker.owner.length === 0 ||
    marker.pid !== process.pid ||
    marker.outputFile !== path.basename(output) ||
    marker.executableFile !== path.basename(options.executable) ||
    marker.scenario !== options.scenario ||
    marker.fixture !== options.fixture ||
    marker.warmups !== options.warmups ||
    marker.runs !== options.runs ||
    marker.durationMs !== options.durationMs ||
    marker.sampleIntervalMs !== options.sampleIntervalMs
  ) {
    throw new Error("formal runner in-progress marker contents do not match the invocation");
  }
  return expectedMarker;
}

export async function runBaseline(options) {
  const executableStat = await stat(options.executable);
  if (!executableStat.isFile()) throw new Error("benchmark executable is not a file");
  const inProgressMarker = await validateFormalRunnerInputs(options);
  const ignoredUntrackedPaths = [inProgressMarker];
  const initialProvenance = await collectFormalReleaseProvenance({
    repositoryRoot,
    executable: options.executable,
    ignoredUntrackedPaths,
  });
  assertStableBenchmarkInput(
    "pre-marker release provenance",
    JSON.stringify(options.releaseProvenance),
    JSON.stringify(initialProvenance)
  );
  const initialRepository = initialProvenance.repository;
  const initialReleaseArtifacts = initialProvenance.releaseArtifacts;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aio-egui-baseline-"));
  const durationMs = scenarioDuration(options.scenario, options.durationMs);
  const timeoutMs = scenarioTimeout(options.scenario, durationMs);
  const warmupSummaries = [];
  const rawRuns = [];
  const globalWarnings = [];
  const globalFailures = [];
  let fixtureEvidence = null;
  let sharedWarmWorkspace = null;

  try {
    if (options.scenario === "startup-warm-process") {
      sharedWarmWorkspace = await createRunWorkspace({
        root: tempRoot,
        runId: "warm-shared-home",
        fixture: options.fixture,
        scenario: options.scenario,
      });
      fixtureEvidence = mergePreparedFixtureEvidence(fixtureEvidence, sharedWarmWorkspace);
    }

    const execute = async (phase, index) => {
      assertStableBenchmarkInput(
        "release executable",
        initialReleaseArtifacts.executableSha256,
        await sha256File(options.executable)
      );
      const runId = `${options.scenario}-${phase}-${String(index + 1).padStart(2, "0")}`;
      const workspace = sharedWarmWorkspace
        ? await reuseRunWorkspace(sharedWarmWorkspace, runId)
        : await createRunWorkspace({
            root: tempRoot,
            runId,
            fixture: options.fixture,
            scenario: options.scenario,
          });
      fixtureEvidence = mergePreparedFixtureEvidence(fixtureEvidence, workspace);
      const gatewayStub = options.scenario === "gateway-load" ? await startGatewayStub() : null;
      try {
        const run = await runApplicationOnce({
          executable: options.executable,
          workspace,
          runId,
          scenario: options.scenario,
          durationMs,
          sampleIntervalMs: options.sampleIntervalMs ?? 1_000,
          timeoutMs,
          gatewayUpstreamUrl: gatewayStub?.url ?? null,
        });
        run.failures.push(
          ...validateEmbeddedAppVersion(run.milestones, initialProvenance.packageVersion)
        );
        assertStableBenchmarkInput(
          "release executable",
          initialReleaseArtifacts.executableSha256,
          await sha256File(options.executable)
        );
        if (gatewayStub) {
          run.gatewayStub = {
            protocol: gatewayStub.protocol,
            counters: gatewayStub.snapshot(),
          };
          try {
            validateGatewayStubEvidence(run.gatewayStub);
          } catch (error) {
            run.failures.push({
              code: "GATEWAY_STUB_PROTOCOL_MISMATCH",
              message: error.message,
            });
          }
        }
        return run;
      } finally {
        await gatewayStub?.close();
      }
    };

    for (let index = 0; index < options.warmups; index += 1) {
      const run = await execute("warmup", index);
      warmupSummaries.push({
        index,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        warnings: run.warnings,
        failures: run.failures,
      });
      if (run.failures.length > 0) {
        throw new Error(`warmup ${index + 1} failed: ${formatFailureSummary(run.failures)}`);
      }
    }

    for (let index = 0; index < options.runs; index += 1) {
      const run = await execute("run", index);
      run.index = index;
      rawRuns.push(run);
      globalWarnings.push(...run.warnings.map((warning) => ({ runIndex: index, ...warning })));
      globalFailures.push(...run.failures.map((failure) => ({ runIndex: index, ...failure })));
    }

    const successfulRuns = rawRuns.filter((run) => run.exitCode === 0 && run.failures.length === 0);
    const metricNames = new Set(successfulRuns.flatMap((run) => Object.keys(run.metrics)));
    const aggregates = {};
    for (const name of [...metricNames].sort()) {
      const values = successfulRuns.map((run) => run.metrics[name]).filter(Number.isFinite);
      if (values.length > 0) aggregates[name] = aggregateValues(values);
    }

    const finalProvenance = await collectFormalReleaseProvenance({
      repositoryRoot,
      executable: options.executable,
      ignoredUntrackedPaths,
    });
    assertStableBenchmarkInput(
      "release provenance",
      JSON.stringify(initialProvenance),
      JSON.stringify(finalProvenance)
    );
    const cpu = os.cpus();
    return {
      schemaVersion: 1,
      status: globalFailures.length === 0 ? "complete" : "diagnostic",
      tool: { name: "egui-baseline", version: 1 },
      repository: initialRepository,
      app: {
        version: initialProvenance.packageVersion,
        executable: initialReleaseArtifacts.executablePath,
        executableSha256: initialReleaseArtifacts.executableSha256,
        executableBytes: initialReleaseArtifacts.executableBytes,
        installers: initialReleaseArtifacts.installers,
        buildProvenance: initialProvenance.buildManifest,
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        kernelType: os.type(),
        cpuModel: cpu[0]?.model ?? null,
        logicalCpuCount: cpu.length,
        totalMemoryBytes: os.totalmem(),
        nodeVersion: process.version,
        locale: "C.UTF-8",
        timezone: "UTC",
        gpuRenderer: null,
        webViewRuntime: null,
        power: null,
        processMetrics: processCollectorCapabilities(),
      },
      protocol: {
        warmups: options.warmups,
        runs: options.runs,
        sampleIntervalMs: options.sampleIntervalMs ?? 1_000,
        processTree: "pid-birth-image identity descendants; retained after reparent",
        percentile: "nearest-rank",
        median: "midpoint for even sample counts",
      },
      scenario: {
        id: options.scenario,
        fixture: options.fixture,
        fixtureHash: fixtureEvidence?.fixtureHash ?? null,
        fixtureArtifacts: fixtureEvidence?.fixtureArtifacts ?? null,
        durationMs,
        window: {
          width: 1500,
          height: 900,
          startMinimized: options.scenario === "hidden-tray",
        },
      },
      warmupSummaries,
      rawRuns,
      aggregates,
      warnings: globalWarnings,
      failures: globalFailures,
      pendingPlatforms: ["win32", "darwin", "linux"].filter(
        (platform) => platform !== process.platform
      ),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const FIXTURE_CHILD_SCRIPT = String.raw`
const { appendFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const report = process.env.AIO_CODING_HUB_BENCHMARK_REPORT;
const started = Date.now();
let seq = 0;
function row(milestone) {
  seq += 1;
  return JSON.stringify({ schemaVersion: 1, runId: process.env.AIO_CODING_HUB_BENCHMARK_RUN_ID, scenario: 'first-interactive', seq, milestone, elapsedMs: Date.now() - started, wallClockUnixMs: Date.now(), data: {} }) + '\n';
}
writeFileSync(report, row('process_entry') + row('startup_ready') + row('first_interactive'), { flag: 'wx' });
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore', windowsHide: true });
grandchild.unref();
setTimeout(() => {
  appendFileSync(report, row('shutdown_completed'));
  process.exit(0);
}, 1800);
`;

export async function runFixtureProcessSelfTest(_scriptPath) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-runner-selftest-"));
  const runId = "fixture-process";
  try {
    const workspace = await createRunWorkspace({
      root,
      runId,
      fixture: "fresh",
      scenario: "first-interactive",
    });
    const child = spawn(process.execPath, ["-e", FIXTURE_CHILD_SCRIPT], {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        AIO_CODING_HUB_BENCHMARK_REPORT: workspace.reportPath,
        AIO_CODING_HUB_BENCHMARK_RUN_ID: runId,
      },
    });
    if (child.pid == null) throw new Error("fixture process did not expose a PID");
    const { root: rootIdentity, snapshot } = await findRootIdentity(child.pid);
    const tracker = new ProcessTreeTracker(rootIdentity);
    const samples = [];
    const firstProcesses = tracker.acceptSnapshot(snapshot);
    samples.push({
      atMs: 0,
      processes: firstProcesses,
      totals: aggregateProcessSample(firstProcesses),
    });

    let exited = false;
    let exitCode = null;
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
    });
    const started = performance.now();
    while (!exited && performance.now() - started < 8_000) {
      await delay(100);
      const current = await collectProcessSnapshot();
      const processes = tracker.acceptSnapshot(current);
      samples.push({
        atMs: performance.now() - started,
        processes,
        totals: aggregateProcessSample(processes),
      });
    }
    if (!exited) {
      await terminateTrackedDescendants(tracker);
      throw new Error("fixture process timed out");
    }
    await terminateTrackedDescendants(tracker);
    const milestones = parseJsonl(await readFile(workspace.reportPath, "utf8"));
    return { exitCode, samples, milestones };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export { parseJsonl, requiredMilestones, validateMilestones };
