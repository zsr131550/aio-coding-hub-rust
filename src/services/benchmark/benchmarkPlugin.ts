import { invoke } from "@tauri-apps/api/core";

export type BenchmarkPluginGatewayCondition = "idle" | "active";

export type BenchmarkPluginMilestonePayload = Readonly<{
  milestone: string;
  data: Record<string, unknown>;
}>;

export async function benchmarkPluginRecord(
  payload: BenchmarkPluginMilestonePayload
): Promise<void> {
  await invoke("plugin:benchmark|record", { payload });
}

export function benchmarkPluginRequestLogs(): Promise<unknown> {
  return invoke<unknown>("plugin:benchmark|request_logs");
}

export function benchmarkPluginRunGatewayLoad(
  condition: BenchmarkPluginGatewayCondition
): Promise<unknown> {
  return invoke<unknown>("plugin:benchmark|run_gateway_load", { condition });
}

export async function benchmarkPluginFinish(): Promise<void> {
  await invoke("plugin:benchmark|finish");
}
