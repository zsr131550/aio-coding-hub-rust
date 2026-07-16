# egui migration fixtures

Versioned synthetic inputs for compatibility and Tauri baseline checks. All mutable tests must copy these files into a runner-owned temporary home. The SQLite v25 database was generated from commit `5e399f7c25c33a13f3e91d8a05a9973270d00728` (blob `6dce028754f13dec607e108b7a9e04da82e4d0f7`) with its complete v0-to-v25 migration chain.

Run `pnpm check:egui-fixtures` for byte/hash validation and a full-tree scan for credentials, private keys, and absolute personal paths. Regeneration is explicit and never reads or writes the real application data directory.
