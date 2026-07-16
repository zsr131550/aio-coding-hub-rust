import {
  benchmarkPluginFinish,
  benchmarkPluginRecord,
  benchmarkPluginRequestLogs,
  benchmarkPluginRunGatewayLoad,
  type BenchmarkPluginGatewayCondition,
} from "../services/benchmark/benchmarkPlugin";
import type { RequestLogSummary } from "../services/gateway/requestLogs";

export const BENCHMARK_SCENARIOS = [
  "startup-cold-process",
  "startup-warm-process",
  "first-interactive",
  "visible-idle",
  "hidden-tray",
  "logs-10k",
  "gateway-load",
] as const;

export type BenchmarkScenario = (typeof BENCHMARK_SCENARIOS)[number];

export type BenchmarkConfig = Readonly<{
  schemaVersion: 1;
  runId: string;
  scenario: BenchmarkScenario;
  durationMs: number | null;
}>;

export type BenchmarkGatewayCondition = BenchmarkPluginGatewayCondition;

export type BenchmarkGatewayLoadResult = Readonly<{
  condition: BenchmarkGatewayCondition;
  nonStreamRequests: number;
  nonStreamConcurrency: number;
  nonStreamElapsedMs: number;
  throughputRequestsPerSecond: number;
  nonStreamTtfbMs: number[];
  streamRequests: number;
  streamDataEvents: number;
  streamDoneEvents: number;
  streamEventIntervalMs: number;
  streamTtfbMs: number[];
  streamInterEventMs: number[];
  observedStreamTransportChunks: number[];
}>;

declare global {
  interface Window {
    __AIO_BENCHMARK__?: unknown;
  }
}

const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BENCHMARK_ERROR_CODE = /\b[A-Z][A-Z0-9_]{2,63}\b/;
const MAX_BENCHMARK_ERROR_MESSAGE_LENGTH = 512;
const scenarioSet = new Set<string>(BENCHMARK_SCENARIOS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function benchmarkFailureDetails(error: unknown): Readonly<{
  errorCode: string;
  errorMessage: string;
}> {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown benchmark error";
  const errorCode = BENCHMARK_ERROR_CODE.exec(rawMessage)?.[0] ?? "BENCHMARK_FAILURE";
  const errorMessage = rawMessage
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
    .trim();

  return {
    errorCode,
    errorMessage: (errorMessage || "unknown benchmark error").slice(
      0,
      MAX_BENCHMARK_ERROR_MESSAGE_LENGTH
    ),
  };
}

export function readBenchmarkConfig(
  value: unknown = typeof window === "undefined" ? undefined : window.__AIO_BENCHMARK__
): BenchmarkConfig | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.runId !== "string" || !SAFE_RUN_ID.test(value.runId)) return null;
  if (typeof value.scenario !== "string" || !scenarioSet.has(value.scenario)) return null;
  const durationMs = value.durationMs;
  if (
    durationMs !== null &&
    durationMs !== undefined &&
    (!Number.isSafeInteger(durationMs) ||
      (durationMs as number) < 1 ||
      (durationMs as number) > 1_800_000)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: value.runId,
    scenario: value.scenario as BenchmarkScenario,
    durationMs: typeof durationMs === "number" ? durationMs : null,
  });
}

export async function recordBenchmarkMilestone(
  milestone: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await benchmarkPluginRecord({ milestone, data });
}

function isRequestLogSummary(value: unknown): value is RequestLogSummary {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.id) &&
    typeof value.trace_id === "string" &&
    (value.cli_key === "claude" || value.cli_key === "codex" || value.cli_key === "gemini") &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    Array.isArray(value.route) &&
    typeof value.created_at_ms === "number"
  );
}

export async function requestBenchmarkLogs(): Promise<RequestLogSummary[]> {
  const value = await benchmarkPluginRequestLogs();
  if (!Array.isArray(value) || value.length !== 10_000 || !value.every(isRequestLogSummary)) {
    throw new Error("benchmark request-log fixture failed frontend contract validation");
  }
  return value;
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

export async function runBenchmarkGatewayLoad(
  condition: BenchmarkGatewayCondition
): Promise<BenchmarkGatewayLoadResult> {
  const value = await benchmarkPluginRunGatewayLoad(condition);
  if (
    !isRecord(value) ||
    value.condition !== condition ||
    value.nonStreamRequests !== 24 ||
    value.nonStreamConcurrency !== 4 ||
    typeof value.nonStreamElapsedMs !== "number" ||
    !Number.isFinite(value.nonStreamElapsedMs) ||
    typeof value.throughputRequestsPerSecond !== "number" ||
    !Number.isFinite(value.throughputRequestsPerSecond) ||
    !isFiniteNumberArray(value.nonStreamTtfbMs) ||
    value.nonStreamTtfbMs.length !== 24 ||
    value.streamRequests !== 4 ||
    value.streamDataEvents !== 5 ||
    value.streamDoneEvents !== 1 ||
    value.streamEventIntervalMs !== 20 ||
    !isFiniteNumberArray(value.streamTtfbMs) ||
    value.streamTtfbMs.length !== 4 ||
    !isFiniteNumberArray(value.streamInterEventMs) ||
    value.streamInterEventMs.length !== 20 ||
    !isFiniteNumberArray(value.observedStreamTransportChunks) ||
    value.observedStreamTransportChunks.length !== 4 ||
    !value.observedStreamTransportChunks.every((count) => Number.isSafeInteger(count) && count > 0)
  ) {
    throw new Error("gateway benchmark result failed frontend contract validation");
  }
  return value as BenchmarkGatewayLoadResult;
}

export async function finishBenchmark(): Promise<void> {
  await benchmarkPluginFinish();
}

export function afterNextBenchmarkPaint(
  requestFrame: (callback: FrameRequestCallback) => number = window.requestAnimationFrame.bind(
    window
  )
): Promise<void> {
  return new Promise((resolve) => {
    requestFrame(() => requestFrame(() => resolve()));
  });
}
