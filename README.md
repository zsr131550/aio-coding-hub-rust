<div align="center">
  <img src="public/logo.jpg" width="120" alt="AIO Coding Hub Logo" />

# AIO Coding Hub

**本地 AI CLI 统一网关** — 让 Claude Code / Codex / Gemini CLI 请求走同一个入口

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-lightgrey?style=flat-square)](#安装)
[![Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)

简体中文 | [English](./README_EN.md)

[安装](#安装) · [快速开始](#快速开始) · [核心功能](#核心功能) · [工作原理](#工作原理) · [FAQ](#faq) · [参与贡献](#参与贡献)

</div>

---

## 为什么需要它？

| 痛点 | AIO Coding Hub 的解决方案 |
|------|--------------------------|
| 每个 CLI 都要单独配置 API | **统一网关** — 所有 CLI 走 `127.0.0.1` 本机入口 |
| 上游不稳定时请求失败 | **智能 Failover** — 自动切换供应商，熔断保护 |
| 不同场景需要不同的供应商组合 | **排序模板** — 多套组合按 CLI 激活，一键切换 |
| 不知道用了多少 Token 和花了多少钱 | **全链路可观测** — Trace 追踪、用量统计、花费估算 |
| 不同项目需要不同的 Prompts / MCP 配置 | **工作区隔离** — 按项目管理 CLI 配置，一键切换 |

> 本项目定位为 **单机桌面工具 + 本地网关**：网关只监听 `127.0.0.1`，所有数据保存在本机，不做公网部署、远程访问和多租户。

---

## 产品截图

### 首页 — 热力图、用量趋势、活跃 Session、请求日志

![首页](public/screenshots/home.png)

### 用量 — Token 统计、缓存命中率、耗时、花费排行

![用量](public/screenshots/usage.png)

### 模型验证 — 多维度渠道鉴别与供应商验证

![模型验证](public/screenshots/modelValidate.png)

---

## 核心功能

### 🔀 网关代理

- 单一入口代理 Claude Code / Codex / Gemini CLI 请求
- 首页每个 CLI 独立代理开关，一键启停
- 自定义模型名称映射
- SSE / JSON 响应自动修复

### 🛡️ 智能路由与容错

- 多供应商优先级排序 + 自动故障转移
- 熔断器模式（可配置阈值与恢复时间）
- Sticky Session 保持会话粘滞
- 排序模板：多套供应商组合，三个 CLI 各自激活
- 模板内拖拽排序、独立 enabled 开关、切换即时生效

### 📊 用量与可观测

- Token 用量统计（按 CLI / 供应商 / 模型维度）
- 花费估算 + 模型价格自动同步
- 请求 Trace 与实时控制台日志
- 请求热力图（按时段分布）
- 缓存走势图：分供应商命中率折线，60% 预警线
- 可用率：供应商时间线点阵，15s 自动刷新

### 🗂️ 工作区管理

- 按项目隔离 Prompts、MCP、Skill 配置
- 工作区对比、克隆、切换与回滚
- 配置自动同步到各 CLI

### 🧩 Skill 市场

- 从 Git 仓库发现并安装 Skill
- 仓库管理、过滤、排序
- 关联工作区批量管理

### 🔌 插件系统

- 官方内置插件：Privacy Filter
- Extension Host 插件：命令、Provider 扩展值、网关 hook、协议桥骨架、宿主渲染 UI
- 插件权限、配置 schema、审计日志、启用 / 禁用 / 卸载
- SDK 与脚手架：`@aio-coding-hub/plugin-sdk`、`create-aio-plugin`

插件作者应从 [插件开发手册](docs/plugins/README.md) 开始。社区插件统一使用 Extension Host；旧的预发布规则 / WASM / 进程运行时只作为不支持的迁移历史处理。

### 🖥️ CLI 管理

- Claude Code 设置直接编辑
- Codex config.toml 代码编辑器
- 环境变量冲突检测
- 本地 Session 历史浏览（项目 → 会话 → 消息）

### ✅ 模型验证

- 多维度验证模板（Token 截断、Extended Thinking 等）
- 跨供应商签名验证
- 批量验证 + 历史记录

### ⚙️ 其他

- 更新通道兼容接口、开机自启、单实例
- 数据导入 / 导出 / 清空
- WSL 环境支持

---

## 安装

当前仓库处于全量 Rust/egui 重构的源码阶段。重构完成并通过兼容性验收前，不发布官方安装包、Homebrew Cask 或自动更新通道。

### 从源码构建

<details>
<summary>前置条件</summary>

**通用要求：** Node.js 22.12+、pnpm、Rust 1.90+

**Windows：** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选“使用 C++ 的桌面开发”）

**macOS：** `xcode-select --install`

**Linux (Ubuntu/Debian)：**

```bash
sudo apt-get update
sudo apt-get install -y libasound2-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

</details>

```bash
git clone https://github.com/zsr131550/aio-coding-hub-rust.git
cd aio-coding-hub-rust
pnpm install

# 开发模式
pnpm tauri:dev

# 构建当前平台
pnpm tauri:build
```

<!-- SUPPORT_MATRIX_SOURCE_BUILD:START -->
| 分类 | 命令 | 说明 |
| --- | --- | --- |
| 源码支持 | `pnpm tauri:build:win:x64` | Windows x64；源码构建支持；重构完成前不发布正式二进制或更新 |
| 源码支持 | `pnpm tauri:build:mac:x64` | macOS Intel；源码构建支持；重构完成前不发布正式二进制或更新 |
| 源码支持 | `pnpm tauri:build:mac:arm64` | macOS Apple Silicon；源码构建支持；重构完成前不发布正式二进制或更新 |
| 源码支持 | `pnpm tauri:build:linux:x64` | Linux x64；源码构建支持；重构完成前不发布正式二进制或更新 |
| 实验性 | `pnpm tauri:build:mac:universal` | macOS Universal；实验性源码构建；重构完成前不发布正式二进制或更新 |
| 实验性 | `pnpm tauri:build:win:arm64` | Windows ARM64；实验性源码构建；重构完成前不发布正式二进制或更新 |
<!-- SUPPORT_MATRIX_SOURCE_BUILD:END -->

以上命令仅用于本地源码验证；它们不会创建 GitHub Release、更新清单或已签名安装包。

---

## 快速开始

1. **添加供应商** — 打开「供应商」页，添加上游（官方 API / 自建代理 / 公司网关）
2. **打开代理** — 首页打开目标 CLI 的「代理」开关，请求即经由本机网关转发
3. **照常使用 CLI** — 在终端正常使用 Claude Code / Codex / Gemini CLI
4. **查看统计** — 在控制台 / 用量页查看 Trace、Token 用量与花费

验证网关运行：

```bash
curl http://127.0.0.1:37123/health
# {"status":"ok"}
```

---

## 工作原理

```
 Claude Code ──┐
 Codex        ─┼──▶  AIO Coding Hub 网关 (127.0.0.1:37123)  ──▶  供应商 A（优先级 1）
 Gemini CLI  ──┘     排序模板 · 熔断器 · Failover · 用量计量      ├▶  供应商 B（优先级 2）
                                                                └▶  供应商 C（优先级 3）
```

三个 CLI 的请求统一进入本机网关；网关按当前激活的排序模板选择供应商，失败时自动熔断并切换到下一个，同时记录 Trace、Token 用量与花费。

---

## FAQ

**为什么没有安装包或自动更新？**

项目正在进行全量 Rust/egui 重构。兼容性验收完成前只维护源码构建，不创建 Release、签名安装包或更新清单。

**网关端口是多少？如何确认网关在运行？**

默认监听 `127.0.0.1:37123`。执行 `curl http://127.0.0.1:37123/health`，返回 `{"status":"ok"}` 即正常。

**我的 API Key 和请求数据会上传吗？**

不会。网关只监听本机回环地址，所有配置与统计数据保存在本地 SQLite 数据库中。

**Linux Wayland 下白屏或启动崩溃？**

当前源码基线会自动设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1`。如仍异常，请先检查系统 WebKitGTK/EGL 依赖；`scripts/repack-linux-appimage-wayland.sh` 仅用于本地构建的 AppImage。

**哪些平台有自动更新？**

当前没有平台接入自动更新。更新接口会保持兼容但明确返回“通道未启用”，待全量 Rust 重构完成后再独立设计发布通道。

---

## 插件开发文档

插件系统面向社区扩展，社区插件统一使用 Extension Host。开发入口：

- [插件开发总览](docs/plugins/README.md)
- [插件开发总指南](docs/plugins/developer-guide.md)
- [Plugin SDK](docs/plugins/reference/sdk.md)
- [官方示例插件](docs/plugins/examples/privacy-filter.md)
- [插件 API 参考](docs/plugins/reference/README.md)
- [Manifest v1 规范](docs/plugin-manifest-v1.md)

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 19 · TypeScript · Tailwind CSS · Vite |
| **状态管理** | TanStack Query · React Hooks |
| **桌面框架** | Tauri 2 |
| **后端** | Rust · Axum (HTTP Gateway) |
| **数据库** | SQLite (rusqlite) |
| **测试** | Vitest · Testing Library · MSW · Cargo Test |

---

## 参与贡献

欢迎提交 Issue 和 PR！采用 [Conventional Commits](https://www.conventionalcommits.org/) 规范。

```bash
feat(ui): add usage heatmap
fix(gateway): handle timeout correctly
docs: update installation guide
```

提交 PR 前请本地跑一遍检查：

```bash
pnpm check:precommit       # 快速预提交检查（前端 + Rust check）
pnpm check:precommit:full  # 完整检查（格式 + clippy）
pnpm check:prepush         # 覆盖率 + 后端测试 + clippy
pnpm test:unit             # 前端单元测试
pnpm tauri:test            # 后端测试
```

---

## 致谢

本项目借鉴了以下优秀开源项目：

- [cc-switch](https://github.com/farion1231/cc-switch)
- [claude-code-hub](https://github.com/ding113/claude-code-hub)
- [code-switch-R](https://github.com/Rogers-F/code-switch-R)

---

## 许可证

[MIT License](LICENSE)
