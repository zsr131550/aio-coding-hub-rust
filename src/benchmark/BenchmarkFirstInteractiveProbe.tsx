import { useEffect, useRef } from "react";
import { useAppStartupStatus } from "../app/startupStatusStore";
import {
  afterNextBenchmarkPaint,
  type BenchmarkConfig,
  finishBenchmark,
  recordBenchmarkMilestone,
} from "./benchmarkBridge";

export function BenchmarkFirstInteractiveProbe({ config }: { config: BenchmarkConfig }) {
  const status = useAppStartupStatus();
  const recorded = useRef(false);

  useEffect(() => {
    if (status.currentStage !== "ready" || recorded.current) return;
    recorded.current = true;
    let cancelled = false;

    const run = async () => {
      if (config.scenario === "hidden-tray") return;

      await afterNextBenchmarkPaint();
      if (cancelled) return;
      await recordBenchmarkMilestone("first_interactive");

      if (
        config.scenario === "startup-cold-process" ||
        config.scenario === "startup-warm-process" ||
        config.scenario === "first-interactive"
      ) {
        await finishBenchmark();
        return;
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [config, status.currentStage]);

  return null;
}
