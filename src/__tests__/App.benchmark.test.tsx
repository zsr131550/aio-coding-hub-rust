import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../test/utils/reactQuery";

const probes = vi.hoisted(() => ({
  firstInteractive: vi.fn(),
  gatewayLoad: vi.fn(),
}));

const bootstrap = vi.hoisted(() => vi.fn());

vi.mock("../app/useAppBootstrap", () => ({ useAppBootstrap: bootstrap }));
vi.mock("../app/AppRoutes", () => ({ AppRoutes: () => <div data-testid="normal-routes" /> }));
vi.mock("../benchmark/BenchmarkLogsScene", () => ({
  BenchmarkLogsScene: () => <div data-testid="benchmark-logs" />,
}));
vi.mock("../benchmark/BenchmarkFirstInteractiveProbe", () => ({
  BenchmarkFirstInteractiveProbe: (props: unknown) => {
    probes.firstInteractive(props);
    return null;
  },
}));
vi.mock("../benchmark/BenchmarkGatewayLoadProbe", () => ({
  BenchmarkGatewayLoadProbe: (props: unknown) => {
    probes.gatewayLoad(props);
    return null;
  },
}));

import App from "../App";

function renderApp() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <App />
    </QueryClientProvider>
  );
}

describe("App benchmark isolation", () => {
  afterEach(() => {
    delete (window as any).__AIO_BENCHMARK__;
    bootstrap.mockClear();
    probes.firstInteractive.mockClear();
    probes.gatewayLoad.mockClear();
  });

  it("keeps normal routes when the benchmark bridge is absent", () => {
    renderApp();
    expect(screen.getByTestId("normal-routes")).toBeInTheDocument();
    expect(screen.queryByTestId("benchmark-logs")).not.toBeInTheDocument();
    expect(probes.firstInteractive).not.toHaveBeenCalled();
    expect(probes.gatewayLoad).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledWith({
      enableBackgroundTasks: true,
      enableAmbientStartupTasks: true,
    });
  });

  it("renders the unreachable logs scene only for a valid injected contract", () => {
    (window as any).__AIO_BENCHMARK__ = Object.freeze({
      schemaVersion: 1,
      runId: "run-001",
      scenario: "logs-10k",
      durationMs: null,
    });
    renderApp();
    expect(screen.getByTestId("benchmark-logs")).toBeInTheDocument();
    expect(screen.queryByTestId("normal-routes")).not.toBeInTheDocument();
    expect(probes.firstInteractive).toHaveBeenCalledWith({
      config: expect.objectContaining({ runId: "run-001", scenario: "logs-10k" }),
    });
    expect(probes.gatewayLoad).toHaveBeenCalledWith({
      config: expect.objectContaining({ runId: "run-001", scenario: "logs-10k" }),
    });
    expect(bootstrap).toHaveBeenCalledWith({
      enableBackgroundTasks: false,
      enableAmbientStartupTasks: false,
    });
  });

  it("keeps the injected config stable across app rerenders", () => {
    (window as any).__AIO_BENCHMARK__ = Object.freeze({
      schemaVersion: 1,
      runId: "run-stable",
      scenario: "first-interactive",
      durationMs: null,
    });
    const client = createTestQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    );
    const firstConfig = (probes.firstInteractive.mock.lastCall?.[0] as { config: unknown }).config;

    view.rerender(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    );
    const secondConfig = (probes.firstInteractive.mock.lastCall?.[0] as { config: unknown }).config;

    expect(secondConfig).toBe(firstConfig);
  });
});
