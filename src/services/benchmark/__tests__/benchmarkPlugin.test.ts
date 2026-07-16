import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriInvoke } from "../../../test/mocks/tauri";
import {
  benchmarkPluginFinish,
  benchmarkPluginRecord,
  benchmarkPluginRequestLogs,
  benchmarkPluginRunGatewayLoad,
} from "../benchmarkPlugin";

describe("benchmark plugin service adapter", () => {
  beforeEach(() => {
    vi.mocked(tauriInvoke).mockClear();
  });

  it("owns the private benchmark plugin command names and payload shapes", async () => {
    vi.mocked(tauriInvoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce({ condition: "idle" })
      .mockResolvedValueOnce(undefined);

    await benchmarkPluginRecord({ milestone: "ready", data: { count: 1 } });
    await expect(benchmarkPluginRequestLogs()).resolves.toEqual([{ id: 1 }]);
    await expect(benchmarkPluginRunGatewayLoad("idle")).resolves.toEqual({ condition: "idle" });
    await benchmarkPluginFinish();

    expect(tauriInvoke).toHaveBeenNthCalledWith(1, "plugin:benchmark|record", {
      payload: { milestone: "ready", data: { count: 1 } },
    });
    expect(tauriInvoke).toHaveBeenNthCalledWith(2, "plugin:benchmark|request_logs");
    expect(tauriInvoke).toHaveBeenNthCalledWith(3, "plugin:benchmark|run_gateway_load", {
      condition: "idle",
    });
    expect(tauriInvoke).toHaveBeenNthCalledWith(4, "plugin:benchmark|finish");
  });
});
