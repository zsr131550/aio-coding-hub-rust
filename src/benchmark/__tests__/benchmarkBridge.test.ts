import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  finish: vi.fn(),
  record: vi.fn(),
  requestLogs: vi.fn(),
  runGatewayLoad: vi.fn(),
}));

vi.mock("../../services/benchmark/benchmarkPlugin", () => ({
  benchmarkPluginFinish: plugin.finish,
  benchmarkPluginRecord: plugin.record,
  benchmarkPluginRequestLogs: plugin.requestLogs,
  benchmarkPluginRunGatewayLoad: plugin.runGatewayLoad,
}));

import {
  afterNextBenchmarkPaint,
  benchmarkFailureDetails,
  finishBenchmark,
  readBenchmarkConfig,
  recordBenchmarkMilestone,
  runBenchmarkGatewayLoad,
} from "../benchmarkBridge";

describe("benchmark bridge", () => {
  beforeEach(() => {
    plugin.finish.mockReset();
    plugin.record.mockReset();
    plugin.requestLogs.mockReset();
    plugin.runGatewayLoad.mockReset();
  });

  it("stays disabled when the injected global is missing or malformed", () => {
    expect(readBenchmarkConfig(undefined)).toBeNull();
    expect(
      readBenchmarkConfig({ schemaVersion: 1, runId: "../escape", scenario: "logs-10k" })
    ).toBeNull();
    expect(
      readBenchmarkConfig({ schemaVersion: 1, runId: "run-1", scenario: "unknown" })
    ).toBeNull();
  });

  it("accepts the frozen runner contract and invokes only the benchmark plugin", async () => {
    const config = readBenchmarkConfig({
      schemaVersion: 1,
      runId: "run-001",
      scenario: "logs-10k",
      durationMs: 250,
    });
    expect(config).toEqual({
      schemaVersion: 1,
      runId: "run-001",
      scenario: "logs-10k",
      durationMs: 250,
    });

    plugin.record.mockResolvedValue(undefined);
    plugin.finish.mockResolvedValue(undefined);
    await recordBenchmarkMilestone("logs_dataset_ready", { rowCount: 10_000 });
    await finishBenchmark();
    const gatewayResult = {
      condition: "idle",
      nonStreamRequests: 24,
      nonStreamConcurrency: 4,
      nonStreamElapsedMs: 100,
      throughputRequestsPerSecond: 240,
      nonStreamTtfbMs: Array(24).fill(2),
      streamRequests: 4,
      streamDataEvents: 5,
      streamDoneEvents: 1,
      streamEventIntervalMs: 20,
      streamTtfbMs: Array(4).fill(3),
      streamInterEventMs: Array(20).fill(20),
      observedStreamTransportChunks: Array(4).fill(6),
    };
    plugin.runGatewayLoad.mockResolvedValueOnce(gatewayResult);
    await expect(runBenchmarkGatewayLoad("idle")).resolves.toEqual(gatewayResult);

    expect(plugin.record).toHaveBeenCalledWith({
      milestone: "logs_dataset_ready",
      data: { rowCount: 10_000 },
    });
    expect(plugin.finish).toHaveBeenCalledTimes(1);
    expect(plugin.runGatewayLoad).toHaveBeenCalledWith("idle");
  });

  it("waits for two animation frames before resolving a paint boundary", async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });

    const pending = afterNextBenchmarkPaint(requestAnimationFrame);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    callbacks.shift()?.(10);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    callbacks.shift()?.(20);
    await expect(pending).resolves.toBeUndefined();
  });

  it("limits and redacts persisted benchmark failure details", () => {
    const failure = benchmarkFailureDetails(
      new Error(
        "SEC_INVALID_INPUT\nBearer abc.def api_key=sk-secret " +
          "https://user:pass@example.test/private C:\\Users\\Alice\\secret.txt " +
          "x".repeat(1_000)
      )
    );

    expect(failure.errorCode).toBe("SEC_INVALID_INPUT");
    expect(failure.errorMessage.length).toBeLessThanOrEqual(512);
    expect(failure.errorMessage).toContain("Bearer [REDACTED]");
    expect(failure.errorMessage).not.toMatch(/abc\.def|sk-secret|example\.test|Alice/);
    expect(benchmarkFailureDetails({ message: "untrusted object" })).toEqual({
      errorCode: "BENCHMARK_FAILURE",
      errorMessage: "unknown benchmark error",
    });
  });
});
