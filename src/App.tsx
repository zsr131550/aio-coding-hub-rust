import { useMemo, type CSSProperties } from "react";
import { Toaster } from "sonner";
import { HashRouter } from "react-router-dom";
import { AppRoutes } from "./app/AppRoutes";
import { useAppBootstrap } from "./app/useAppBootstrap";
import { BenchmarkFirstInteractiveProbe } from "./benchmark/BenchmarkFirstInteractiveProbe";
import { BenchmarkGatewayLoadProbe } from "./benchmark/BenchmarkGatewayLoadProbe";
import { BenchmarkLogsScene } from "./benchmark/BenchmarkLogsScene";
import { readBenchmarkConfig } from "./benchmark/benchmarkBridge";

type CssVarsStyle = CSSProperties & Record<`--toast-${string}`, string | number>;

const TOASTER_STYLE: CssVarsStyle = {
  "--toast-close-button-start": "unset",
  "--toast-close-button-end": "0",
  "--toast-close-button-transform": "translate(35%, -35%)",
};

export default function App() {
  const benchmarkConfig = useMemo(() => readBenchmarkConfig(), []);
  const enableAmbientWork = benchmarkConfig == null;
  useAppBootstrap({
    enableBackgroundTasks: enableAmbientWork,
    enableAmbientStartupTasks: enableAmbientWork,
  });

  return (
    <>
      <Toaster richColors closeButton position="top-center" style={TOASTER_STYLE} />
      <HashRouter>
        {benchmarkConfig?.scenario === "logs-10k" ? <BenchmarkLogsScene /> : <AppRoutes />}
        {benchmarkConfig ? (
          <>
            <BenchmarkFirstInteractiveProbe config={benchmarkConfig} />
            <BenchmarkGatewayLoadProbe config={benchmarkConfig} />
          </>
        ) : null}
      </HashRouter>
    </>
  );
}
