import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAppStartupStatusStore,
  setAppStartupStatusSnapshot,
} from "../../app/startupStatusStore";

const bridge = vi.hoisted(() => ({
  finish: vi.fn(async () => {}),
  record: vi.fn(async () => {}),
  runGatewayLoad: vi.fn(),
}));

vi.mock("../benchmarkBridge", async () => {
  const actual = await vi.importActual<typeof import("../benchmarkBridge")>("../benchmarkBridge");
  return {
    ...actual,
    finishBenchmark: bridge.finish,
    recordBenchmarkMilestone: bridge.record,
    runBenchmarkGatewayLoad: bridge.runGatewayLoad,
  };
});

import { BenchmarkGatewayLoadProbe } from "../BenchmarkGatewayLoadProbe";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function gatewayConfig(runId: string) {
  return Object.freeze({
    schemaVersion: 1 as const,
    runId,
    scenario: "gateway-load" as const,
    durationMs: null,
  });
}

function gatewayResult(condition: "idle" | "active") {
  return {
    condition,
    nonStreamRequests: 24,
    nonStreamConcurrency: 4,
    nonStreamElapsedMs: 100,
    throughputRequestsPerSecond: condition === "idle" ? 100 : 90,
    nonStreamTtfbMs: Array(24).fill(2),
    streamRequests: 4,
    streamDataEvents: 5,
    streamDoneEvents: 1,
    streamEventIntervalMs: 20,
    streamTtfbMs: Array(4).fill(3),
    streamInterEventMs: Array(20).fill(20),
    observedStreamTransportChunks: Array(4).fill(6),
  };
}

describe("BenchmarkGatewayLoadProbe", () => {
  let nextFrameId: number;
  let pendingFrames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    nextFrameId = 1;
    pendingFrames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId++;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      pendingFrames.delete(frameId);
    });
    resetAppStartupStatusStore();
    bridge.finish.mockClear();
    bridge.record.mockClear();
    bridge.runGatewayLoad.mockReset();
    bridge.runGatewayLoad.mockImplementation(async (condition: "idle" | "active") =>
      gatewayResult(condition)
    );
  });

  afterEach(() => {
    resetAppStartupStatusStore();
    vi.restoreAllMocks();
  });

  function flushNextFrame(timestamp = 16): void {
    const next = pendingFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(next, "expected a pending animation frame").toBeDefined();
    const [frameId, callback] = next!;
    pendingFrames.delete(frameId);
    callback(timestamp);
  }

  it("runs odd numbered runs idle-first once startup is ready", async () => {
    const idle = deferred<ReturnType<typeof gatewayResult>>();
    bridge.runGatewayLoad.mockImplementation((condition: "idle" | "active") =>
      condition === "idle" ? idle.promise : Promise.resolve(gatewayResult(condition))
    );
    const { container } = render(
      <BenchmarkGatewayLoadProbe config={gatewayConfig("gateway-load-measure-01")} />
    );
    expect(bridge.runGatewayLoad).not.toHaveBeenCalled();

    act(() => {
      setAppStartupStatusSnapshot({
        running: false,
        currentStage: "ready",
        failedStage: null,
        errorMessage: null,
        canRetry: false,
      } as any);
    });

    await waitFor(() => expect(bridge.runGatewayLoad).toHaveBeenCalledTimes(1));
    expect(bridge.runGatewayLoad).toHaveBeenLastCalledWith("idle");
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(container.querySelector("[data-benchmark-active-frame]")).toBeNull();

    await act(async () => {
      idle.resolve(gatewayResult("idle"));
      await idle.promise;
    });
    expect(bridge.runGatewayLoad).toHaveBeenCalledTimes(1);

    act(() => flushNextFrame());
    await waitFor(() => expect(bridge.finish).toHaveBeenCalledTimes(1));
    expect(bridge.runGatewayLoad).toHaveBeenNthCalledWith(1, "idle");
    expect(bridge.runGatewayLoad).toHaveBeenNthCalledWith(2, "active");
    expect(bridge.record).toHaveBeenNthCalledWith(
      1,
      "gateway_load_ready",
      expect.objectContaining({
        condition: "idle",
        streamDataEvents: 5,
        streamDoneEvents: 1,
        streamInterEventMs: expect.any(Array),
      })
    );
    expect(bridge.record).toHaveBeenNthCalledWith(
      2,
      "gateway_load_completed",
      expect.objectContaining({
        condition: "active",
        streamDataEvents: 5,
        streamDoneEvents: 1,
        streamInterEventMs: expect.any(Array),
        activeFrameCount: 1,
      })
    );
    expect(container.querySelector("[data-benchmark-active-frame]")).toBeNull();
  });

  it("runs even numbered runs active-first to counterbalance phase order", async () => {
    const active = deferred<ReturnType<typeof gatewayResult>>();
    const { container } = render(
      <BenchmarkGatewayLoadProbe config={gatewayConfig("gateway-load-measure-02")} />
    );
    bridge.runGatewayLoad.mockImplementation((condition: "idle" | "active") => {
      if (condition === "idle") {
        expect(container.querySelector("[data-benchmark-active-frame]")).toBeNull();
        return Promise.resolve(gatewayResult(condition));
      }
      return active.promise;
    });

    act(() => {
      setAppStartupStatusSnapshot({
        running: false,
        currentStage: "ready",
        failedStage: null,
        errorMessage: null,
        canRetry: false,
      } as any);
    });

    expect(bridge.runGatewayLoad).not.toHaveBeenCalled();
    expect(container.querySelector("[data-benchmark-active-frame]")).toBeNull();

    act(() => {
      flushNextFrame(16);
      flushNextFrame(32);
    });
    await waitFor(() => expect(bridge.runGatewayLoad).toHaveBeenCalledTimes(1));
    expect(bridge.runGatewayLoad).toHaveBeenLastCalledWith("active");
    expect(container.querySelector("[data-benchmark-active-frame]")).not.toBeNull();

    await act(async () => {
      active.resolve(gatewayResult("active"));
      await active.promise;
    });
    await waitFor(() => expect(bridge.finish).toHaveBeenCalledTimes(1));
    expect(bridge.runGatewayLoad).toHaveBeenNthCalledWith(1, "active");
    expect(bridge.runGatewayLoad).toHaveBeenNthCalledWith(2, "idle");
    expect(bridge.record).toHaveBeenCalledWith(
      "gateway_load_ready",
      expect.objectContaining({ condition: "idle" })
    );
    expect(bridge.record).toHaveBeenCalledWith(
      "gateway_load_completed",
      expect.objectContaining({
        condition: "active",
        activeFrameCount: 1,
      })
    );
    expect(pendingFrames).toHaveLength(0);
    expect(container.querySelector("[data-benchmark-active-frame]")).toBeNull();
  });

  it("cancels the commit wait when unmounted before the first active frame", async () => {
    const { unmount } = render(
      <BenchmarkGatewayLoadProbe config={gatewayConfig("gateway-load-measure-02")} />
    );

    act(() => {
      setAppStartupStatusSnapshot({
        running: false,
        currentStage: "ready",
        failedStage: null,
        errorMessage: null,
        canRetry: false,
      } as any);
    });
    expect(pendingFrames).toHaveLength(1);

    unmount();

    expect(pendingFrames).toHaveLength(0);
    expect(bridge.runGatewayLoad).not.toHaveBeenCalled();
    expect(bridge.record).not.toHaveBeenCalled();
    expect(bridge.finish).not.toHaveBeenCalled();
  });

  it("cancels active frames and reports failure when the active load throws", async () => {
    bridge.runGatewayLoad.mockRejectedValueOnce(
      new Error(
        "create benchmark provider: SEC_INVALID_INPUT: timeout=5 api_key=sk-benchmark-secret"
      )
    );
    const { container } = render(
      <BenchmarkGatewayLoadProbe config={gatewayConfig("gateway-load-measure-02")} />
    );

    act(() => {
      setAppStartupStatusSnapshot({
        running: false,
        currentStage: "ready",
        failedStage: null,
        errorMessage: null,
        canRetry: false,
      } as any);
    });
    act(() => flushNextFrame());

    await waitFor(() => expect(bridge.finish).toHaveBeenCalledTimes(1));
    expect(bridge.record).toHaveBeenCalledWith("scenario_failed", {
      phase: "gateway-load",
      condition: "active",
      stage: "run_gateway_load",
      errorCode: "SEC_INVALID_INPUT",
      errorMessage: "create benchmark provider: SEC_INVALID_INPUT: timeout=5 api_key=[REDACTED]",
    });
    expect(pendingFrames).toHaveLength(0);
    expect(container.querySelector("[data-benchmark-active-frame]")).toBeNull();
  });
});
