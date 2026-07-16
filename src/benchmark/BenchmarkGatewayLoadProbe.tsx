import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStartupStatus } from "../app/startupStatusStore";
import {
  type BenchmarkGatewayCondition,
  type BenchmarkGatewayLoadResult,
  type BenchmarkConfig,
  benchmarkFailureDetails,
  finishBenchmark,
  recordBenchmarkMilestone,
  runBenchmarkGatewayLoad,
} from "./benchmarkBridge";

const IDLE_FIRST_PHASES = ["idle", "active"] as const;
const ACTIVE_FIRST_PHASES = ["active", "idle"] as const;

function gatewayPhaseOrder(runId: string): readonly BenchmarkGatewayCondition[] {
  const numericSuffix = /-([0-9]+)$/.exec(runId)?.[1];
  if (numericSuffix == null) return IDLE_FIRST_PHASES;
  const finalDigit = Number(numericSuffix[numericSuffix.length - 1]);
  return finalDigit % 2 === 0 ? ACTIVE_FIRST_PHASES : IDLE_FIRST_PHASES;
}

export function BenchmarkGatewayLoadProbe({ config }: { config: BenchmarkConfig }) {
  const status = useAppStartupStatus();
  const started = useRef(false);
  const [activeFrame, setActiveFrame] = useState<number | null>(null);
  const committedActiveFrameCount = useRef(0);
  const activeFrameIsCommitted = useRef(false);
  const resolveActiveFrameCommit = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    activeFrameIsCommitted.current = activeFrame != null;
    if (activeFrame != null) committedActiveFrameCount.current += 1;
    const resolve = resolveActiveFrameCommit.current;
    resolveActiveFrameCommit.current = null;
    resolve?.();
  }, [activeFrame]);

  useEffect(() => {
    if (config.scenario !== "gateway-load" || status.currentStage !== "ready" || started.current) {
      return;
    }
    started.current = true;
    let cancelled = false;
    let frameRequest: number | null = null;
    let frameSequence = 0;

    const cancelFrameRequest = () => {
      if (frameRequest != null) cancelAnimationFrame(frameRequest);
      frameRequest = null;
    };
    const settlePendingFrameCommit = () => {
      const resolve = resolveActiveFrameCommit.current;
      resolveActiveFrameCommit.current = null;
      resolve?.();
    };
    const cancelActiveFrames = () => {
      cancelFrameRequest();
      settlePendingFrameCommit();
    };
    const stopActiveFrames = async () => {
      cancelActiveFrames();
      if (cancelled || !activeFrameIsCommitted.current) return;
      await new Promise<void>((resolve) => {
        resolveActiveFrameCommit.current = resolve;
        setActiveFrame(null);
      });
    };
    const renderActiveFrame = () => {
      if (cancelled) return;
      frameSequence += 1;
      setActiveFrame(frameSequence);
      frameRequest = requestAnimationFrame(renderActiveFrame);
    };
    const startActiveFrames = async () => {
      committedActiveFrameCount.current = 0;
      frameSequence = 0;
      await new Promise<void>((resolve) => {
        resolveActiveFrameCommit.current = resolve;
        frameRequest = requestAnimationFrame(renderActiveFrame);
      });
    };

    const run = async () => {
      let currentCondition: BenchmarkGatewayCondition | null = null;
      let failureStage = "initialize";
      try {
        let idle: BenchmarkGatewayLoadResult | null = null;
        let active: BenchmarkGatewayLoadResult | null = null;
        let activeFrameCount = 0;

        for (const condition of gatewayPhaseOrder(config.runId)) {
          currentCondition = condition;
          if (condition === "active") {
            failureStage = "start_active_frames";
            await startActiveFrames();
            if (cancelled) return;
          }

          try {
            failureStage = "run_gateway_load";
            const result = await runBenchmarkGatewayLoad(condition);
            if (condition === "active") {
              active = result;
              activeFrameCount = committedActiveFrameCount.current;
              if (activeFrameCount <= 0) {
                failureStage = "validate_active_frame";
                throw new Error("gateway active load started without a committed frame");
              }
            } else {
              idle = result;
            }
          } finally {
            if (condition === "active") await stopActiveFrames();
          }

          if (cancelled) return;
        }

        failureStage = "validate_results";
        if (idle == null || active == null) {
          throw new Error("gateway benchmark did not complete both phases");
        }
        failureStage = "record_results";
        await recordBenchmarkMilestone("gateway_load_ready", idle);
        if (cancelled) return;
        await recordBenchmarkMilestone("gateway_load_completed", {
          ...active,
          activeFrameCount,
        });
        failureStage = "finish";
        await finishBenchmark();
      } catch (error) {
        await stopActiveFrames();
        if (cancelled) return;
        await recordBenchmarkMilestone("scenario_failed", {
          phase: "gateway-load",
          ...(currentCondition == null ? {} : { condition: currentCondition }),
          stage: failureStage,
          ...benchmarkFailureDetails(error),
        }).catch(() => undefined);
        await finishBenchmark().catch(() => undefined);
      }
    };

    void run();
    return () => {
      cancelled = true;
      cancelActiveFrames();
    };
  }, [config, status.currentStage]);

  if (activeFrame == null) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed bottom-0 left-0 z-[9999] h-1 w-16 bg-foreground"
      data-benchmark-active-frame={activeFrame}
      style={{ transform: `scaleX(${((activeFrame % 16) + 1) / 16})`, transformOrigin: "left" }}
    />
  );
}
