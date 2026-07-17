import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checker = resolve(scriptDir, "check-headless-core-boundary.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "aio-headless-boundary-"));
const tauriRoot = join(fixtureRoot, "src-tauri");
const platformForbidden = [
  "tauri",
  "tauri-plugin-dialog",
  "egui",
  "eframe",
  "winit",
  "rfd",
  "arboard",
  "tray-icon",
  "notify-rust",
];

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
}

function assertSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

function checkerResult() {
  return run(process.execPath, [checker, "--root", fixtureRoot], fixtureRoot);
}

function writeFixturePackage(name, rustSource) {
  const root = join(tauriRoot, "crates", "fixtures", name);
  write(
    join(root, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );
  write(join(root, "src", "lib.rs"), rustSource);
}

try {
  write(
    join(tauriRoot, "Cargo.toml"),
    `[workspace]\nmembers = [\n  "crates/aio-contract",\n  "crates/aio-core",\n  "crates/aio-platform",\n  "crates/fixtures/*",\n]\nresolver = "2"\n`
  );
  write(
    join(tauriRoot, "crates", "aio-contract", "Cargo.toml"),
    `[package]\nname = "aio-contract"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );
  write(join(tauriRoot, "crates", "aio-contract", "src", "lib.rs"), "pub struct Contract;\n");
  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\naio-platform = { path = "../aio-platform" }\n`
  );
  write(join(tauriRoot, "crates", "aio-core", "src", "lib.rs"), "pub struct Core;\n");
  write(
    join(tauriRoot, "crates", "aio-platform", "Cargo.toml"),
    `[package]\nname = "aio-platform"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );
  write(join(tauriRoot, "crates", "aio-platform", "src", "lib.rs"), "pub struct Platform;\n");
  write(
    join(tauriRoot, "src", "app", "platform", "clipboard.rs"),
    "use tauri_plugin_clipboard_manager::ClipboardExt;\npub fn allowed_adapter() {}\n"
  );

  writeFixturePackage("tauri", "pub struct AppHandle;\n");
  writeFixturePackage("tauri-plugin-dialog", "pub struct Dialog;\n");
  writeFixturePackage("egui", "pub struct Context;\n");
  writeFixturePackage("eframe", "pub struct Frame;\n");
  writeFixturePackage("winit", "pub mod window { pub struct Window; }\n");
  writeFixturePackage("rfd", "pub struct FileDialog;\n");
  writeFixturePackage("arboard", "pub struct Clipboard;\n");
  writeFixturePackage("tray-icon", "pub struct TrayIcon;\n");
  writeFixturePackage("notify-rust", "pub struct Notification;\n");

  assertSuccess(run("cargo", ["generate-lockfile"], tauriRoot), "fixture lock generation");
  assertSuccess(checkerResult(), "clean boundary fixture");

  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\n`
  );
  write(
    join(tauriRoot, "crates", "aio-platform", "Cargo.toml"),
    `[package]\nname = "aio-platform"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-core = { path = "../aio-core" }\n`
  );
  assertSuccess(
    run("cargo", ["generate-lockfile"], tauriRoot),
    "reverse dependency lock generation"
  );
  const reverseDependency = checkerResult();
  if (reverseDependency.status === 0) {
    throw new Error("expected aio-platform to reject a reverse aio-core dependency");
  }
  const reverseDiagnostic = `${reverseDependency.stdout}\n${reverseDependency.stderr}`;
  if (!reverseDiagnostic.includes("aio-platform") || !reverseDiagnostic.includes("aio-core")) {
    throw new Error(`reverse dependency diagnostic was incomplete\n${reverseDiagnostic}`);
  }

  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\naio-platform = { path = "../aio-platform" }\n`
  );
  write(
    join(tauriRoot, "crates", "aio-platform", "Cargo.toml"),
    `[package]\nname = "aio-platform"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );

  for (const dependency of platformForbidden) {
    write(
      join(tauriRoot, "crates", "aio-platform", "Cargo.toml"),
      `[package]\nname = "aio-platform"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\n${dependency} = { path = "../fixtures/${dependency}" }\n`
    );
    assertSuccess(run("cargo", ["generate-lockfile"], tauriRoot), `${dependency} lock generation`);
    const prohibitedDependency = checkerResult();
    if (prohibitedDependency.status === 0) {
      throw new Error(`expected aio-platform to reject ${dependency}`);
    }
    const prohibitedDiagnostic = `${prohibitedDependency.stdout}\n${prohibitedDependency.stderr}`;
    if (
      !prohibitedDiagnostic.includes("aio-platform") ||
      !prohibitedDiagnostic.includes(dependency)
    ) {
      throw new Error(
        `${dependency} diagnostic did not identify aio-platform and the dependency\n${prohibitedDiagnostic}`
      );
    }
  }

  write(
    join(tauriRoot, "crates", "aio-platform", "Cargo.toml"),
    `[package]\nname = "aio-platform"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );

  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\naio-platform = { path = "../aio-platform" }\ntauri = { path = "../fixtures/tauri" }\ntauri-plugin-dialog = { path = "../fixtures/tauri-plugin-dialog" }\negui = { path = "../fixtures/egui" }\neframe = { path = "../fixtures/eframe" }\nwinit = { path = "../fixtures/winit" }\n`
  );
  write(
    join(tauriRoot, "crates", "aio-core", "src", "lib.rs"),
    `use eframe::Frame;\nuse egui::Context;\nuse tauri::AppHandle;\nuse tauri_plugin_dialog::Dialog;\nuse winit::window::Window;\n\npub fn forbidden(_: AppHandle, _: Dialog, _: Context, _: Frame, _: Window) {}\n`
  );
  assertSuccess(run("cargo", ["generate-lockfile"], tauriRoot), "drift lock generation");

  const drift = checkerResult();
  if (drift.status === 0) {
    throw new Error("expected prohibited headless dependencies/imports to fail");
  }
  const diagnostic = `${drift.stdout}\n${drift.stderr}`;
  for (const token of ["aio-core", "tauri", "tauri-plugin-dialog", "egui", "eframe", "winit"]) {
    if (!diagnostic.includes(token)) {
      throw new Error(`boundary diagnostic did not mention ${token}\n${diagnostic}`);
    }
  }

  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\naio-platform = { path = "../aio-platform" }\n`
  );
  write(join(tauriRoot, "crates", "aio-core", "src", "lib.rs"), "pub struct Core;\n");
  write(
    join(tauriRoot, "crates", "aio-platform", "Cargo.toml"),
    `[package]\nname = "aio-platform"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );
  write(join(tauriRoot, "crates", "aio-platform", "src", "lib.rs"), "pub struct Platform;\n");
  write(
    join(tauriRoot, "src", "commands", "desktop.rs"),
    "use tauri_plugin_clipboard_manager::ClipboardExt;\npub fn forbidden_bypass() {}\n"
  );
  assertSuccess(run("cargo", ["generate-lockfile"], tauriRoot), "bypass lock generation");

  const bypass = checkerResult();
  if (bypass.status === 0) {
    throw new Error("expected production capability-plugin bypass to fail");
  }
  const bypassDiagnostic = `${bypass.stdout}\n${bypass.stderr}`;
  for (const token of ["src-tauri/src/commands/desktop.rs", "tauri_plugin_clipboard_manager"]) {
    if (!bypassDiagnostic.includes(token)) {
      throw new Error(`production bypass diagnostic did not mention ${token}\n${bypassDiagnostic}`);
    }
  }

  console.log("[headless-core-boundary:selftest] clean and prohibited fixtures passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
