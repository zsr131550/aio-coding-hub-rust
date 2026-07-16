import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateValues } from "./egui-baseline/stats.mjs";
import {
  ProcessTreeTracker,
  aggregateProcessSample,
  enrichLinuxProcessSnapshot,
  parseLinuxProcStat,
  parseLinuxProcStatus,
  parsePosixPsSnapshot,
  parseWindowsCimSnapshot,
  processCollectorCapabilities,
} from "./egui-baseline/process-tree.mjs";
import { assertIsolatedHome, createRunWorkspace } from "./egui-baseline/workspace.mjs";
import { validateBaselineResult } from "./egui-baseline/result.mjs";
import * as baselineRunner from "./egui-baseline/runner.mjs";
import {
  assertStableBenchmarkInput,
  extractRunMetrics,
  formatFailureSummary,
  mergePreparedFixtureEvidence,
  redactPersistedRunPaths,
  requiredMilestones,
  runFixtureProcessSelfTest,
  terminateTrackedDescendants,
  validateEmbeddedAppVersion,
  validateIdleProcessMetrics,
  validateProcessSampleCoverage,
  validateFormalRunnerInputs,
  validateMilestones,
} from "./egui-baseline/runner.mjs";
import { startGatewayStub } from "./egui-baseline/gateway-stub.mjs";
import { supportedHostTarget } from "./egui-baseline/release-provenance.mjs";
import {
  baselineInProgressPath,
  formalBaselineStagingRoot,
  parseBaselineArgs,
  runBaselineCommand,
  writeResult,
} from "./egui-baseline.mjs";

const scriptPath = fileURLToPath(import.meta.url);
let passed = 0;

await test("process exit wakeup does not request another process sample", async () => {
  const exitInfo = { code: 0, signal: null };
  const shouldSample = await baselineRunner.waitForProcessSampleInterval({
    exitPromise: Promise.resolve(exitInfo),
    sampleIntervalMs: 1_000,
    readExitInfo: () => exitInfo,
  });

  assert.equal(shouldSample, false);
});

await test("process sampling stays on the launch clock instead of accumulating collector time", () => {
  assert.equal(
    baselineRunner.processSampleWaitMs({
      launchedAtMs: 1_000,
      sampleOrdinal: 2,
      sampleIntervalMs: 1_000,
      nowMs: 2_600,
    }),
    400
  );
  assert.equal(
    baselineRunner.processSampleWaitMs({
      launchedAtMs: 1_000,
      sampleOrdinal: 3,
      sampleIntervalMs: 1_000,
      nowMs: 4_200,
    }),
    0
  );
});

await test("process sampling wait is capped by the scenario deadline", () => {
  assert.equal(
    baselineRunner.processSampleWaitMs({
      launchedAtMs: 1_000,
      sampleOrdinal: 20,
      sampleIntervalMs: 1_000,
      timeoutMs: 5_000,
      nowMs: 5_500,
    }),
    500
  );
});

await test("process sampling stops at the exact scenario deadline", () => {
  assert.equal(
    baselineRunner.processSamplingDeadlineReached({
      launchedAtMs: 1_000,
      timeoutMs: 5_000,
      nowMs: 5_999,
    }),
    false
  );
  assert.equal(
    baselineRunner.processSamplingDeadlineReached({
      launchedAtMs: 1_000,
      timeoutMs: 5_000,
      nowMs: 6_000,
    }),
    true
  );
});

await test("process sampling discards an empty snapshot captured after process exit", () => {
  const samples = [];
  const appendedEmpty = baselineRunner.appendProcessSample(samples, {
    atMs: 2_000,
    atUnixMs: 3_000,
    processes: [],
  });

  assert.equal(appendedEmpty, false);
  assert.deepEqual(samples, []);

  const processes = [
    {
      pid: 10,
      workingSetBytes: 100,
      privateBytes: 80,
      cpuTimeMs: 20,
    },
  ];
  const appendedLive = baselineRunner.appendProcessSample(samples, {
    atMs: 2_100,
    atUnixMs: 3_100,
    processes,
  });

  assert.equal(appendedLive, true);
  assert.deepEqual(samples, [
    {
      atMs: 2_100,
      atUnixMs: 3_100,
      processes,
      totals: {
        processCount: 1,
        workingSetBytes: 100,
        privateBytes: 80,
        cpuTimeMs: 20,
      },
    },
  ]);
});

function minimalBaselineResult() {
  const fixtureArtifacts = {
    "aio-coding-hub.db": { bytes: 1, sha256: "1".repeat(64) },
    "settings.json": { bytes: 1, sha256: "2".repeat(64) },
  };
  const fixtureHash = createHash("sha256")
    .update(
      Object.entries(fixtureArtifacts)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([name, metadata]) => `${name}\u0000${metadata.sha256}`)
        .join("\n")
    )
    .digest("hex");
  const rawRuns = Array.from({ length: 10 }, (_, index) => ({
    index,
    runId: `failed-selftest-${index}`,
    exitCode: 1,
    milestones: [],
    samples: [],
    metrics: {},
    stdout: "",
    stderr: "",
    warnings: [],
    failures: [{ code: "SELF_TEST_FAILURE", message: "intentional failed-run fixture" }],
  }));
  return {
    schemaVersion: 1,
    status: "diagnostic",
    tool: { name: "egui-baseline", version: 1 },
    repository: {
      commit: "0".repeat(40),
      dirty: true,
      statusSha256: "3".repeat(64),
    },
    app: {
      version: "0.60.13",
      executable: "fixture",
      executableSha256: "0".repeat(64),
      executableBytes: 1,
      installers: [{ kind: "file", path: "bundle/fixture.msi", bytes: 1, sha256: "4".repeat(64) }],
      buildProvenance: {
        path: "fixture.build-provenance.json",
        sha256: "5".repeat(64),
        profile: "release",
        target: supportedHostTarget(),
        producer: "scripts/tauri-build.mjs",
        configOverlaySha256: null,
      },
    },
    environment: {
      platform: "win32",
      arch: process.arch,
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
      processMetrics: processCollectorCapabilities("win32"),
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
      id: "first-interactive",
      fixture: "current",
      fixtureHash,
      fixtureArtifacts,
      durationMs: null,
      window: { width: 1500, height: 900, startMinimized: false },
    },
    warmupSummaries: Array.from({ length: 2 }, (_, index) => ({
      index,
      exitCode: 0,
      durationMs: 100 + index,
      warnings: [],
      failures: [],
    })),
    rawRuns,
    aggregates: {},
    warnings: [],
    failures: rawRuns.map((_, runIndex) => ({
      runIndex,
      code: "SELF_TEST_FAILURE",
      message: "intentional failed-run fixture",
    })),
    pendingPlatforms: ["darwin", "linux"],
  };
}

async function test(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`[egui-baseline:selftest] ok - ${name}`);
  } catch (error) {
    console.error(`[egui-baseline:selftest] FAIL - ${name}`);
    throw error;
  }
}

await test("median midpoint and P95 nearest-rank are deterministic", () => {
  assert.deepEqual(aggregateValues([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), {
    min: 1,
    max: 10,
    median: 5.5,
    p95: 10,
    samples: [10, 1, 9, 2, 8, 3, 7, 4, 6, 5],
  });
});

await test("prepared fixture evidence keeps hash and artifacts atomic for warm runs", () => {
  const workspace = {
    fixtureHash: "a".repeat(64),
    fixtureArtifacts: {
      "aio-coding-hub.db": { bytes: 1, sha256: "b".repeat(64) },
      "settings.json": { bytes: 2, sha256: "c".repeat(64) },
    },
  };
  const evidence = mergePreparedFixtureEvidence(null, workspace);
  assert.deepEqual(evidence, {
    fixtureHash: workspace.fixtureHash,
    fixtureArtifacts: workspace.fixtureArtifacts,
  });
  assert.equal(mergePreparedFixtureEvidence(evidence, workspace), evidence);
  assert.throws(
    () =>
      mergePreparedFixtureEvidence(evidence, {
        ...workspace,
        fixtureHash: "d".repeat(64),
      }),
    /prepared fixture changed/
  );
});

await test("formal result requires installer and build provenance evidence", () => {
  const withoutInstaller = minimalBaselineResult();
  withoutInstaller.app.installers = [];
  assert.throws(() => validateBaselineResult(withoutInstaller), /installer|build provenance/i);
  const withoutProvenance = minimalBaselineResult();
  delete withoutProvenance.app.buildProvenance;
  assert.throws(() => validateBaselineResult(withoutProvenance), /installer|build provenance/i);
});

await test("Windows CIM parser preserves process identity and byte counters", () => {
  const rows = parseWindowsCimSnapshot(
    JSON.stringify([
      {
        ProcessId: 42,
        ParentProcessId: 7,
        CreationDate: "20260715120000.000000+480",
        Name: "app.exe",
        WorkingSetSize: "4096",
        PrivatePageCount: "2048",
        KernelModeTime: "10000",
        UserModeTime: "20000",
      },
    ])
  );
  assert.deepEqual(rows, [
    {
      pid: 42,
      ppid: 7,
      birthToken: "20260715120000.000000+480",
      identityPrecision: "exact",
      imageName: "app.exe",
      workingSetBytes: 4096,
      privateBytes: 2048,
      cpuTimeMs: 3,
    },
  ]);
  assert.equal(
    parseWindowsCimSnapshot(
      JSON.stringify({
        ProcessId: 43,
        ParentProcessId: 7,
        CreationDate: "20260715120001.000000+480",
        Name: "app.exe",
        WorkingSetSize: "4096",
        PrivatePageCount: "2048",
        KernelModeTime: "10000",
      })
    )[0].cpuTimeMs,
    null
  );
  assert.equal(
    parseWindowsCimSnapshot(
      JSON.stringify({
        ProcessId: 44,
        ParentProcessId: 7,
        CreationDate: "/Date(1784143707556)/",
        Name: "app.exe",
        WorkingSetSize: "4096",
        PrivatePageCount: "2048",
        KernelModeTime: "10000",
        UserModeTime: "20000",
      })
    )[0].birthToken,
    "unix-ms:1784143707556"
  );
});

await test("POSIX ps parser keeps fixed lstart as the birth token", () => {
  const rows = parsePosixPsSnapshot(
    "  42   7  128 00:01:02 Wed Jul 15 12:00:00 2026 /Applications/AIO.app/Contents/MacOS/aio-app\n"
  );
  assert.equal(rows[0].pid, 42);
  assert.equal(rows[0].workingSetBytes, 128 * 1024);
  assert.equal(rows[0].cpuTimeMs, 62_000);
  assert.equal(rows[0].birthToken, "Wed Jul 15 12:00:00 2026");
  assert.equal(rows[0].identityPrecision, "coarse");
  assert.equal(rows[0].imageName, "aio-app");
});

await test("Linux proc stat parser reads field 22 after a parenthesized comm", () => {
  const fields = Array(20).fill("0");
  fields[0] = "S";
  fields[1] = "7";
  fields[11] = "125";
  fields[12] = "75";
  fields[19] = "987654321";
  const stat = `321 (worker ) stage (one)) ${fields.join(" ")}`;

  assert.deepEqual(parseLinuxProcStat(stat), {
    pid: 321,
    ppid: 7,
    comm: "worker ) stage (one)",
    starttime: "987654321",
    userTimeTicks: "125",
    systemTimeTicks: "75",
  });
});

await test("Linux proc status parser preserves unavailable counters instead of guessing zero", () => {
  assert.deepEqual(parseLinuxProcStatus("VmRSS:\t128 kB\nRssAnon:\t96 kB\n"), {
    workingSetBytes: 128 * 1024,
    privateBytes: 96 * 1024,
  });
  assert.deepEqual(parseLinuxProcStatus("VmRSS:\t128 kB\n"), {
    workingSetBytes: 128 * 1024,
    privateBytes: null,
  });
  assert.throws(
    () => parseLinuxProcStatus("VmRSS:\t128 kB\nRssAnon:\tunknown kB\n"),
    /invalid Linux proc status RssAnon/
  );
});

await test("Linux snapshot counters come from identity-bracketed proc records", async () => {
  const coarseRows = parsePosixPsSnapshot(
    "  321   7  128 00:00:01 Wed Jul 15 12:00:00 2026 stale-name\n"
  );
  const fields = Array(20).fill("0");
  fields[0] = "S";
  fields[1] = "9";
  fields[11] = "125";
  fields[12] = "75";
  fields[19] = "987654321";
  const stat = `321 (worker ) stage (one)) ${fields.join(" ")}`;
  let statReads = 0;

  const [row] = await enrichLinuxProcessSnapshot(coarseRows, {
    clockTicksPerSecond: 100,
    readProcStat: async (pid) => {
      assert.equal(pid, 321);
      statReads += 1;
      return stat;
    },
    readProcStatus: async (pid) => {
      assert.equal(pid, 321);
      return "VmRSS:\t128 kB\nRssAnon:\t96 kB\n";
    },
  });

  assert.deepEqual(
    {
      pid: row.pid,
      ppid: row.ppid,
      birthToken: row.birthToken,
      identityPrecision: row.identityPrecision,
      imageName: row.imageName,
    },
    {
      pid: 321,
      ppid: 9,
      birthToken: "987654321",
      identityPrecision: "exact",
      imageName: "worker ) stage (one)",
    }
  );
  assert.equal(statReads, 2);
  assert.equal(row.workingSetBytes, 128 * 1024);
  assert.equal(row.privateBytes, 96 * 1024);
  assert.equal(row.cpuTimeMs, 2_000);
});

await test("Linux snapshot discards proc counters when the PID birth token changes", async () => {
  const coarseRows = parsePosixPsSnapshot(
    "  321   7  128 00:00:01 Wed Jul 15 12:00:00 2026 stale-name\n"
  );
  const stat = (starttime) => {
    const fields = Array(20).fill("0");
    fields[0] = "S";
    fields[1] = "9";
    fields[11] = "125";
    fields[12] = "75";
    fields[19] = starttime;
    return `321 (worker) ${fields.join(" ")}`;
  };
  const statRows = [stat("111"), stat("222")];
  const [row] = await enrichLinuxProcessSnapshot(coarseRows, {
    clockTicksPerSecond: 100,
    readProcStat: async () => statRows.shift(),
    readProcStatus: async () => "VmRSS:\t128 kB\nRssAnon:\t96 kB\n",
  });

  assert.equal(row.identityPrecision, "coarse");
  assert.equal(row.privateBytes, null);
  assert.equal(row.birthToken, "Wed Jul 15 12:00:00 2026");
});

await test("Linux snapshot identity remains coarse when proc stat is unavailable", async () => {
  const coarseRows = parsePosixPsSnapshot(
    "  321   7  128 00:00:01 Wed Jul 15 12:00:00 2026 aio-app\n"
  );
  const rows = await enrichLinuxProcessSnapshot(coarseRows, {
    clockTicksPerSecond: 100,
    readProcStat: async () => {
      throw Object.assign(new Error("process exited"), { code: "ENOENT" });
    },
    readProcStatus: async () => {
      throw new Error("status must not be read without a stat identity");
    },
  });

  assert.deepEqual(rows, coarseRows);
  assert.equal(rows[0].identityPrecision, "coarse");
});

await test("process collector capabilities expose Linux metrics and macOS idle limits", () => {
  const linux = processCollectorCapabilities("linux");
  assert.equal(linux.identity.precision, "exact");
  assert.equal(linux.metrics.workingSetBytes.availability, "available");
  assert.equal(linux.metrics.privateBytes.source, "/proc/<pid>/status:RssAnon");
  assert.equal(linux.metrics.cpuTimeMs.availability, "available");

  const macos = processCollectorCapabilities("darwin");
  assert.equal(macos.identity.precision, "coarse");
  assert.equal(macos.metrics.workingSetBytes.availability, "available");
  assert.equal(macos.metrics.privateBytes.availability, "unavailable");
  assert.equal(macos.metrics.privateBytes.source, null);
});

await test("tree tracker rejects PID reuse and retains proven reparented descendants", () => {
  const root = {
    pid: 10,
    ppid: 1,
    birthToken: "root-a",
    identityPrecision: "exact",
    imageName: "app",
    workingSetBytes: 100,
    privateBytes: 80,
    cpuTimeMs: 5,
  };
  const child = { ...root, pid: 11, ppid: 10, birthToken: "child-a", imageName: "worker" };
  const tracker = new ProcessTreeTracker(root);
  assert.deepEqual(
    tracker.acceptSnapshot([root, child]).map((row) => row.pid),
    [10, 11]
  );

  const reusedRoot = { ...root, birthToken: "root-b" };
  const reparentedChild = { ...child, ppid: 1, workingSetBytes: 120 };
  assert.deepEqual(
    tracker.acceptSnapshot([reusedRoot, reparentedChild]).map((row) => row.pid),
    [11]
  );
  assert.equal(tracker.owns({ pid: 10, birthToken: "root-b", imageName: "app" }), false);
});

await test("cleanup revalidates process identity immediately before termination", async () => {
  const root = {
    pid: 10,
    ppid: 1,
    birthToken: "root-a",
    identityPrecision: "exact",
    imageName: "app",
    workingSetBytes: 100,
    privateBytes: 80,
    cpuTimeMs: 5,
  };
  const child = { ...root, pid: 11, ppid: 10, birthToken: "child-a", imageName: "worker" };
  const reusedChild = { ...child, birthToken: "child-b", imageName: "unrelated" };
  const tracker = new ProcessTreeTracker(root);
  tracker.acceptSnapshot([root, child]);
  const snapshots = [[root, child], [root, reusedChild], [root]];
  const terminated = [];

  await terminateTrackedDescendants(tracker, {
    collectSnapshot: async () => snapshots.shift() ?? [],
    terminatePid: (pid) => terminated.push(pid),
  });

  assert.deepEqual(terminated, [root.pid]);
});

await test("cleanup refuses a same-second same-image coarse replacement", async () => {
  const root = {
    pid: 10,
    ppid: 1,
    birthToken: "root-exact",
    identityPrecision: "exact",
    imageName: "app",
    workingSetBytes: 100,
    privateBytes: null,
    cpuTimeMs: 5,
  };
  const coarseChild = {
    ...root,
    pid: 11,
    ppid: 10,
    birthToken: "Wed Jul 15 12:00:00 2026",
    identityPrecision: "coarse",
    imageName: "worker",
  };
  const replacement = { ...coarseChild, ppid: 1 };
  const tracker = new ProcessTreeTracker(root);
  tracker.acceptSnapshot([root, coarseChild]);
  const snapshots = [[root, replacement], [root, replacement], [root]];
  const terminated = [];

  const cleanup = await terminateTrackedDescendants(tracker, {
    collectSnapshot: async () => snapshots.shift() ?? [],
    terminatePid: (pid) => terminated.push(pid),
  });

  assert.deepEqual(terminated, [root.pid]);
  assert.equal(terminated.includes(replacement.pid), false);
  assert.deepEqual(cleanup.skipped, [
    { pid: replacement.pid, reason: "identity_precision_coarse" },
  ]);
});

await test("startup metrics include runner launch-to-milestone latency", () => {
  const metrics = extractRunMetrics({
    launchStartedUnixMs: 1_000,
    milestones: [
      {
        milestone: "process_entry",
        elapsedMs: 1,
        wallClockUnixMs: 1_020,
      },
      {
        milestone: "startup_ready",
        elapsedMs: 31,
        wallClockUnixMs: 1_050,
      },
      {
        milestone: "first_interactive",
        elapsedMs: 41,
        wallClockUnixMs: 1_060,
      },
    ],
    samples: [],
  });

  assert.equal(metrics.launchToProcessEntryMs, 20);
  assert.equal(metrics.launchToStartupReadyMs, 50);
  assert.equal(metrics.launchToFirstInteractiveMs, 60);
});

await test("runner rejects a missing or stale compiled app version", () => {
  assert.deepEqual(
    validateEmbeddedAppVersion(
      [{ milestone: "process_entry", data: { appVersion: "0.60.13" } }],
      "0.60.13"
    ),
    []
  );
  assert.equal(validateEmbeddedAppVersion([], "0.60.13")[0].code, "APP_VERSION_MISMATCH");
  assert.equal(
    validateEmbeddedAppVersion(
      [{ milestone: "process_entry", data: { appVersion: "0.60.12" } }],
      "0.60.13"
    )[0].code,
    "APP_VERSION_MISMATCH"
  );
});

await test("persisted runs redact runner-owned and real-home absolute paths", () => {
  const workspace = {
    runRoot: "C:\\Users\\Alice\\AppData\\Local\\Temp\\bench\\run-01",
    home: "C:\\Users\\Alice\\AppData\\Local\\Temp\\bench\\run-01\\home",
  };
  const redacted = redactPersistedRunPaths(
    {
      isolation: {
        home: workspace.home,
        appData: `${workspace.home}\\.aio-coding-hub`,
      },
      stdout: `opened ${workspace.home}\\report.jsonl`,
      stderr: "failed under C:\\Users\\Alice\\secrets",
      warnings: [{ code: "FIXTURE", message: `warning ${workspace.runRoot}` }],
      failures: [],
      cleanup: { errors: [{ message: `cleanup ${workspace.home}` }] },
    },
    { workspace, realHome: "C:\\Users\\Alice" }
  );
  assert.deepEqual(redacted.isolation, {
    home: "$RUN_HOME",
    appData: "$RUN_HOME/.aio-coding-hub",
  });
  assert.match(redacted.stdout, /\$RUN_HOME\/report.jsonl/);
  assert.match(redacted.stderr, /\$REAL_HOME\/secrets/);
  assert.doesNotMatch(JSON.stringify(redacted), /Alice/);
});

await test("window milestone requires and exposes actual logical size and display scale", () => {
  const scenario = "visible-idle";
  const runId = "window-run";
  const rows = requiredMilestones(scenario).map((milestone, index) => ({
    schemaVersion: 1,
    runId,
    scenario,
    seq: index + 1,
    milestone,
    elapsedMs: index,
    wallClockUnixMs: 1_000 + index,
    data:
      milestone === "window_visible"
        ? {
            startMinimized: false,
            physicalWidth: 2250,
            physicalHeight: 1350,
            logicalWidth: 1500,
            logicalHeight: 900,
            scaleFactor: 1.5,
          }
        : {},
  }));

  assert.equal(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "MISSING_WINDOW_MEASUREMENT"
    ),
    false
  );
  rows.find((row) => row.milestone === "window_visible").data.scaleFactor = null;
  assert.ok(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "MISSING_WINDOW_MEASUREMENT"
    )
  );

  const windowData = rows.find((row) => row.milestone === "window_visible").data;
  windowData.scaleFactor = 1.5;
  windowData.logicalWidth = 1400;
  assert.ok(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "WINDOW_SIZE_MISMATCH"
    )
  );

  const metrics = extractRunMetrics({ milestones: rows, samples: [] });
  assert.equal(metrics.windowLogicalWidth, 1400);
  assert.equal(metrics.windowLogicalHeight, 900);
  assert.equal(metrics.windowScaleFactor, 1.5);
});

await test("frontend scenario failures remain diagnostic but redact untrusted details", () => {
  const runId = "gateway-failure-run";
  const rows = [
    {
      schemaVersion: 1,
      runId,
      scenario: "gateway-load",
      seq: 1,
      milestone: "scenario_failed",
      elapsedMs: 1,
      wallClockUnixMs: 1_000,
      data: {
        condition: "active",
        stage: "run_gateway_load",
        errorCode: "SEC_INVALID_INPUT",
        errorMessage:
          "provider rejected\nBearer token api_key=sk-secret https://example.test/private C:\\Users\\Alice\\secret " +
          "x".repeat(1_000),
      },
    },
  ];

  const failure = validateMilestones(rows, runId, "gateway-load").find(
    (item) => item.code === "SCENARIO_FAILED"
  );
  assert.equal(failure.reportedCode, "SEC_INVALID_INPUT");
  assert.match(failure.message, /active\/run_gateway_load.*SEC_INVALID_INPUT/);
  assert.ok(failure.message.length <= 640);
  assert.doesNotMatch(failure.message, /token|sk-secret|example\.test|Alice/);
  assert.match(formatFailureSummary([failure]), /^SCENARIO_FAILED: .*SEC_INVALID_INPUT/);
  assert.ok(formatFailureSummary(Array(20).fill(failure)).length <= 4_096);
});

await test("gateway milestones reject silently missing stream intervals", () => {
  const scenario = "gateway-load";
  const runId = "gateway-run";
  const rows = requiredMilestones(scenario).map((milestone, index) => ({
    schemaVersion: 1,
    runId,
    scenario,
    seq: index + 1,
    milestone,
    elapsedMs: index,
    wallClockUnixMs: 1_000 + index,
    data:
      milestone === "gateway_load_idle_completed" || milestone === "gateway_load_active_completed"
        ? {
            streamRequests: 4,
            streamDataEvents: 5,
            streamDoneEvents: 1,
            streamEventIntervalMs: 20,
            streamTtfbMs: Array(4).fill(1),
            streamInterEventMs: [],
            observedStreamTransportChunks: Array(4).fill(6),
          }
        : {},
  }));

  assert.ok(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "MISSING_GATEWAY_STREAM_TIMING"
    )
  );
});

await test("gateway milestones preserve the counterbalanced phase order", () => {
  const scenario = "gateway-load";
  const runId = "gateway-load-measure-02";
  const generic = requiredMilestones(scenario).filter(
    (milestone) => !milestone.startsWith("gateway_load_")
  );
  const scenarioCompleted = generic.indexOf("scenario_completed");
  const phaseMilestones = [
    "gateway_load_active_started",
    "gateway_load_active_completed",
    "gateway_load_idle_started",
    "gateway_load_idle_completed",
    "gateway_load_ready",
    "gateway_load_completed",
  ];
  generic.splice(scenarioCompleted, 0, ...phaseMilestones);
  const rows = generic.map((milestone, index) => ({
    schemaVersion: 1,
    runId,
    scenario,
    seq: index + 1,
    milestone,
    elapsedMs: index,
    wallClockUnixMs: 1_000 + index,
    data:
      milestone === "window_visible"
        ? {
            physicalWidth: 1500,
            physicalHeight: 900,
            logicalWidth: 1500,
            logicalHeight: 900,
            scaleFactor: 1,
          }
        : milestone === "gateway_load_idle_completed" ||
            milestone === "gateway_load_active_completed"
          ? {
              streamRequests: 4,
              streamDataEvents: 5,
              streamDoneEvents: 1,
              streamEventIntervalMs: 20,
              streamTtfbMs: Array(4).fill(1),
              streamInterEventMs: Array(20).fill(20),
              observedStreamTransportChunks: Array(4).fill(6),
            }
          : milestone === "gateway_load_completed"
            ? { activeFrameCount: 3 }
            : {},
  }));

  assert.equal(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "GATEWAY_PHASE_ORDER_MISMATCH"
    ),
    false
  );
  assert.equal(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "GATEWAY_ACTIVE_UI_NOT_COMMITTED"
    ),
    false
  );

  rows.find((row) => row.milestone === "gateway_load_completed").data.activeFrameCount = 0;
  assert.ok(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "GATEWAY_ACTIVE_UI_NOT_COMMITTED"
    )
  );
  rows.find((row) => row.milestone === "gateway_load_completed").data.activeFrameCount = 3;

  const idleStarted = rows.find((row) => row.milestone === "gateway_load_idle_started");
  const activeStarted = rows.find((row) => row.milestone === "gateway_load_active_started");
  [idleStarted.milestone, activeStarted.milestone] = [
    activeStarted.milestone,
    idleStarted.milestone,
  ];
  assert.ok(
    validateMilestones(rows, runId, scenario).some(
      (failure) => failure.code === "GATEWAY_PHASE_ORDER_MISMATCH"
    )
  );
});

await test("successful milestone streams reject duplicates and core order drift", () => {
  const scenario = "first-interactive";
  const runId = "first-interactive-run-01";
  const buildRows = () =>
    requiredMilestones(scenario, runId).map((milestone, index) => ({
      schemaVersion: 1,
      runId,
      scenario,
      seq: index + 1,
      milestone,
      elapsedMs: index,
      wallClockUnixMs: 1_000 + index,
      data:
        milestone === "window_visible"
          ? {
              physicalWidth: 1500,
              physicalHeight: 900,
              logicalWidth: 1500,
              logicalHeight: 900,
              scaleFactor: 1,
            }
          : {},
    }));
  assert.equal(validateMilestones(buildRows(), runId, scenario).length, 0);

  const duplicated = buildRows();
  duplicated.splice(5, 0, { ...duplicated[4] });
  duplicated.forEach((row, index) => {
    row.seq = index + 1;
    row.elapsedMs = index;
  });
  assert.ok(
    validateMilestones(duplicated, runId, scenario).some(
      (failure) => failure.code === "MILESTONE_CARDINALITY_INVALID"
    )
  );

  const reordered = buildRows();
  const dbIndex = reordered.findIndex((row) => row.milestone === "db_ready");
  const settingsIndex = reordered.findIndex((row) => row.milestone === "settings_ready");
  [reordered[dbIndex].milestone, reordered[settingsIndex].milestone] = [
    reordered[settingsIndex].milestone,
    reordered[dbIndex].milestone,
  ];
  assert.ok(
    validateMilestones(reordered, runId, scenario).some(
      (failure) => failure.code === "MILESTONE_ORDER_INVALID"
    )
  );
});

await test("process sample aggregate never turns unavailable values into zero", () => {
  assert.deepEqual(
    aggregateProcessSample([
      { workingSetBytes: 10, privateBytes: null, cpuTimeMs: 2 },
      { workingSetBytes: 20, privateBytes: null, cpuTimeMs: 3 },
    ]),
    { processCount: 2, workingSetBytes: 30, privateBytes: null, cpuTimeMs: 5 }
  );
  assert.deepEqual(
    aggregateProcessSample([
      { workingSetBytes: 10, privateBytes: 8, cpuTimeMs: 2 },
      { workingSetBytes: 20, privateBytes: null, cpuTimeMs: 3 },
    ]),
    { processCount: 2, workingSetBytes: 30, privateBytes: null, cpuTimeMs: 5 }
  );
});

await test("idle metric extraction rejects partial counter coverage", () => {
  const metrics = extractRunMetrics({
    scenario: "visible-idle",
    milestones: [],
    samples: [
      {
        processes: [],
        totals: { processCount: 1, workingSetBytes: 100, privateBytes: 80, cpuTimeMs: 1 },
      },
      {
        processes: [],
        totals: { processCount: 1, workingSetBytes: 110, privateBytes: null, cpuTimeMs: 2 },
      },
    ],
  });
  assert.equal(metrics.peakWorkingSetBytes, 110);
  assert.equal(Object.hasOwn(metrics, "peakPrivateBytes"), false);
  assert.ok(
    validateIdleProcessMetrics({ scenario: "visible-idle", metrics }).some(
      (failure) =>
        failure.code === "PROCESS_METRIC_UNAVAILABLE" && failure.metric === "peakPrivateBytes"
    )
  );
});

await test("idle runs surface unavailable required process metrics as typed failures", () => {
  assert.deepEqual(
    validateIdleProcessMetrics({
      scenario: "visible-idle",
      metrics: {
        peakWorkingSetBytes: 100,
        medianWorkingSetBytes: 90,
        maxProcessCount: 2,
      },
    }).map((failure) => ({ code: failure.code, metric: failure.metric })),
    [
      { code: "PROCESS_METRIC_UNAVAILABLE", metric: "peakPrivateBytes" },
      { code: "PROCESS_METRIC_UNAVAILABLE", metric: "cpuTimeDeltaMs" },
    ]
  );
  assert.deepEqual(validateIdleProcessMetrics({ scenario: "first-interactive", metrics: {} }), []);
});

await test("idle metrics exclude startup and shutdown and accumulate CPU by process identity", () => {
  const process = (pid, cpuTimeMs, workingSetBytes) => ({
    pid,
    ppid: pid === 10 ? 1 : 10,
    birthToken: `birth-${pid}`,
    identityPrecision: "exact",
    imageName: pid === 10 ? "app" : "webview",
    workingSetBytes,
    privateBytes: workingSetBytes / 2,
    cpuTimeMs,
  });
  const sample = (atUnixMs, processes) => ({
    atMs: atUnixMs - 1_000,
    atUnixMs,
    processes,
    totals: aggregateProcessSample(processes),
  });
  const run = {
    scenario: "visible-idle",
    launchStartedUnixMs: 1_000,
    milestones: [
      { milestone: "startup_ready", elapsedMs: 100, wallClockUnixMs: 2_000 },
      { milestone: "scenario_completed", elapsedMs: 4_100, wallClockUnixMs: 6_000 },
    ],
    samples: [
      sample(1_500, [process(10, 100, 900)]),
      sample(2_500, [process(10, 110, 300), process(11, 50, 200)]),
      sample(4_000, [process(10, 125, 320), process(11, 65, 210)]),
      sample(5_500, [process(10, 140, 310)]),
      sample(6_500, [process(10, 200, 1_200)]),
    ],
  };
  const metrics = extractRunMetrics(run);

  assert.equal(metrics.peakWorkingSetBytes, 530);
  assert.equal(metrics.cpuTimeDeltaMs, 45);
  assert.deepEqual(validateProcessSampleCoverage(run, 1_000, 4_000), []);
  assert.ok(
    validateProcessSampleCoverage(
      { ...run, samples: [run.samples[1], run.samples[3]] },
      1_000,
      4_000
    ).some((failure) => failure.code === "PROCESS_SAMPLE_COVERAGE_LOW")
  );
});

await test("workspace safety rejects the real home and writes an owned marker", async () => {
  assert.throws(() => assertIsolatedHome(os.homedir(), os.homedir()), /real user home/);
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-baseline-selftest-"));
  try {
    const workspace = await createRunWorkspace({
      root,
      runId: "selftest-run",
      fixture: "fresh",
      scenario: "startup-cold-process",
    });
    const marker = JSON.parse(
      await readFile(path.join(workspace.home, ".aio-benchmark-home.json"))
    );
    assert.deepEqual(marker, { schemaVersion: 1, runId: "selftest-run" });
    assert.ok(workspace.reportPath.startsWith(workspace.home));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("result validator accepts structured failed runs and requires the declared run count", () => {
  const minimal = minimalBaselineResult();
  assert.equal(validateBaselineResult(minimal), minimal);
  assert.throws(
    () => validateBaselineResult({ ...minimal, rawRuns: [] }),
    /rawRuns must contain protocol.runs entries/
  );
});

await test("result writer refuses to overwrite an existing baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-result-selftest-"));
  const output = path.join(root, "baseline.json");
  try {
    await writeResult(output, minimalBaselineResult());
    await assert.rejects(
      () => writeResult(output, minimalBaselineResult()),
      /EEXIST|already exists/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function selfTestBaselineOptions(output) {
  return {
    executable: path.join(path.dirname(output), "release", "aio-coding-hub.exe"),
    fixture: "current",
    scenario: "first-interactive",
    warmups: 2,
    runs: 10,
    output,
    durationMs: null,
    sampleIntervalMs: 1_000,
  };
}

const selfTestReleaseProvenance = Object.freeze({ source: "selftest-build-manifest" });
const collectSelfTestReleaseProvenance = async () => selfTestReleaseProvenance;

await test("formal runner accepts only its exact owned in-progress marker and provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-runner-input-selftest-"));
  const output = path.join(root, "baseline.json");
  const options = selfTestBaselineOptions(output);
  const markerPath = baselineInProgressPath(output);
  const marker = {
    schemaVersion: 1,
    kind: "egui-baseline-in-progress",
    owner: "00000000-0000-4000-8000-000000000000",
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
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
    await assert.rejects(
      () => validateFormalRunnerInputs({ ...options, inProgressMarker: markerPath }),
      /release provenance is required/i
    );
    assert.equal(
      await validateFormalRunnerInputs({
        ...options,
        inProgressMarker: markerPath,
        releaseProvenance: selfTestReleaseProvenance,
      }),
      markerPath
    );
    const arbitraryMarker = path.join(root, "arbitrary.inprogress");
    await writeFile(arbitraryMarker, `${JSON.stringify(marker)}\n`);
    await assert.rejects(
      () =>
        validateFormalRunnerInputs({
          ...options,
          inProgressMarker: arbitraryMarker,
          releaseProvenance: selfTestReleaseProvenance,
        }),
      /exactly match/i
    );
    await writeFile(markerPath, `${JSON.stringify({ ...marker, kind: "untrusted" })}\n`);
    await assert.rejects(
      () =>
        validateFormalRunnerInputs({
          ...options,
          inProgressMarker: markerPath,
          releaseProvenance: selfTestReleaseProvenance,
        }),
      /marker contents/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("baseline command creates a diagnostic marker before running and retains it on failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-inprogress-selftest-"));
  const output = path.join(root, "baseline.json");
  const markerPath = baselineInProgressPath(output);
  let provenanceCollected = false;
  try {
    await assert.rejects(
      () =>
        runBaselineCommand(selfTestBaselineOptions(output), {
          collectReleaseProvenanceImpl: async () => {
            await assert.rejects(() => readFile(markerPath), /ENOENT/);
            provenanceCollected = true;
            return selfTestReleaseProvenance;
          },
          runBaselineImpl: async (runOptions) => {
            assert.equal(provenanceCollected, true);
            assert.equal(runOptions.releaseProvenance, selfTestReleaseProvenance);
            assert.equal(runOptions.inProgressMarker, markerPath);
            const marker = JSON.parse(await readFile(markerPath, "utf8"));
            assert.equal(marker.kind, "egui-baseline-in-progress");
            assert.equal(marker.outputFile, "baseline.json");
            assert.equal(marker.scenario, "first-interactive");
            assert.equal(marker.fixture, "current");
            assert.equal(marker.pid, process.pid);
            assert.match(marker.owner, /^[0-9a-f-]{36}$/i);
            throw new Error("synthetic interrupted run");
          },
        }),
      /synthetic interrupted run.*in-progress marker retained/s
    );
    await assert.rejects(() => readFile(output), /ENOENT/);
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).scenario, "first-interactive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("baseline command atomically publishes a result and removes its owned marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-publish-selftest-"));
  const output = path.join(root, "baseline.json");
  const markerPath = baselineInProgressPath(output);
  try {
    const expected = minimalBaselineResult();
    const actual = await runBaselineCommand(selfTestBaselineOptions(output), {
      collectReleaseProvenanceImpl: collectSelfTestReleaseProvenance,
      runBaselineImpl: async () => expected,
    });
    assert.equal(actual, expected);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), expected);
    await assert.rejects(() => readFile(markerPath), /ENOENT/);
    assert.deepEqual(await readdir(root), ["baseline.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("baseline command refuses to replace a stale in-progress marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-stale-marker-selftest-"));
  const output = path.join(root, "baseline.json");
  const markerPath = baselineInProgressPath(output);
  let invoked = false;
  try {
    await writeFile(markerPath, "stale diagnostic evidence\n", { flag: "wx" });
    await assert.rejects(
      () =>
        runBaselineCommand(selfTestBaselineOptions(output), {
          collectReleaseProvenanceImpl: collectSelfTestReleaseProvenance,
          runBaselineImpl: async () => {
            invoked = true;
            return minimalBaselineResult();
          },
        }),
      /in-progress marker already exists/
    );
    assert.equal(invoked, false);
    assert.equal(await readFile(markerPath, "utf8"), "stale diagnostic evidence\n");
    await assert.rejects(() => readFile(output), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("baseline command refuses an existing result without creating a marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-existing-result-selftest-"));
  const output = path.join(root, "baseline.json");
  const markerPath = baselineInProgressPath(output);
  let invoked = false;
  try {
    await writeFile(output, "immutable existing baseline\n", { flag: "wx" });
    await assert.rejects(
      () =>
        runBaselineCommand(selfTestBaselineOptions(output), {
          collectReleaseProvenanceImpl: collectSelfTestReleaseProvenance,
          runBaselineImpl: async () => {
            invoked = true;
            return minimalBaselineResult();
          },
        }),
      /baseline output already exists/
    );
    assert.equal(invoked, false);
    assert.equal(await readFile(output, "utf8"), "immutable existing baseline\n");
    await assert.rejects(() => readFile(markerPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("formal CLI rejects protocol dilution and debug executables", () => {
  const base = [
    "--executable",
    path.resolve("src-tauri/target/release/aio-coding-hub.exe"),
    "--fixture",
    "current",
    "--scenario",
    "first-interactive",
    "--warmups",
    "2",
    "--runs",
    "10",
    "--output",
    path.join(formalBaselineStagingRoot, "baseline.json"),
  ];
  assert.equal(parseBaselineArgs(base).runs, 10);
  assert.equal(parseBaselineArgs(["--", ...base]).runs, 10);
  assert.equal(path.dirname(baselineInProgressPath(base[11])), path.dirname(base[11]));
  assert.throws(() => baselineInProgressPath("baseline.json"), /absolute path/);
  assert.throws(() => parseBaselineArgs(base.with(11, path.resolve("baseline.txt"))), /.json file/);
  assert.throws(
    () =>
      parseBaselineArgs(base.with(11, path.resolve("docs/egui-migration/baselines/direct.json"))),
    /gitignored.*staging directory/i
  );
  assert.throws(
    () =>
      parseBaselineArgs(
        base.with(11, path.join(formalBaselineStagingRoot, "nested", "baseline.json"))
      ),
    /direct child/i
  );
  assert.throws(() => parseBaselineArgs(base.with(3, "fresh")), /current fixture/);
  assert.throws(() => parseBaselineArgs(base.with(7, "1")), /at least 2/);
  assert.throws(() => parseBaselineArgs(base.with(9, "9")), /at least 10/);
  assert.throws(
    () =>
      parseBaselineArgs(base.with(1, path.resolve("src-tauri/target/debug/aio-coding-hub.exe"))),
    /release executable/
  );
  assert.throws(() => parseBaselineArgs([...base, "--duration-ms", "1"]), /duration-ms/);
  const hidden = base.with(5, "hidden-tray");
  assert.throws(() => parseBaselineArgs([...hidden, "--duration-ms", "1"]), /600000/);
  assert.equal(parseBaselineArgs([...hidden, "--duration-ms", "600000"]).durationMs, 600_000);
  assert.doesNotThrow(() => assertStableBenchmarkInput("executable", "abc", "abc"));
  assert.throws(() => assertStableBenchmarkInput("executable", "abc", "def"), /executable changed/);
});

await test("Tauri build wrapper rejects a zero exit without a release executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-tauri-build-selftest-"));
  const fakeBin = path.join(root, "bin");
  await mkdir(fakeBin);
  const fakeTauri = path.join(fakeBin, process.platform === "win32" ? "tauri.cmd" : "tauri");
  await writeFile(
    fakeTauri,
    process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n"
  );
  if (process.platform !== "win32") await chmod(fakeTauri, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/tauri-build.mjs"), "--target", "x86_64-pc-windows-msvc"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          CARGO_TARGET_DIR: path.join(root, "target"),
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        },
      }
    );
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /release executable was not produced/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Tauri build wrapper rejects repository changes made during the build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aio-tauri-build-race-selftest-"));
  const fakeBin = path.join(root, "bin");
  const targetRoot = path.join(root, "target");
  const releaseRoot = path.join(targetRoot, "x86_64-pc-windows-msvc", "release");
  const sentinel = path.resolve(`scripts/.tauri-build-race-${process.pid}.txt`);
  await mkdir(fakeBin);
  const fakeTauri = path.join(fakeBin, process.platform === "win32" ? "tauri.cmd" : "tauri");
  const fakeScript =
    process.platform === "win32"
      ? [
          "@echo off",
          '> "%TAURI_BUILD_MUTATION_SENTINEL%" echo changed-during-build',
          'mkdir "%CARGO_TARGET_DIR%\\x86_64-pc-windows-msvc\\release\\bundle\\msi"',
          '> "%CARGO_TARGET_DIR%\\x86_64-pc-windows-msvc\\release\\aio-coding-hub.exe" echo executable',
          '> "%CARGO_TARGET_DIR%\\x86_64-pc-windows-msvc\\release\\bundle\\msi\\fixture.msi" echo installer',
          "exit /b 0",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'printf "changed-during-build\\n" > "$TAURI_BUILD_MUTATION_SENTINEL"',
          'mkdir -p "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/msi"',
          'printf "executable\\n" > "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/aio-coding-hub.exe"',
          'printf "installer\\n" > "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/msi/fixture.msi"',
          "exit 0",
          "",
        ].join("\n");
  await writeFile(fakeTauri, fakeScript);
  if (process.platform !== "win32") await chmod(fakeTauri, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/tauri-build.mjs"), "--target", "x86_64-pc-windows-msvc"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          CARGO_TARGET_DIR: targetRoot,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          TAURI_BUILD_MUTATION_SENTINEL: sentinel,
        },
      }
    );
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /repository.*changed during build|build input.*changed/i);
    await assert.rejects(() =>
      readFile(`${path.join(releaseRoot, "aio-coding-hub.exe")}.build-provenance.json`)
    );
  } finally {
    await rm(sentinel, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

await test("fixed gateway stub serves JSON and delayed SSE only on loopback", async () => {
  const stub = await startGatewayStub();
  try {
    assert.match(stub.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const missingAuthResponse = await fetch(`${stub.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "benchmark-model", stream: false, messages: [] }),
    });
    assert.equal(missingAuthResponse.status, 401);

    const jsonResponse = await fetch(`${stub.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-aio-benchmark-local-only",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "benchmark-model", stream: false, messages: [] }),
    });
    assert.equal(jsonResponse.status, 200);
    assert.equal((await jsonResponse.json()).id, "chatcmpl-egui-baseline");

    const streamResponse = await fetch(`${stub.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-aio-benchmark-local-only",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "benchmark-model", stream: true, messages: [] }),
    });
    assert.match(streamResponse.headers.get("content-type"), /^text\/event-stream/);
    const streamBody = await streamResponse.text();
    assert.equal((streamBody.match(/^data: \{/gm) ?? []).length, 5);
    assert.match(streamBody, /data: \[DONE\]/);
    const snapshot = stub.snapshot();
    assert.deepEqual(
      { ...snapshot, streamSchedules: undefined },
      {
        requests: 3,
        authenticatedRequests: 2,
        nonStreamRequests: 1,
        streamRequests: 1,
        rejectedRequests: 1,
        streamSchedules: undefined,
      }
    );
    assert.equal(snapshot.streamSchedules.length, 1);
    assert.equal(snapshot.streamSchedules[0].eventWriteOffsetsMs.length, 6);
    assert.equal(snapshot.streamSchedules[0].intervalDeviationsMs.length, 5);
    assert.equal(snapshot.streamSchedules[0].eventWriteOffsetsMs[0], 0);
    assert.ok(
      snapshot.streamSchedules[0].eventWriteOffsetsMs.every(
        (value, index, values) =>
          Number.isFinite(value) && (index === 0 || value > values[index - 1])
      )
    );
    assert.ok(snapshot.streamSchedules[0].intervalDeviationsMs.every(Number.isFinite));
  } finally {
    await stub.close();
  }
});

await test("real fixture process orchestration captures a descendant and milestones", async () => {
  const result = await runFixtureProcessSelfTest(scriptPath);
  assert.equal(result.exitCode, 0);
  assert.ok(result.samples.some((sample) => sample.processes.length >= 2));
  assert.deepEqual(
    result.milestones.map((row) => row.milestone),
    ["process_entry", "startup_ready", "first_interactive", "shutdown_completed"]
  );
});

console.log(`[egui-baseline:selftest] ${passed} tests passed`);

await import("./egui-baseline/process-tree.selftest.mjs");
await import("./egui-baseline/release-provenance.selftest.mjs");
await import("./egui-baseline/workspace.selftest.mjs");
await import("./egui-baseline/result.selftest.mjs");
