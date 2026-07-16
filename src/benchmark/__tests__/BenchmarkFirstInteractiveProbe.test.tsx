import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAppStartupStatusStore,
  setAppStartupStatusSnapshot,
} from "../../app/startupStatusStore";

const bridge = vi.hoisted(() => ({
  afterPaint: vi.fn(() => new Promise<void>(() => {})),
  finish: vi.fn(async () => {}),
  record: vi.fn(async () => {}),
}));

vi.mock("../benchmarkBridge", async () => {
  const actual = await vi.importActual<typeof import("../benchmarkBridge")>("../benchmarkBridge");
  return {
    ...actual,
    afterNextBenchmarkPaint: bridge.afterPaint,
    finishBenchmark: bridge.finish,
    recordBenchmarkMilestone: bridge.record,
  };
});

import { BenchmarkFirstInteractiveProbe } from "../BenchmarkFirstInteractiveProbe";

describe("BenchmarkFirstInteractiveProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStartupStatusStore();
    bridge.afterPaint.mockClear();
    bridge.finish.mockClear();
    bridge.record.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAppStartupStatusStore();
  });

  function markStartupReady() {
    act(() => {
      setAppStartupStatusSnapshot({
        running: false,
        currentStage: "ready",
        failedStage: null,
        errorMessage: null,
        canRetry: false,
      } as any);
    });
  }

  it("leaves hidden-tray completion to the native timer without requesting animation frames", async () => {
    render(
      <BenchmarkFirstInteractiveProbe
        config={Object.freeze({
          schemaVersion: 1,
          runId: "hidden-run",
          scenario: "hidden-tray",
          durationMs: 25,
        })}
      />
    );
    markStartupReady();
    await act(async () => vi.advanceTimersByTimeAsync(25));

    expect(bridge.afterPaint).not.toHaveBeenCalled();
    expect(bridge.record).not.toHaveBeenCalledWith("first_interactive");
    expect(bridge.finish).not.toHaveBeenCalled();
  });

  it("records visible-idle first interactive paint but leaves completion to Rust", async () => {
    bridge.afterPaint.mockResolvedValueOnce();
    render(
      <BenchmarkFirstInteractiveProbe
        config={Object.freeze({
          schemaVersion: 1,
          runId: "visible-run",
          scenario: "visible-idle",
          durationMs: 25,
        })}
      />
    );
    markStartupReady();
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(25));

    expect(bridge.afterPaint).toHaveBeenCalledTimes(1);
    expect(bridge.record).toHaveBeenCalledWith("first_interactive");
    expect(bridge.finish).not.toHaveBeenCalled();
  });

  it("still completes first-interactive after recording the painted milestone", async () => {
    bridge.afterPaint.mockResolvedValueOnce();
    render(
      <BenchmarkFirstInteractiveProbe
        config={Object.freeze({
          schemaVersion: 1,
          runId: "interactive-run",
          scenario: "first-interactive",
          durationMs: null,
        })}
      />
    );
    markStartupReady();
    await act(async () => Promise.resolve());

    expect(bridge.record).toHaveBeenCalledWith("first_interactive");
    expect(bridge.finish).toHaveBeenCalledTimes(1);
  });
});
