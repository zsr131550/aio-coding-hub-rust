# Baseline result registry

Each JSON file in this directory is an immutable output from `pnpm baseline:tauri` for one shell, operating system, architecture, app version, and scenario. Never hand-edit measurements or combine raw values from different machines.

The runner does not write here directly. Complete every scenario in the gitignored
`.local/egui-baselines/` staging directory, then promote the unchanged matrix together. Adding the
first versioned result changes the worktree and intentionally prevents further runs from claiming
the same release-build provenance.

Only schema-valid files with `status: "complete"` and the filename convention below are registry
entries. A `status: "diagnostic"` file preserves failed-run evidence under `.local` but must not be
promoted. A sibling
`*.json.inprogress` file means the runner did not finish its publication lifecycle and is never a
result. Do not commit or rename it to `.json`. The marker prevents another run from reusing the
same output path until its PID is confirmed stopped and the diagnostic evidence is moved outside
this directory or explicitly removed. Rarely, an interruption after atomic publication but before
marker cleanup can leave both files; validate the immutable JSON before removing the stale marker.

## Current status

| Shell/platform | Status |
| --- | --- |
| Tauri / Windows x86_64 | Pending current-machine formal runs |
| Tauri / macOS x86_64 and arm64 | Pending real platform runner |
| Tauri / Linux x86_64 | Pending real platform runner |
| egui candidate | Pending C3 implementation |

Filename convention:

```text
{shell}-{platform}-{arch}-{scenario}-{appVersion}.json
```

The protocol and exact replay commands are defined in `../baseline-protocol.md` and `../README.md`.
