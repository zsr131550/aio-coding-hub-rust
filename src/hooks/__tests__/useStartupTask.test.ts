import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockLogToConsole } = vi.hoisted(() => ({
  mockLogToConsole: vi.fn(),
}));

vi.mock("../../services/consoleLog", () => ({ logToConsole: mockLogToConsole }));

import { useStartupTask } from "../useStartupTask";

describe("hooks/useStartupTask", () => {
  it("runs task on mount without logging on success", async () => {
    const task = vi.fn().mockResolvedValue("ok");

    renderHook(() => useStartupTask(task, "init", "Init failed"));

    expect(task).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(mockLogToConsole).not.toHaveBeenCalled();
    });
  });

  it("logs warning when task rejects", async () => {
    const task = vi.fn().mockRejectedValue(new Error("boom"));

    renderHook(() => useStartupTask(task, "startup", "Startup failed"));

    await vi.waitFor(() => {
      expect(mockLogToConsole).toHaveBeenCalledWith(
        "warn",
        "Startup failed",
        expect.objectContaining({
          stage: "startup",
          error: "Error: boom",
        })
      );
    });
  });

  it("does not run the task when disabled", async () => {
    const task = vi.fn().mockResolvedValue("ok");

    renderHook(() => useStartupTask(task, "network", "Network sync failed", false));

    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();
    expect(mockLogToConsole).not.toHaveBeenCalled();
  });
});
