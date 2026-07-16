# Full behavior compatibility matrix

"Complete compatibility" means preserving user-observable workflows, persisted data, protocol behavior, state/error/confirmation semantics, keyboard and accessibility access, scale behavior, and supported-platform integration. It does not require pixel-identical React rendering.

## Routes

| ID/path | Core workflow and states | Mutation/confirmation | Keyboard/a11y and scale | Plugin/data/platform boundary | Current evidence | egui gate |
| --- | --- | --- | --- | --- | --- | --- |
| `home` `/` | Gateway overview, providers, active requests, request logs, usage/cost; loading, unavailable, empty, stale, error | Gateway start/stop and quick actions retain current feedback | Skip target, focusable actions, tooltips; dense panels remain scannable at 10k logs | `home.overview.cards` manifest-only; gateway events and summary commands; all desktop OSes | `src/pages/__tests__/HomePage.test.tsx`, home hook tests | C3 live dashboard plus event-rate/frame test |
| `providers` `/providers` | List, sort modes, route order, create/edit/duplicate, OAuth/API key, availability, limits | Save, enable, reorder, delete and OAuth disconnect/reset preserve current confirm/error timing | Dialog focus, labels, radio/switch semantics, keyboard reorder alternative, long URL/model wrapping | `providers.editor.sections` mounted; four provider slots manifest-only; DB/provider/gateway contracts | `src/pages/__tests__/ProvidersPage.test.tsx`, `src/pages/providers/__tests__/*` | C3 provider hard-screen, OAuth and reorder smoke |
| `sessions` `/sessions` | Source/project browsing with loading, empty and source errors | Read-only navigation | Search/list navigation and stable focus | CLI session files; OS/path differences | `src/pages/__tests__/SessionsPage.test.tsx` | C3 source/project navigation parity |
| `sessions-project` `/sessions/:source/:projectId` | Session list for one source/project; missing project and empty history | Session deletion keeps current confirmation and refresh | Back navigation, list focus, long paths/titles | Parameter decoding and CLI filesystem | `src/pages/__tests__/SessionsProjectPage.test.tsx` | C3 delete and deep-link parity |
| `sessions-messages` `/sessions/:source/:projectId/session/*` | Full message transcript, nested wildcard session identity, loading/error/empty | Read-only | Select/copy text, transcript reading order, large/CJK content | Large CLI transcript files; wildcard route identity | `src/pages/__tests__/SessionsMessagesPage.test.tsx` | C3 large transcript/IME/copy smoke |
| `workspaces` `/workspaces` | Workspace list and CLI configuration status; loading/empty/error | Switch/sync/configure workspace with current result feedback | Table/list focus and long path handling | Claude/Codex/Gemini config files and platform paths | Page smoke plus workspace service/Rust tests | C3 multi-CLI workspace mutation parity |
| `prompts` `/prompts` | List/edit prompt content, defaults and enabled state | Upsert, enable, delete, sync defaults; destructive action confirmed | Editor undo/redo, clipboard, CJK IME, labels | Prompt DB plus default files | `src/pages/__tests__/PromptsPage.test.tsx`, `src/pages/prompts/__tests__/*` | C3 editor hard-screen and CRUD parity |
| `mcp` `/mcp` | Server cards, JSON import, workspace discovery; loading/empty/parse error | Upsert, enable, delete, import; delete confirmation | Dialog focus, structured-field labels, keyboard actions | MCP JSON/config per CLI and platform | `src/pages/__tests__/McpPage.test.tsx`, `src/pages/mcp/**/__tests__/*` | C3 import/validation/confirm parity |
| `plugins` `/plugins` | Installed/market/detail, permissions, config, runtime reports, update/rollback/quarantine | Install/update/enable/disable/uninstall/rollback/grants preserve preview and confirms | Dialog focus, generated field labels/errors, keyboard access | `plugins.detail.panels` manifest-only; Plugin API v1 and Extension Host JSON-RPC | `src/pages/__tests__/PluginsPage.test.tsx`, plugin page tests, SDK/Rust contract tests | C3 host-rendered schema and lifecycle hard-screen |
| `logs` `/logs` | Request list/detail, attempts, live events, filters, empty/unavailable/error | Refresh and log cleanup/export actions retain confirmation/result semantics | Virtualized list focus/selection, detail tabs, 10k scale | `logs.detail.tabs` mounted; `logs.detail.actions` manifest-only; request-log/event schemas | `src/pages/__tests__/LogsPage.test.tsx`, gateway event tests, C0 10k scene | C3 10k filter/select P95 and live stream parity |
| `console` `/console` | Bounded application console, severity/filter/empty state | Clear/export behavior and feedback | Select/copy, scrolling, keyboard filtering | In-memory frontend diagnostics plus backend notices | `src/pages/__tests__/ConsolePage.test.tsx` | C3 bounded-log and clipboard parity |
| `usage` `/usage` | Cost/token/cache/availability charts, filters, tables, loading/empty/partial/error | Date/provider/filter state and CSV export | Chart/table alternate labels, keyboard filters, dense provider scale | `usage.panels` manifest-only; usage and price DB queries | `src/pages/__tests__/UsagePage.*.test.tsx`, usage component tests | C3 chart tooltip/15-day heatmap hard-screen |
| `settings` `/settings/*` | General, gateway, notification, appearance, data, about; unknown subpath fallback | Persist settings, import/export/reset/data actions with risky confirmations | Sidebar/tab focus, form labels, switches, validation summary | `settings.sections` mounted; settings schema v34, config bundle v1/v2, OS notification/theme | `src/pages/settings/__tests__/*` | C3 all tabs, import/export and platform smoke |
| `cli-manager` `/cli-manager` | CLI discovery/version/config editors, WSL, proxy and update states | Config writes, update and WSL setup retain confirms/errors | TOML/editor IME, undo/redo, validation, dialog focus | CLI executables/files; WSL Windows-only; platform paths | `src/pages/__tests__/CliManagerPage.test.tsx`, CLI component/Rust tests | C3 TOML editor hard-screen and Windows WSL smoke |
| `skills` `/skills` | Installed/local skills, enable state, import and update status | Install local, enable, update, uninstall/delete with current confirms | Search/list focus, file picker labels, long metadata | Skill repos/files across supported CLI homes | `src/pages/__tests__/SkillsPage.test.tsx`, `src/pages/skills/__tests__/*` | C3 lifecycle and file-dialog parity |
| `skills-market` `/skills/market` | Repository discovery/search, loading/empty/network error | Install/import and repository actions | Search/results keyboard flow and accessible status | Remote index behavior plus local install boundary | `src/pages/__tests__/SkillsMarketPage.test.tsx` | C3 discovery/install parity with synthetic source |
| `fallback` `*` | Unknown path redirects to `/` with replacement | None | No focus trap or stale page | Router-only | `src/app/__tests__/AppRoutes.test.tsx` | C3 route contract exact test |

## Global surfaces

| Surface | Compatibility requirement | Current evidence | egui gate |
| --- | --- | --- | --- |
| App layout | Stable main-content landmark, skip navigation, route loading boundary, window drag region, no page overflow overlap | `src/layout/AppLayout.tsx`, route tests | C3 keyboard traversal and resize/scale smoke |
| Startup banner | Exact startup stages, failed stage/message, retry eligibility and retry state; no heartbeat substitution for readiness | `src/components/app/__tests__/AppStartupStatusBanner.test.tsx`, startup event fixture | C2 typed event parity; C3 retry UI parity |
| Sidebar navigation | Every route entry, current-location state, collapse/expand and keyboard/tooltips | Sidebar tests and route contract | C3 full navigation and narrow-window smoke |
| Toast/notice | Notice event delivery, severity/title/body/action mapping and bounded presentation | Notice fixture, event/service tests | C2 event mapping; C3 notification smoke |
| Update dialog | Check, available/no-update/error, progress, install/restart and non-dismissable installing state | `src/components/UpdateDialog.tsx`, updater hooks/tests, signed fixture corpus | C3 signed updater end-to-end smoke per OS |
| Window/tray lifecycle | Close-to-tray, start minimized, show/restore, single-instance activation, theme, clean gateway shutdown and explicit exit | Resident/lifecycle Rust tests and C0 hidden-tray baseline | C3 manual Windows/macOS/Linux lifecycle matrix |

## Plugin UI slots

The current shell mounts exactly three slots: `providers.editor.sections`, `settings.sections`, and `logs.detail.tabs`.

The following eight slots are valid in Plugin API v1 manifests but are not mounted by the current shell: `app.sidebar.items`, `home.overview.cards`, `providers.editor.fields`, `providers.card.badges`, `providers.card.actions`, `logs.detail.actions`, `usage.panels`, and `plugins.detail.panels`. Full compatibility must preserve this distinction; migration must not accidentally activate reserved slots.

## Cross-cutting blocking gates

- Generated/runtime command names, payloads, errors, and six risky-confirm action/resource contracts match the machine snapshot.
- SQLite v25 migrates to current v35; current DB/settings/config bundle and filenames remain readable and writable.
- Gateway HTTP/SSE behavior, failover, logs, event delivery/coalescing, and shutdown remain compatible.
- CJK IME, clipboard, editor undo/redo, keyboard navigation, focus restoration, screen-reader labels, display scaling, and long-text layout pass the targeted hard screens.
- Tray, single instance, updater, notifications, file dialogs, URL/path opening, CLI discovery, and clean shutdown pass on every officially supported desktop target.
- Plugin API v1 TypeScript packages continue to install and execute through the Rust Extension Host compatibility boundary until a separately approved API version change.
