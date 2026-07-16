# Tauri and egui comparison protocol

## Formal run rules

1. Use a production release binary from the commit being measured. Dev-server and debug-build measurements are non-formal.
2. Use only the committed synthetic fixtures copied into a runner-owned temporary home. Never point the runner at the real `.aio-coding-hub`, CLI credentials, or plugin directory.
3. Run two warmups followed by at least ten measured processes for every scenario.
4. Preserve every raw milestone and process sample. Aggregate each metric with midpoint median and nearest-rank P95; do not discard failed runs.
5. Compare shells on the same commit, machine, power mode, display scale, window size, fixture, and scenario order. Report other operating systems separately.
6. A published JSON is either `status: "complete"` or `status: "diagnostic"`, derived from its raw runs. Only a schema-valid `complete` result is a promotable baseline; diagnostics retain failures but cannot enter the registry. A sibling `.json.inprogress` file is interruption evidence, never a result.
7. Write the complete scenario matrix under `.local/egui-baselines/`. Promote the unchanged files into the versioned registry only after every scenario finishes; promotion invalidates the build manifest for further runs.

Before launching the first warmup, the runner exclusively creates `<output>.inprogress` and
fsyncs its diagnostic metadata. The marker records a random ownership ID, start time, PID,
scenario, fixture, and run counts, but not absolute executable or user-directory paths. An
existing output or marker makes the command stop before it launches the application.

After all runs finish, the runner validates and fsyncs the complete result in a sibling
temporary file, atomically publishes it without replacing an existing output, and removes only
the marker whose ownership ID it created. A thrown error, terminated Node process, or machine
restart leaves the marker in place. Do not rename that marker to `.json`. Confirm that its PID is
no longer running, preserve it outside the baseline registry when diagnostics are needed, and
only then remove it before retrying the same output path. A valid output and marker can coexist
only if interruption happened after atomic publication but before cleanup; validate the output
with `validateBaselineResult` before treating the marker as stale.

`startup-cold-process` creates a fresh fixture copy per process. It does not claim to evict the operating-system page cache. `startup-warm-process` reuses one isolated fixture home across restarts.

`hidden-tray` starts from the same committed current settings fixture, then sets
`start_minimized=true` only in its runner-owned copy. Its persisted `settings.json` SHA-256 is
therefore expected to differ from the other scenarios and must not be rewritten to look equal.
Matrix validation still requires one database/build/machine/protocol identity and requires the
canonical settings SHA-256 to match across every non-hidden scenario; only the validated
`hidden-tray` overlay is exempt from that cross-scenario settings comparison.

## Scenarios

| Scenario | Fixture | Completion boundary | Primary metrics |
| --- | --- | --- | --- |
| `startup-cold-process` | `current` | first interactive frame | setup, DB, gateway, ready, interactive |
| `startup-warm-process` | `current` | first interactive frame | same metrics with one reused isolated home |
| `first-interactive` | `current` | two `requestAnimationFrame` callbacks after startup `ready` | process-entry to interactive |
| `visible-idle` | `current` | 60,000 ms after startup `ready` | process-tree working set/private bytes and CPU delta |
| `hidden-tray` | `current` | 600,000 ms after startup `ready` | hidden process-tree memory and CPU delta |
| `logs-10k` | `current` plus JSONL | load, filter `RATE_LIMITED`, select first result, each followed by two animation frames | raw load/filter/select duration |
| `gateway-load` | `current` | counterbalanced fixed idle and active-UI phases | throughput, TTFB, streaming inter-event latency |

The `visible-idle` and `hidden-tray` timers start directly from backend `startup_ready` and use a monotonic Rust/Tokio deadline. They do not depend on JavaScript timers or animation frames that a WebView may throttle or suspend. The frontend still records `first_interactive` for visible scenarios, but only the native timer writes `scenario_completed` for these two idle scenarios.

## Milestones

The release process writes schema-v1 JSONL only when all benchmark isolation variables validate. Required startup milestones are:

```text
process_entry
tauri_setup_started
tauri_setup_completed
startup_run_started
db_ready
settings_ready
window_visible | window_hidden
gateway_bound
gateway_ready
startup_ready
first_interactive (except hidden-tray)
scenario_completed
shutdown_started
shutdown_completed
```

Rows contain a strictly increasing sequence, monotonic elapsed milliseconds, wall-clock metadata, run ID, scenario, and bounded structured data. Missing or malformed rows make the run fail. Without benchmark configuration the reporter creates no file, port, window, writer thread, or sustained task.

The renderer bridge is a private inlined Tauri plugin. `main-core` grants only
`benchmark:allow-commands`, whose permission allows exactly `record`, `request_logs`,
`run_gateway_load`, and `finish`. The plugin handler is registered only after the
benchmark environment has initialized a validated reporter, so a normal release process has
no `plugin:benchmark` handler. `tauri_build` validates this permission and embeds the same ACL
in release builds; adding a command requires an explicit permission, capability, Rust handler,
and TypeScript adapter contract update.

## 10k UI action

The input is `request-logs-10000.jsonl`, validated by exact SHA-256 and row count in Rust and validated again as `RequestLogSummary[]` in the frontend. The benchmark-only scene is not registered as a product route.

Each action records `performance.now()` immediately before the state update and records the duration after two animation-frame callbacks. This is an input-to-next-painted-frame approximation, not GPU presentation telemetry. C3 must use the same dataset, filter string, selected row, and next-frame definition.

## Gateway load

The runner starts a new HTTP server on an ephemeral `127.0.0.1` port for each application process. The Rust benchmark command rejects non-HTTP, non-loopback, credential-bearing, path-bearing, or implicit-port upstream URLs. Requests enter the running application gateway through:

```text
POST /codex/_aio/provider/{synthetic_provider_id}/v1/chat/completions
```

This exercises the real provider lookup, API-key injection, proxy, response, streaming, and request-log path. `/health` is used only to prove gateway readiness and is never reported as gateway throughput.
The loopback stub accepts a request only when the production Codex adapter has replaced the incoming
headers with the fixed synthetic `Bearer` credential. Formal raw runs retain the authenticated request
count; a missing or rejected credential fails the run.

Each `idle` and `active` phase uses the same protocol:

- 24 non-stream requests, concurrency 4, fixed request and JSON response.
- Throughput is 24 divided by wall time from the first batch start through the final response body.
- Non-stream TTFB is request start to response headers for every request.
- 4 streaming requests with 5 SSE data events and a `[DONE]` event.
- The stub waits 20 ms between fixed data events and before `[DONE]`.
- Stream TTFB is request start to the first complete SSE event. Every interval between complete SSE events remains in the raw `streamInterEventMs` array.
- Transport chunk boundaries may merge or split SSE events. Their counts remain only in `observedStreamTransportChunks` diagnostics and are not timing metrics.
- The stub records monotonic write offsets for all 5 data events plus `[DONE]` and the deviation of each interval from the fixed 20 ms schedule. These are stimulus diagnostics, not application latency metrics.
- During `active`, React commits a small benchmark-only frame indicator on every animation frame; its frame count is recorded.

Phase order is counterbalanced from the runner-generated numeric `runId` suffix. Odd-numbered
runs (`...-01`, `...-03`) execute `idle` then `active`; even-numbered runs (`...-02`,
`...-04`) execute `active` then `idle`. A manually constructed run ID without a numeric suffix
falls back to idle-first. The animation-frame indicator starts immediately before an `active`
phase and stops immediately after that phase, regardless of which phase runs first.

The condition-specific `gateway_load_{condition}_{started|completed}` milestones preserve the
actual execution order. The existing UI summary schema remains stable:
`gateway_load_ready` contains the idle result, while `gateway_load_completed` contains the active
result and `activeFrameCount`; both are recorded only after the two phases have succeeded.

Every streaming response must parse to exactly 5 JSON data events followed by one `[DONE]` event, regardless of transport chunking. The runner expects exactly 56 accepted stub requests per application run and zero rejected requests. Stub mismatch, timeout, malformed response, wrong event count, or missing `[DONE]` fails the run. The stub is closed in a `finally` boundary even when the application fails.

## Process tree and environment

Processes are identified by PID, creation/birth token, and image name. A descendant remains attributable after reparenting, while PID reuse is rejected. Cleanup re-reads identities and terminates only the proven tree, never by executable name.

Every sample contains each attributed process and totals for available working set, private bytes, CPU time, and count. Unavailable counters remain `null`, never zero. `environment.processMetrics` records the exact collector, identity precision, counter source, availability, and semantics used by that platform; the result validator rejects metadata that contradicts the declared platform.

- Windows uses `Win32_Process`: `CreationDate` is the exact birth token, `WorkingSetSize` is resident working set, `PrivatePageCount` is private committed memory, and kernel plus user time is cumulative CPU time.
- Linux uses identity-bracketed procfs reads. `/proc/<pid>/stat` fields `starttime`, `utime`, and `stime` provide the exact birth token and cumulative CPU ticks; `getconf CLK_TCK` supplies the conversion factor. `/proc/<pid>/status` supplies `VmRSS` and `RssAnon`. A second `stat` read must retain the same PID and `starttime`, otherwise the sample is coarse and cannot contribute a trusted CPU delta. `RssAnon` is resident anonymous memory, not a cross-platform synonym for Windows private committed memory.
- macOS uses portable `ps` `rss`, `time`, and `lstart` fields. `lstart` is only a coarse birth token and portable `ps` exposes no reliable private-byte counter, so `privateBytes` remains `null` and identity-safe CPU delta is unavailable. A macOS idle result may preserve structured failed-run diagnostics, but it cannot validate as a successful `visible-idle` or `hidden-tray` baseline until a native exact-identity/private-memory collector is added.

Successful idle runs require finite working-set peak/median, private bytes, identity-safe cumulative CPU delta, and process count. Missing required counters produce `PROCESS_METRIC_UNAVAILABLE`; they are never omitted from a nominally successful run. Platform-native private-memory values must only be compared within the same OS/collector semantics.

Results also record release-binary hash/size, commit/dirty state, OS, architecture, CPU, memory, sampling cadence, raw runs, warnings, failures, and pending platforms.

WebView runtime, GPU renderer, and power metadata may remain `null` when no reliable non-invasive collector is available. That absence must be reported, not guessed.
