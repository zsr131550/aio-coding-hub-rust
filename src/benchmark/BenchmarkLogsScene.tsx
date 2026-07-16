import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStartupStatus } from "../app/startupStatusStore";
import { HomeRequestLogsPanel } from "../components/home/HomeRequestLogsPanel";
import type { RequestLogSummary } from "../services/gateway/requestLogs";
import {
  afterNextBenchmarkPaint,
  finishBenchmark,
  recordBenchmarkMilestone,
  requestBenchmarkLogs,
} from "./benchmarkBridge";

const FILTER_VALUE = "RATE_LIMITED";

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function beginMeasuredLogFilter({
  rows,
  now,
  applyFilter,
}: {
  rows: RequestLogSummary[];
  now: () => number;
  applyFilter: (filter: string) => void;
}): { filterStarted: number; matches: RequestLogSummary[] } {
  const matches = rows.filter((row) => row.error_code?.includes(FILTER_VALUE));
  const filterStarted = now();
  applyFilter(FILTER_VALUE);
  return { filterStarted, matches };
}

export function BenchmarkLogsScene() {
  const status = useAppStartupStatus();
  const started = useRef(false);
  const [requestLogs, setRequestLogs] = useState<RequestLogSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const filteredLogs = useMemo(
    () =>
      filter.length === 0
        ? requestLogs
        : requestLogs.filter((row) => row.error_code?.includes(filter)),
    [filter, requestLogs]
  );

  useEffect(() => {
    if (status.currentStage !== "ready" || started.current) return;
    started.current = true;
    let cancelled = false;

    const run = async () => {
      try {
        const loadStarted = monotonicNow();
        const rows = await requestBenchmarkLogs();
        if (cancelled) return;
        setRequestLogs(rows);
        await afterNextBenchmarkPaint();
        await recordBenchmarkMilestone("logs_dataset_ready", {
          durationMs: monotonicNow() - loadStarted,
          rowCount: rows.length,
        });

        const { filterStarted, matches } = beginMeasuredLogFilter({
          rows,
          now: monotonicNow,
          applyFilter: setFilter,
        });
        await afterNextBenchmarkPaint();
        await recordBenchmarkMilestone("logs_filter_painted", {
          durationMs: monotonicNow() - filterStarted,
          filter: FILTER_VALUE,
          matchCount: matches.length,
        });

        const selectionStarted = monotonicNow();
        setSelectedLogId(matches[0]?.id ?? null);
        await afterNextBenchmarkPaint();
        await recordBenchmarkMilestone("logs_select_painted", {
          durationMs: monotonicNow() - selectionStarted,
          selectedLogId: matches[0]?.id ?? null,
        });
        await finishBenchmark();
      } catch {
        if (!cancelled) {
          setFailed(true);
          await recordBenchmarkMilestone("scenario_failed", { phase: "logs-10k" }).catch(
            () => undefined
          );
          await finishBenchmark().catch(() => undefined);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [status.currentStage]);

  return (
    <main className="flex h-screen min-h-0 flex-col gap-3 bg-background p-3">
      <input aria-label="日志筛选" className="sr-only" readOnly tabIndex={-1} value={filter} />
      {failed ? <div role="alert">基准场景失败</div> : null}
      <HomeRequestLogsPanel
        displayOptions={{
          customTooltip: false,
          openLogsPageButton: false,
          refreshButton: false,
          compactModeToggle: false,
        }}
        title="代理记录"
        compactModeOverride={false}
        traces={[]}
        activeRequests={[]}
        requestLogs={filteredLogs}
        requestLogsLoading={requestLogs.length === 0 && !failed}
        requestLogsRefreshing={false}
        requestLogsAvailable={!failed}
        onRefreshRequestLogs={() => undefined}
        selectedLogId={selectedLogId}
        onSelectLogId={setSelectedLogId}
      />
    </main>
  );
}
