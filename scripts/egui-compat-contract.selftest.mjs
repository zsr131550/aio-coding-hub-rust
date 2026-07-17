import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function writeJson(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runContract(args) {
  return spawnSync("node", ["scripts/egui-compat-contract.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "aio-egui-contract-"));
const outsideRoot = mkdtempSync(join(tmpdir(), "aio-egui-contract-outside-"));
try {
  const rustContractPath = join(root, "rust-contract.json");
  const supportMatrixPath = join(root, "support-matrix.json");
  const outputPath = join(root, "compatibility-contract.json");
  const fixtureManifestRelativePath = "src-tauri/tests/fixtures/egui-migration/manifest.json";
  const transcriptRelativePath =
    "src-tauri/tests/fixtures/egui-migration/plugins/transcripts/valid-lifecycle.jsonl";
  const updaterRelativePath = "src-tauri/tests/fixtures/egui-migration/updater/valid/latest.json";
  const transcriptBytes = '{"jsonrpc":"2.0","method":"extension.handshake"}\n';
  const updaterBytes = `${JSON.stringify({ version: "1.2.3", platforms: {} }, null, 2)}\n`;

  writeJson(root, "package.json", { version: "1.2.3" });
  writeJson(root, "src-tauri/tauri.conf.json", {
    productName: "Fixture App",
    version: "1.2.3",
    identifier: "io.fixture.app",
    bundle: {},
    plugins: {},
  });
  writeJson(root, "src/app/app-routes.contract.json", {
    schemaVersion: 1,
    routes: [
      { id: "home", kind: "index", path: "/", samplePath: "/" },
      {
        id: "fallback",
        kind: "fallback",
        path: "*",
        samplePath: "/missing",
        redirectTo: "/",
      },
    ],
    globalSurfaces: ["app-layout"],
  });
  writeJson(root, "docs/plugins/plugin-api-v1-contract.json", {
    apiVersion: "1.0.0",
    runtimes: { extensionHost: { language: "typescript" } },
    uiContributionSlots: ["active.slot", "reserved.slot"],
    activeUiContributionSlots: ["active.slot"],
    manifestOnlyUiContributionSlots: ["reserved.slot"],
  });
  writeFileSync(join(root, "bindings.ts"), "export const commands = {};\n", "utf8");
  writeJson(root, "fixtures/status.json", {
    running: true,
    port: 37123,
    base_url: "http://127.0.0.1:37123",
    listen_addr: "127.0.0.1:37123",
  });
  writeJson(root, fixtureManifestRelativePath, {
    schemaVersion: 1,
    artifacts: {
      "plugins/transcripts/valid-lifecycle.jsonl": {
        kind: "jsonl",
        sha256: createHash("sha256").update(transcriptBytes).digest("hex"),
      },
      "updater/valid/latest.json": {
        kind: "file",
        sha256: createHash("sha256").update(updaterBytes).digest("hex"),
      },
    },
  });
  mkdirSync(dirname(join(root, transcriptRelativePath)), { recursive: true });
  writeFileSync(join(root, transcriptRelativePath), transcriptBytes, "utf8");
  mkdirSync(dirname(join(root, updaterRelativePath)), { recursive: true });
  writeFileSync(join(root, updaterRelativePath), updaterBytes, "utf8");

  writeJson(root, "rust-contract.json", {
    schemaVersion: 1,
    ipc: {
      generatedCommands: Array.from({ length: 195 }, (_, index) => `command_${index + 1}`),
      runtimeOnlyCommands: [
        {
          name: "desktop_updater_download_and_install",
          reason: "fixture runtime-only command",
        },
      ],
      runtimeCommandCount: 196,
      bindingsPath: "bindings.ts",
      riskyOperations: Array.from({ length: 6 }, (_, index) => ({
        command: `command_${index + 1}`,
        action: `action_${index + 1}`,
        resourceTemplate: `{resource_${index + 1}}`,
      })),
      confirmErrorCodes: Array.from({ length: 7 }, (_, index) => `SEC_CONFIRM_${index + 1}`),
      confirmLimits: {
        maxTtlMs: 300000,
        maxFutureSkewMs: 30000,
        minNonceLen: 16,
        maxNonceLen: 128,
      },
    },
    events: [
      {
        id: "gateway-status",
        name: "gateway:status",
        payloadType: "GatewayStatus",
        fixturePath: "fixtures/status.json",
        delivery: "snapshot",
        resyncCommand: "gateway_status",
      },
    ],
    data: {
      dotdirName: ".fixture-app",
      databaseFileName: "fixture.db",
      settingsFileName: "settings.json",
      sqlite: { minimum: 25, current: 35, maximumCompatible: 35 },
      settingsSchemaVersion: 34,
      configBundleSchemaVersions: [1, 2],
    },
    extensionHost: {
      workerArgument: "--extension-host-worker",
      runtime: "rquickjs",
      transport: "json-rpc-2.0-jsonl-stdio",
      workerVersion: 1,
      methods: ["extension.handshake"],
      notifications: ["extension.ready", "host.call"],
    },
    artifactPaths: [fixtureManifestRelativePath, transcriptRelativePath, updaterRelativePath],
  });
  writeJson(root, "support-matrix.json", {
    schemaVersion: 1,
    officialTargets: Array.from({ length: 4 }, (_, index) => ({
      id: `target-${index + 1}`,
      target: `triple-${index + 1}`,
      updaterPlatform: `platform-${index + 1}`,
      latestAssetName: `asset-${index + 1}`,
      latestSignatureName: `asset-${index + 1}.sig`,
    })),
  });

  const args = [
    "--root",
    root,
    "--rust-json",
    rustContractPath,
    "--support-matrix-json",
    supportMatrixPath,
    "--output",
    outputPath,
    "--write",
  ];
  const first = runContract(args);
  assert(first.status === 0, `first generation failed:\n${first.stderr || first.stdout}`);
  const firstBytes = readFileSync(outputPath, "utf8");
  const contract = JSON.parse(firstBytes);
  assert(contract.ipc.generatedCommandCount === 195, "generated command count was not exported");
  assert(contract.ipc.runtimeCommandCount === 196, "runtime command total was not exported");
  assert(contract.ipc.riskyOperations.length === 6, "risky operation matrix was incomplete");
  assert(contract.events.length === 1, "event fixture mapping was not exported");
  assert(contract.release.officialTargets.length === 4, "release matrix was incomplete");
  assert(contract.release.publicationMode === "source-only", "publication mode was not disabled");
  assert(contract.release.updaterMode === "disabled", "updater mode was not disabled");
  assert(contract.release.updaterEndpoint === null, "disabled updater exported an endpoint");
  assert(contract.release.updaterPublicKeySha256 === null, "disabled updater exported trust data");
  assert(contract.artifactHashes["bindings.ts"], "bindings hash was missing");
  assert(contract.artifactHashes["fixtures/status.json"], "event fixture hash was missing");
  assert(
    contract.artifactHashes[fixtureManifestRelativePath] ===
      createHash("sha256")
        .update(readFileSync(join(root, fixtureManifestRelativePath)))
        .digest("hex"),
    "fixture manifest hash was missing or incorrect"
  );
  assert(
    contract.artifactHashes[transcriptRelativePath] ===
      createHash("sha256").update(transcriptBytes).digest("hex"),
    "Extension Host transcript hash was missing or incorrect"
  );
  assert(
    contract.artifactHashes[updaterRelativePath] ===
      createHash("sha256").update(updaterBytes).digest("hex"),
    "updater manifest hash was missing or incorrect"
  );

  const second = runContract(args);
  assert(second.status === 0, `second generation failed:\n${second.stderr || second.stdout}`);
  assert(readFileSync(outputPath, "utf8") === firstBytes, "generation was not byte deterministic");

  writeJson(root, "src-tauri/tauri.conf.json", {
    productName: "Fixture App",
    version: "1.2.3",
    identifier: "io.fixture.app",
    bundle: {},
    plugins: { updater: { endpoints: ["https://fixture.invalid/latest.json"] } },
  });
  const updaterEndpointEnabled = runContract(args.slice(0, -1));
  assert(updaterEndpointEnabled.status !== 0, "contract accepted a configured updater endpoint");
  assert(
    updaterEndpointEnabled.stderr.includes("updater endpoints must be absent"),
    "configured updater endpoint failure did not explain the disabled boundary"
  );
  writeJson(root, "src-tauri/tauri.conf.json", {
    productName: "Fixture App",
    version: "1.2.3",
    identifier: "io.fixture.app",
    bundle: { createUpdaterArtifacts: "v1Compatible" },
    plugins: {},
  });
  const updaterArtifactsEnabled = runContract(args.slice(0, -1));
  assert(
    updaterArtifactsEnabled.status !== 0,
    "contract accepted string updater artifact generation"
  );
  assert(
    updaterArtifactsEnabled.stderr.includes("updater artifact generation must be absent"),
    "updater artifact failure did not explain the source-only boundary"
  );
  writeJson(root, "src-tauri/tauri.conf.json", {
    productName: "Fixture App",
    version: "1.2.3",
    identifier: "io.fixture.app",
    bundle: {},
    plugins: {},
  });

  writeFileSync(join(root, transcriptRelativePath), `${transcriptBytes} `, "utf8");
  const artifactDrift = runContract(args.slice(0, -1));
  assert(artifactDrift.status !== 0, "default check accepted a drifted transcript fixture");
  assert(
    artifactDrift.stderr.includes("drift"),
    "transcript drift failure did not explain the mismatch"
  );
  writeFileSync(join(root, transcriptRelativePath), transcriptBytes, "utf8");

  rmSync(join(root, updaterRelativePath));
  const missingArtifact = runContract(args.slice(0, -1));
  assert(missingArtifact.status !== 0, "default check accepted a missing updater fixture");
  assert(
    missingArtifact.stderr.includes(`contract artifact does not exist: ${updaterRelativePath}`),
    "missing updater fixture failure did not identify the artifact"
  );
  writeFileSync(join(root, updaterRelativePath), updaterBytes, "utf8");

  writeFileSync(outputPath, "{}\n", "utf8");
  const drift = runContract(args.slice(0, -1));
  assert(drift.status !== 0, "default check accepted a drifted snapshot");
  assert(drift.stderr.includes("drift"), "drift failure did not explain the mismatch");

  const outputLink = join(root, "escaped-output");
  symlinkSync(outsideRoot, outputLink, process.platform === "win32" ? "junction" : "dir");
  const outsideEntriesBefore = readdirSync(outsideRoot).sort();
  const escapedOutput = join(outputLink, "compatibility-contract.json");
  const escaped = runContract([
    "--root",
    root,
    "--rust-json",
    rustContractPath,
    "--support-matrix-json",
    supportMatrixPath,
    "--output",
    escapedOutput,
    "--write",
  ]);
  assert(
    JSON.stringify(readdirSync(outsideRoot).sort()) === JSON.stringify(outsideEntriesBefore),
    "contract write escaped through a symlink or junction"
  );
  assert(escaped.status !== 0, "contract write accepted an escaped output path");
  assert(
    /output path escapes contract root/.test(escaped.stderr),
    "escaped output failure did not explain the root boundary"
  );

  console.log("egui compatibility contract self-test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}
