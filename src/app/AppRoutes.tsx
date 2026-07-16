import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "../layout/AppLayout";
import { HomePage } from "../pages/HomePage";
import { Spinner } from "../ui/Spinner";
import routeContract from "./app-routes.contract.json";

const CliManagerPage = lazy(() =>
  import("../pages/CliManagerPage").then((m) => ({ default: m.CliManagerPage }))
);
const ConsolePage = lazy(() =>
  import("../pages/ConsolePage").then((m) => ({ default: m.ConsolePage }))
);
const LogsPage = lazy(() => import("../pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const McpPage = lazy(() => import("../pages/McpPage").then((m) => ({ default: m.McpPage })));
const PluginsPage = lazy(() =>
  import("../pages/PluginsPage").then((m) => ({ default: m.PluginsPage }))
);
const PromptsPage = lazy(() =>
  import("../pages/PromptsPage").then((m) => ({ default: m.PromptsPage }))
);
const ProvidersPage = lazy(() =>
  import("../pages/ProvidersPage").then((m) => ({ default: m.ProvidersPage }))
);
const SessionsPage = lazy(() =>
  import("../pages/SessionsPage").then((m) => ({ default: m.SessionsPage }))
);
const SessionsProjectPage = lazy(() =>
  import("../pages/SessionsProjectPage").then((m) => ({ default: m.SessionsProjectPage }))
);
const SessionsMessagesPage = lazy(() =>
  import("../pages/SessionsMessagesPage").then((m) => ({ default: m.SessionsMessagesPage }))
);
const SettingsPage = lazy(() =>
  import("../pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const SkillsPage = lazy(() =>
  import("../pages/SkillsPage").then((m) => ({ default: m.SkillsPage }))
);
const SkillsMarketPage = lazy(() =>
  import("../pages/SkillsMarketPage").then((m) => ({ default: m.SkillsMarketPage }))
);
const UsagePage = lazy(() => import("../pages/UsagePage").then((m) => ({ default: m.UsagePage })));
const WorkspacesPage = lazy(() =>
  import("../pages/WorkspacesPage").then((m) => ({ default: m.WorkspacesPage }))
);

type PageRouteId =
  | "providers"
  | "sessions"
  | "sessions-project"
  | "sessions-messages"
  | "workspaces"
  | "prompts"
  | "mcp"
  | "plugins"
  | "logs"
  | "console"
  | "usage"
  | "settings"
  | "cli-manager"
  | "skills"
  | "skills-market";

type RouteContractEntry = {
  id: string;
  kind: "index" | "page" | "fallback";
  path: string;
  samplePath: string;
  redirectTo?: string;
};

const pageComponents: Record<PageRouteId, ComponentType> = {
  providers: ProvidersPage,
  sessions: SessionsPage,
  "sessions-project": SessionsProjectPage,
  "sessions-messages": SessionsMessagesPage,
  workspaces: WorkspacesPage,
  prompts: PromptsPage,
  mcp: McpPage,
  plugins: PluginsPage,
  logs: LogsPage,
  console: ConsolePage,
  usage: UsagePage,
  settings: SettingsPage,
  "cli-manager": CliManagerPage,
  skills: SkillsPage,
  "skills-market": SkillsMarketPage,
};

const routes = routeContract.routes as RouteContractEntry[];

function pageComponent(routeId: string): ComponentType {
  const page = pageComponents[routeId as PageRouteId];
  if (!page) throw new Error(`Route contract references unknown page id: ${routeId}`);
  return page;
}

function PageLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

function LazyPage({ Page }: { Page: ComponentType }) {
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Page />
    </Suspense>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        {routes.map((route) => {
          if (route.kind === "index") {
            return <Route key={route.id} index element={<HomePage />} />;
          }
          if (route.kind === "fallback") {
            return (
              <Route
                key={route.id}
                path={route.path}
                element={<Navigate to={route.redirectTo ?? "/"} replace />}
              />
            );
          }
          const Page = pageComponent(route.id);
          return <Route key={route.id} path={route.path} element={<LazyPage Page={Page} />} />;
        })}
      </Route>
    </Routes>
  );
}
