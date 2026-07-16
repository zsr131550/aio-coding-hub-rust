import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIsolatedProcessEnvironment, createRunWorkspace } from "./workspace.mjs";

const isolatedHome = path.resolve(os.tmpdir(), "aio-egui-workspace-selftest", "home");
const realHome = path.resolve(os.tmpdir(), "aio-egui-real-home-sentinel");
const env = buildIsolatedProcessEnvironment(
  isolatedHome,
  {
    PATH: "fixture-path",
    HOME: realHome,
    USERPROFILE: realHome,
    AIO_DB_POOL_MAX_SIZE: "99",
    AIO_CODING_HUB_DOTDIR_NAME: ".real-user-data",
    AIO_OAUTH_PROXY_URL: "http://user:secret@127.0.0.1:9000",
    HTTP_PROXY: "http://127.0.0.1:9001",
    HTTPS_PROXY: "http://127.0.0.1:9002",
    ALL_PROXY: "socks5://127.0.0.1:9003",
    RUST_LOG: "trace",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TZ: "Asia/Shanghai",
  },
  realHome
);

assert.equal(env.PATH, "fixture-path");
assert.equal(env.AIO_CODING_HUB_BENCHMARK_REAL_HOME, realHome);
assert.equal(env.HOME, isolatedHome);
assert.equal(env.USERPROFILE, isolatedHome);
assert.equal(env.APPDATA, path.join(isolatedHome, "AppData", "Roaming"));
assert.equal(env.LOCALAPPDATA, path.join(isolatedHome, "AppData", "Local"));
assert.equal(env.XDG_CONFIG_HOME, path.join(isolatedHome, ".config"));
assert.equal(env.XDG_DATA_HOME, path.join(isolatedHome, ".local", "share"));
assert.equal(env.XDG_CACHE_HOME, path.join(isolatedHome, ".cache"));
assert.equal(env.TEMP, path.join(isolatedHome, "tmp"));
assert.equal(env.TMP, env.TEMP);
assert.equal(env.TMPDIR, env.TEMP);
assert.equal(env.AIO_DB_POOL_MAX_SIZE, undefined);
assert.equal(env.AIO_CODING_HUB_DOTDIR_NAME, undefined);
assert.equal(env.AIO_OAUTH_PROXY_URL, undefined);
assert.equal(env.HTTP_PROXY, undefined);
assert.equal(env.HTTPS_PROXY, undefined);
assert.equal(env.ALL_PROXY, undefined);
assert.equal(env.RUST_LOG, undefined);
assert.equal(env.LANG, "C.UTF-8");
assert.equal(env.LC_ALL, "C.UTF-8");
assert.equal(env.TZ, "UTC");
assert.throws(() => buildIsolatedProcessEnvironment(realHome, {}, realHome), /real user home/);

const root = await mkdtemp(path.join(os.tmpdir(), "aio-egui-workspace-selftest-"));
try {
  const workspace = await createRunWorkspace({
    root,
    runId: "isolated-webview",
    fixture: "fresh",
    scenario: "first-interactive",
  });
  assert.equal(workspace.webviewData, path.join(workspace.home, ".aio-benchmark", "webview"));
  assert.equal((await stat(workspace.webviewData)).isDirectory(), true);

  const logsWorkspace = await createRunWorkspace({
    root,
    runId: "isolated-logs",
    fixture: "current",
    scenario: "logs-10k",
  });
  assert.ok(logsWorkspace.requestLogs.path.startsWith(logsWorkspace.home));
  assert.equal(logsWorkspace.requestLogs.rowCount, 10_000);
  assert.equal(
    logsWorkspace.fixtureArtifacts["request-logs-10000.jsonl"].sha256,
    logsWorkspace.requestLogs.sha256
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("egui baseline workspace self-test passed");
