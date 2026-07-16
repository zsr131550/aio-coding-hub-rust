import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checker = resolve(scriptDir, "check-headless-core-boundary.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "aio-headless-boundary-"));
const tauriRoot = join(fixtureRoot, "src-tauri");

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
    `[workspace]\nmembers = [\n  "crates/aio-contract",\n  "crates/aio-core",\n  "crates/fixtures/*",\n]\nresolver = "2"\n`
  );
  write(
    join(tauriRoot, "crates", "aio-contract", "Cargo.toml"),
    `[package]\nname = "aio-contract"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n`
  );
  write(join(tauriRoot, "crates", "aio-contract", "src", "lib.rs"), "pub struct Contract;\n");
  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\n`
  );
  write(join(tauriRoot, "crates", "aio-core", "src", "lib.rs"), "pub struct Core;\n");

  writeFixturePackage("tauri", "pub struct AppHandle;\n");
  writeFixturePackage("tauri-plugin-dialog", "pub struct Dialog;\n");
  writeFixturePackage("egui", "pub struct Context;\n");
  writeFixturePackage("eframe", "pub struct Frame;\n");
  writeFixturePackage("winit", "pub mod window { pub struct Window; }\n");

  assertSuccess(run("cargo", ["generate-lockfile"], tauriRoot), "fixture lock generation");
  assertSuccess(checkerResult(), "clean boundary fixture");

  write(
    join(tauriRoot, "crates", "aio-core", "Cargo.toml"),
    `[package]\nname = "aio-core"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\naio-contract = { path = "../aio-contract" }\ntauri = { path = "../fixtures/tauri" }\ntauri-plugin-dialog = { path = "../fixtures/tauri-plugin-dialog" }\negui = { path = "../fixtures/egui" }\neframe = { path = "../fixtures/eframe" }\nwinit = { path = "../fixtures/winit" }\n`
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

  console.log("[headless-core-boundary:selftest] clean and prohibited fixtures passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
