import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../AppRoutes";
import routeContract from "../app-routes.contract.json";

vi.mock("../../layout/AppLayout", async () => {
  const { Outlet } = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    AppLayout: () => (
      <div>
        <span>layout-shell</span>
        <Outlet />
      </div>
    ),
  };
});

vi.mock("../../ui/Spinner", () => ({
  Spinner: () => <div role="status">loading-route</div>,
}));

vi.mock("../../pages/HomePage", () => ({
  HomePage: () => <h1>home-route</h1>,
}));
vi.mock("../../pages/ProvidersPage", () => ({
  ProvidersPage: () => <h1>providers-route</h1>,
}));
vi.mock("../../pages/SessionsPage", () => ({
  SessionsPage: () => <h1>sessions-route</h1>,
}));
vi.mock("../../pages/SessionsProjectPage", () => ({
  SessionsProjectPage: () => <h1>sessions-project-route</h1>,
}));
vi.mock("../../pages/SessionsMessagesPage", () => ({
  SessionsMessagesPage: () => <h1>sessions-messages-route</h1>,
}));
vi.mock("../../pages/WorkspacesPage", () => ({
  WorkspacesPage: () => <h1>workspaces-route</h1>,
}));
vi.mock("../../pages/PromptsPage", () => ({
  PromptsPage: () => <h1>prompts-route</h1>,
}));
vi.mock("../../pages/McpPage", () => ({
  McpPage: () => <h1>mcp-route</h1>,
}));
vi.mock("../../pages/PluginsPage", () => ({
  PluginsPage: () => <h1>plugins-route</h1>,
}));
vi.mock("../../pages/LogsPage", () => ({
  LogsPage: () => <h1>logs-route</h1>,
}));
vi.mock("../../pages/ConsolePage", () => ({
  ConsolePage: () => <h1>console-route</h1>,
}));
vi.mock("../../pages/UsagePage", () => ({
  UsagePage: () => <h1>usage-route</h1>,
}));
vi.mock("../../pages/SettingsPage", () => ({
  SettingsPage: () => <h1>settings-route</h1>,
}));
vi.mock("../../pages/CliManagerPage", () => ({
  CliManagerPage: () => <h1>cli-manager-route</h1>,
}));
vi.mock("../../pages/SkillsPage", () => ({
  SkillsPage: () => <h1>skills-route</h1>,
}));
vi.mock("../../pages/SkillsMarketPage", () => ({
  SkillsMarketPage: () => <h1>skills-market-route</h1>,
}));

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe("app/AppRoutes", () => {
  const pageCases = routeContract.routes
    .filter((route) => route.kind !== "fallback")
    .map((route) => [route.samplePath, `${route.id}-route`] as const);

  it.each(pageCases)("renders %s", async (path, heading) => {
    renderRoute(path);

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText("layout-shell")).toBeInTheDocument();
  });

  it("redirects unknown paths to home", async () => {
    const fallback = routeContract.routes.find((route) => route.kind === "fallback");
    if (!fallback) throw new Error("route contract is missing its fallback route");
    renderRoute(fallback.samplePath);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "home-route" })).toBeInTheDocument();
    });
  });
});
