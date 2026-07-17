import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checker = join(scriptDirectory, "check-repository-independence.mjs");
const fixtureForeignOwner = "fixture-owner";
const fixtureProductRepository = "aio-coding-hub";
const fixtureForeignWebUrl = `https://github.com/${fixtureForeignOwner}/${fixtureProductRepository}`;
const fixtureForeignSshUrl = `git@github.com:${fixtureForeignOwner}/${fixtureProductRepository}.git`;
let passed = 0;

function write(root, relativePath, contents) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
}

function fixture(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "aio-independent-repository-"));
  write(
    root,
    "README.md",
    [
      "https://github.com/zsr131550/aio-coding-hub-rust",
      "AIO Coding Hub",
      "io.aio.codinghub",
      ".aio-coding-hub",
      "aio-coding-hub.db",
      "@aio-coding-hub/plugin-sdk",
      "",
    ].join("\n")
  );
  write(
    root,
    "src/provider.ts",
    'export const upstreamTimeoutMs = 30_000;\nexport const upstreamUrl = "https://api.example.test";\n'
  );
  write(
    root,
    "src-tauri/Cargo.toml",
    '[package]\nname = "aio-coding-hub"\nversion = "0.60.13"\nauthors = ["zsr131550"]\n'
  );
  write(
    root,
    "src-tauri/tauri.conf.json",
    JSON.stringify({ bundle: {}, plugins: { updater: {} } }, null, 2)
  );
  write(root, ".github/workflows/ci.yml", "name: ci\non: [push]\n");
  write(root, "LICENSE", "MIT License\n\nCopyright (c) 2026 FixtureOwner\n");
  mutate(root);
  assert.equal(run("git", ["init", "-q"], root).status, 0);
  assert.equal(run("git", ["add", "--all"], root).status, 0);
  return root;
}

function checkerResult(root) {
  return run(process.execPath, [checker, "--root", root], root);
}

function test(name, mutate, expectedFailure) {
  const root = fixture(mutate);
  try {
    const result = checkerResult(root);
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (expectedFailure == null) {
      assert.equal(result.status, 0, diagnostic);
    } else {
      assert.notEqual(result.status, 0, `expected ${name} to fail`);
      assert.match(diagnostic, expectedFailure);
    }
    passed += 1;
    console.log(`[repository-independence:selftest] ok - ${name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("allows independent identity, provider upstream terms, and compatibility identifiers");
test(
  "rejects a foreign product repository URL",
  (root) => write(root, "README.md", `${fixtureForeignWebUrl}/releases\n`),
  /product repository URL must target/i
);
test(
  "rejects a foreign product repository SSH URL",
  (root) => write(root, "README.md", `${fixtureForeignSshUrl}\n`),
  /product repository URL must target/i
);
test(
  "rejects a repository synchronization workflow",
  (root) => write(root, ".github/workflows/sync-upstream.yml", "name: Sync project source\n"),
  /forbidden workflow/i
);
test(
  "rejects a workflow source remote or synchronization token",
  (root) =>
    write(
      root,
      ".github/workflows/ci.yml",
      "name: ci\nenv:\n  SYNC_TOKEN: secret\nsteps:\n  - run: git remote add source https://example.test/source.git\n"
    ),
  /source remote|synchronization token/i
);
test(
  "rejects workflow remote redirection and source fetches",
  (root) =>
    write(
      root,
      ".github/workflows/ci.yml",
      "name: ci\nsteps:\n  - run: git remote set-url origin https://example.test/source.git\n  - run: git fetch upstream main\n"
    ),
  /source remote|source repository/i
);
test(
  "rejects a foreign checkout repository shorthand",
  (root) =>
    write(
      root,
      ".github/workflows/ci.yml",
      `name: ci\nsteps:\n  - uses: actions/checkout@0123456789012345678901234567890123456789\n    with:\n      repository: ${fixtureForeignOwner}/${fixtureProductRepository}\n`
    ),
  /product repository URL must target/i
);
test(
  "rejects renamed release publication automation",
  (root) =>
    write(
      root,
      ".github/workflows/publish.yml",
      "name: publish\nsteps:\n  - run: gh release create v1\n"
    ),
  /release or tag publication automation/i
);
test(
  "rejects an action-only publication workflow",
  (root) =>
    write(
      root,
      ".github/workflows/ship.yml",
      "name: ship\npermissions:\n  contents: write\nsteps:\n  - uses: softprops/action-gh-release@0123456789012345678901234567890123456789\n"
    ),
  /only ci\.yml and dev-build\.yml|contents permission|release publication actions/i
);
test(
  "rejects foreign root Cargo authorship",
  (root) =>
    write(
      root,
      "src-tauri/Cargo.toml",
      '[package]\nname = "aio-coding-hub"\nversion = "0.60.13"\nauthors = ["fixture-owner"]\n'
    ),
  /Cargo authors/i
);
test(
  "allows the historical owner only in LICENSE",
  (root) => write(root, "src/comment.ts", "// FixtureOwner\n"),
  /historical owner identity/i
);
test(
  "rejects an updater endpoint",
  (root) =>
    write(
      root,
      "src-tauri/tauri.conf.json",
      JSON.stringify({ plugins: { updater: { endpoints: ["https://updates.example.test"] } } })
    ),
  /updater endpoints/i
);
test(
  "rejects updater trust and artifact generation",
  (root) =>
    write(
      root,
      "src-tauri/tauri.conf.json",
      JSON.stringify({
        bundle: { createUpdaterArtifacts: true },
        plugins: { updater: { pubkey: "key" } },
      })
    ),
  /updater public key|updater artifacts/i
);
test(
  "rejects string updater artifact generation in a platform override",
  (root) =>
    write(
      root,
      "src-tauri/tauri.windows.conf.json",
      JSON.stringify({ bundle: { createUpdaterArtifacts: "v1Compatible" } })
    ),
  /updater artifact generation/i
);

{
  const root = fixture();
  try {
    write(root, "README.md", `${fixtureForeignWebUrl}/releases\n`);
    assert.equal(run("git", ["add", "README.md"], root).status, 0);
    write(root, "README.md", "https://github.com/zsr131550/aio-coding-hub-rust\n");

    const workingTree = checkerResult(root);
    assert.equal(workingTree.status, 0, `${workingTree.stdout}\n${workingTree.stderr}`);
    const staged = run(process.execPath, [checker, "--root", root, "--staged"], root);
    assert.notEqual(staged.status, 0, "staged view accepted a forbidden index entry");
    assert.match(`${staged.stdout}\n${staged.stderr}`, /product repository URL must target/i);
    passed += 1;
    console.log("[repository-independence:selftest] ok - audits staged content independently");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`[repository-independence:selftest] ${passed} tests passed`);
