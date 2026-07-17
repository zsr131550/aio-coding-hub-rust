<div align="center">
  <img src="public/logo.jpg" width="120" alt="AIO Coding Hub Logo" />

# AIO Coding Hub

**Local AI CLI Unified Gateway** — Route Claude Code / Codex / Gemini CLI through a single entry point

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-lightgrey?style=flat-square)](#installation)
[![Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)

[简体中文](./README.md) | English

[Installation](#installation) · [Quick Start](#quick-start) · [Features](#features) · [How It Works](#how-it-works) · [FAQ](#faq) · [Contributing](#contributing)

</div>

---

## Why?

| Problem | How AIO Coding Hub Solves It |
|---------|------------------------------|
| Each CLI needs separate API config | **Unified gateway** — all CLIs route through `127.0.0.1` |
| Upstream goes down, requests fail | **Smart failover** — auto-switch providers with circuit breaker |
| Different scenarios need different provider sets | **Sort templates** — multiple sets, per-CLI activation |
| No idea how many tokens or how much it costs | **Full observability** — trace, usage stats, cost estimation |
| Different projects need different Prompts / MCP configs | **Workspace isolation** — per-project CLI config, one-click switch |

> This is a **local desktop tool + local gateway**: it listens on `127.0.0.1` only, all data stays on your machine — no public deployment, remote access, or multi-tenancy.

---

## Screenshots

### Home — Heatmap, usage trends, active sessions, request logs

![Home](public/screenshots/home.png)

### Usage — Token stats, cache hit rate, latency, cost leaderboard

![Usage](public/screenshots/usage.png)

### Model Validation — Multi-dimensional channel verification

![Model Validation](public/screenshots/modelValidate.png)

---

## Features

### 🔀 Gateway Proxy

- Single entry point for Claude Code / Codex / Gemini CLI
- Per-CLI proxy toggle on Home, one-click on/off
- Custom model name mapping
- Auto-fix for SSE / JSON responses

### 🛡️ Smart Routing & Resilience

- Multi-provider priority ordering + automatic failover
- Circuit breaker (configurable threshold & recovery time)
- Sticky session for consistent provider routing
- Sort templates: multiple provider sets, activated per CLI
- Drag-to-reorder, per-provider toggle, instant switching

### 📊 Usage & Observability

- Token usage analytics (by CLI / provider / model)
- Cost estimation + auto-synced model pricing
- Request trace & real-time console logs
- Request heatmap (time-of-day distribution)
- Cache trend chart: per-provider hit rate, 60% warning line
- Availability: provider timeline dots, 15s auto-refresh

### 🗂️ Workspace Management

- Per-project isolation for Prompts, MCP, and Skill configs
- Workspace compare, clone, switch & rollback
- Auto-sync configs to each CLI

### 🧩 Skill Market

- Discover and install Skills from Git repositories
- Repository management, filtering, and sorting
- Batch management linked to workspaces

### 🔌 Plugin System

- Official built-in plugin: Privacy Filter
- Extension Host plugins: commands, provider extension values, gateway hooks, protocol bridge skeleton, host-rendered UI
- Plugin permissions, config schema, audit log, enable / disable / uninstall
- SDK & scaffolding: `@aio-coding-hub/plugin-sdk`, `create-aio-plugin`

Plugin authors should start from the [Plugin Developer Guide](docs/plugins/README.md). Community plugins use the Extension Host exclusively.

### 🖥️ CLI Management

- Direct editing of Claude Code settings
- CodeMirror editor for Codex config.toml
- Environment variable conflict detection
- Local session history browser (project → session → messages)

### ✅ Model Validation

- Multi-dimensional validation templates (token truncation, Extended Thinking, etc.)
- Cross-provider signature verification
- Batch validation + history

### ⚙️ More

- Updater compatibility API, autostart, single instance
- Data import / export / reset
- WSL support

---

## Installation

This repository is currently in the source-only phase of the full Rust/egui rewrite. Official installers, Homebrew Casks, and auto-update channels will not be published until the rewrite and compatibility acceptance are complete.

### Build from Source

<details>
<summary>Prerequisites</summary>

**General:** Node.js 22.12+, pnpm, Rust 1.90+

**Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++")

**macOS:** `xcode-select --install`

**Linux (Ubuntu/Debian):**

```bash
sudo apt-get update
sudo apt-get install -y libasound2-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

</details>

```bash
git clone https://github.com/zsr131550/aio-coding-hub-rust.git
cd aio-coding-hub-rust
pnpm install

# Development
pnpm tauri:dev

# Build the current platform
pnpm tauri:build
```

<!-- SUPPORT_MATRIX_SOURCE_BUILD:START -->
| Scope | Command | Notes |
| --- | --- | --- |
| Source build | `pnpm tauri:build:win:x64` | Windows x64; Source build supported; no release binaries or updates are published during the rewrite |
| Source build | `pnpm tauri:build:mac:x64` | macOS Intel; Source build supported; no release binaries or updates are published during the rewrite |
| Source build | `pnpm tauri:build:mac:arm64` | macOS Apple Silicon; Source build supported; no release binaries or updates are published during the rewrite |
| Source build | `pnpm tauri:build:linux:x64` | Linux x64; Source build supported; no release binaries or updates are published during the rewrite |
| Experimental | `pnpm tauri:build:mac:universal` | macOS Universal; Experimental source build; no release binaries or updates are published during the rewrite |
| Experimental | `pnpm tauri:build:win:arm64` | Windows ARM64; Experimental source build; no release binaries or updates are published during the rewrite |
<!-- SUPPORT_MATRIX_SOURCE_BUILD:END -->

These commands are for local source validation only; they do not create GitHub Releases, updater manifests, or signed installers.

---

## Quick Start

1. **Add a provider** — Open the Providers page and add an upstream (official API / self-hosted proxy / company gateway)
2. **Turn on the proxy** — On the Home page, toggle the "Proxy" switch for the target CLI; requests now route through the local gateway
3. **Use your CLI as usual** — Run Claude Code / Codex / Gemini CLI in the terminal, nothing else changes
4. **Watch the numbers** — Check traces, token usage, and cost in the Console / Usage pages

Verify the gateway is running:

```bash
curl http://127.0.0.1:37123/health
# {"status":"ok"}
```

---

## How It Works

```
 Claude Code ──┐
 Codex        ─┼──▶  AIO Coding Hub Gateway (127.0.0.1:37123)  ──▶  Provider A (priority 1)
 Gemini CLI  ──┘     sort templates · circuit breaker · failover     ├▶  Provider B (priority 2)
                     · usage metering                                └▶  Provider C (priority 3)
```

All three CLIs send requests to the local gateway. The gateway picks a provider based on the active sort template, trips the circuit breaker and fails over to the next provider on errors, and records traces, token usage, and cost along the way.

---

## FAQ

**Why are there no installers or automatic updates?**

The project is undergoing a full Rust/egui rewrite. Until compatibility acceptance is complete, only source builds are maintained; no Releases, signed installers, or updater manifests are created.

**What port does the gateway use? How do I check it's running?**

It listens on `127.0.0.1:37123` by default. Run `curl http://127.0.0.1:37123/health` — `{"status":"ok"}` means it's up.

**Do my API keys or request data ever leave my machine?**

No. The gateway only listens on the loopback interface, and all config and stats live in a local SQLite database.

**Blank window or crash on Linux Wayland?**

The current source baseline sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` automatically. If the issue persists, check the system WebKitGTK/EGL dependencies; `scripts/repack-linux-appimage-wayland.sh` is only for locally built AppImages.

**Which platforms get auto-updates?**

No platform currently uses automatic updates. The updater API remains compatible but reports that the channel is disabled; an independent release channel will be designed after the full Rust rewrite.

---

## Plugin Development

The plugin system is open to community extensions, built exclusively on the Extension Host:

- [Plugin Overview](docs/plugins/README.md)
- [Developer Guide](docs/plugins/developer-guide.md)
- [Plugin SDK](docs/plugins/reference/sdk.md)
- [Official Example Plugin](docs/plugins/examples/privacy-filter.md)
- [Plugin API Reference](docs/plugins/reference/README.md)
- [Manifest v1 Spec](docs/plugin-manifest-v1.md)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 19 · TypeScript · Tailwind CSS · Vite |
| **State** | TanStack Query · React Hooks |
| **Desktop** | Tauri 2 |
| **Backend** | Rust · Axum (HTTP Gateway) |
| **Database** | SQLite (rusqlite) |
| **Testing** | Vitest · Testing Library · MSW · Cargo Test |

---

## Contributing

Issues and PRs welcome! We follow [Conventional Commits](https://www.conventionalcommits.org/).

```bash
feat(ui): add usage heatmap
fix(gateway): handle timeout correctly
docs: update installation guide
```

Please run the checks locally before opening a PR:

```bash
pnpm check:precommit       # Quick pre-commit (frontend + Rust check)
pnpm check:precommit:full  # Full check (formatting + clippy)
pnpm check:prepush         # Coverage + backend tests + clippy
pnpm test:unit             # Frontend unit tests
pnpm tauri:test            # Backend tests
```

---

## Credits

Inspired by these excellent open-source projects:

- [cc-switch](https://github.com/farion1231/cc-switch)
- [claude-code-hub](https://github.com/ding113/claude-code-hub)
- [code-switch-R](https://github.com/Rogers-F/code-switch-R)

---

## License

[MIT License](LICENSE)
