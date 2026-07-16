import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAppStartupStatusStore,
  setAppStartupStatusSnapshot,
} from "../../app/startupStatusStore";

const bridge = vi.hoisted(() => ({
  afterPaint: vi.fn(async () => {}),
  finish: vi.fn(async () => {}),
  record: vi.fn(async () => {}),
  requestLogs: vi.fn(),
}));

vi.mock("../benchmarkBridge", () => ({
  afterNextBenchmarkPaint: bridge.afterPaint,
  finishBenchmark: bridge.finish,
  recordBenchmarkMilestone: bridge.record,
  requestBenchmarkLogs: bridge.requestLogs,
}));

vi.mock("../../components/home/HomeRequestLogsPanel", () => ({
  HomeRequestLogsPanel: ({ requestLogs, selectedLogId }: any) => (
    <div
      data-testid="logs-panel"
      data-count={requestLogs.length}
      data-selected={selectedLogId ?? ""}
    />
  ),
}));

import * as benchmarkLogsScene from "../BenchmarkLogsScene";

const { BenchmarkLogsScene } = benchmarkLogsScene;

describe("BenchmarkLogsScene", () => {
  beforeEach(() => {
    resetAppStartupStatusStore();
    bridge.afterPaint.mockClear();
    bridge.finish.mockClear();
    bridge.record.mockClear();
    bridge.requestLogs.mockReset();
  });

  afterEach(() => resetAppStartupStatusStore());

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

  it("prepares filter matches before starting the paint timer", () => {
    const order: string[] = [];
    const row = {
      id: 1,
      get error_code() {
        order.push("scan");
        return "RATE_LIMITED";
      },
    };

    const result = (benchmarkLogsScene as any).beginMeasuredLogFilter({
      rows: [row],
      now: () => {
        order.push("timer");
        return 42;
      },
      applyFilter: () => order.push("state"),
    });

    expect(order).toEqual(["scan", "timer", "state"]);
    expect(result).toEqual({ filterStarted: 42, matches: [row] });
  });

  it("waits for startup readiness, then measures the deterministic scene exactly once", async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      error_code: index % 17 === 0 ? "RATE_LIMITED" : null,
    }));
    bridge.requestLogs.mockResolvedValue(rows);

    render(<BenchmarkLogsScene />);

    await act(async () => Promise.resolve());
    expect(bridge.requestLogs).not.toHaveBeenCalled();
    expect(bridge.afterPaint).not.toHaveBeenCalled();
    expect(bridge.record).not.toHaveBeenCalled();
    expect(bridge.finish).not.toHaveBeenCalled();

    markStartupReady();

    expect(await screen.findByTestId("logs-panel")).toHaveAttribute("data-count", "589");
    await waitFor(() => expect(bridge.finish).toHaveBeenCalledTimes(1));

    const recordedMilestones = (bridge.record.mock.calls as unknown as Array<[string]>).map(
      ([milestone]) => milestone
    );
    expect(recordedMilestones).toEqual([
      "logs_dataset_ready",
      "logs_filter_painted",
      "logs_select_painted",
    ]);
    expect(bridge.record).toHaveBeenNthCalledWith(
      2,
      "logs_filter_painted",
      expect.objectContaining({ matchCount: 589 })
    );
    expect(screen.getByTestId("logs-panel")).toHaveAttribute("data-selected", "1");
    expect(bridge.afterPaint).toHaveBeenCalledTimes(3);

    markStartupReady();
    await act(async () => Promise.resolve());
    expect(bridge.requestLogs).toHaveBeenCalledTimes(1);
    expect(bridge.record).toHaveBeenCalledTimes(3);
    expect(bridge.finish).toHaveBeenCalledTimes(1);
  });

  it("preserves the failure milestone and completion after startup is ready", async () => {
    bridge.requestLogs.mockRejectedValue(new Error("fixture unavailable"));

    render(<BenchmarkLogsScene />);
    markStartupReady();

    await waitFor(() => expect(bridge.finish).toHaveBeenCalledTimes(1));
    expect(bridge.requestLogs).toHaveBeenCalledTimes(1);
    expect(bridge.afterPaint).not.toHaveBeenCalled();
    expect(bridge.record).toHaveBeenCalledTimes(1);
    expect(bridge.record).toHaveBeenCalledWith("scenario_failed", { phase: "logs-10k" });
    expect(screen.getByRole("alert")).toHaveTextContent("基准场景失败");
  });
});
