import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const logger = {
  info(message, ...args) {
    console.error(message, ...args);
  },
  error(message, ...args) {
    console.error(message, ...args);
  },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

/*
 * ============================================================================
 * 步骤1：集中定义支持矩阵
 * ============================================================================
 * 目标：
 *   1) 用一份定义覆盖源码构建、CI 平台和 README 文案
 *   2) 保留冻结的 updater 字段供兼容合同使用，但不生成发布产物
 * 数据源：
 *   1) 当前 package scripts 中存在的跨平台构建命令
 *   2) 当前 CI 验证的桌面平台
 * 操作要点：
 *   1) 桌面平台必须具有明确的源码构建命令与 CI runner
 *   2) 重构完成前不发布正式二进制、updater 清单或 Homebrew Cask
 */
const OFFICIAL_RELEASE_TARGETS = Object.freeze([
  {
    id: "windows-x64",
    osFamily: "windows",
    runner: "windows-latest",
    target: "x86_64-pc-windows-msvc",
    bundles: "msi",
    updaterPlatform: "windows-x86_64",
    stableLabel: "win64",
    stableAssetKind: "msi",
    packageScript: "tauri:build:win:x64",
    packageCommand: "node scripts/tauri-build.mjs --target x86_64-pc-windows-msvc",
    buildLabel: {
      zh: "Windows x64",
      en: "Windows x64",
    },
    sourceBuildNote: {
      zh: "源码构建支持；重构完成前不发布正式二进制或更新",
      en: "Source build supported; no release binaries or updates are published during the rewrite",
    },
    latestAssetName: "aio-coding-hub-win64.msi",
    latestSignatureName: "aio-coding-hub-win64.msi.sig",
  },
  {
    id: "macos-x64",
    osFamily: "macos",
    runner: "macos-latest",
    target: "x86_64-apple-darwin",
    bundles: "app",
    updaterPlatform: "darwin-x86_64",
    stableLabel: "macos-intel",
    stableAssetKind: "tarball",
    packageScript: "tauri:build:mac:x64",
    packageCommand: "node scripts/tauri-build.mjs --target x86_64-apple-darwin",
    buildLabel: {
      zh: "macOS Intel",
      en: "macOS Intel",
    },
    sourceBuildNote: {
      zh: "源码构建支持；重构完成前不发布正式二进制或更新",
      en: "Source build supported; no release binaries or updates are published during the rewrite",
    },
    latestAssetName: "aio-coding-hub-macos-intel.tar.gz",
    latestSignatureName: "aio-coding-hub-macos-intel.tar.gz.sig",
  },
  {
    id: "macos-arm64",
    osFamily: "macos",
    runner: "macos-latest",
    target: "aarch64-apple-darwin",
    bundles: "app",
    updaterPlatform: "darwin-aarch64",
    stableLabel: "macos-arm",
    stableAssetKind: "tarball",
    packageScript: "tauri:build:mac:arm64",
    packageCommand: "node scripts/tauri-build.mjs --target aarch64-apple-darwin",
    buildLabel: {
      zh: "macOS Apple Silicon",
      en: "macOS Apple Silicon",
    },
    sourceBuildNote: {
      zh: "源码构建支持；重构完成前不发布正式二进制或更新",
      en: "Source build supported; no release binaries or updates are published during the rewrite",
    },
    latestAssetName: "aio-coding-hub-macos-arm.tar.gz",
    latestSignatureName: "aio-coding-hub-macos-arm.tar.gz.sig",
  },
  {
    id: "linux-x64",
    osFamily: "linux",
    runner: "ubuntu-22.04",
    target: "x86_64-unknown-linux-gnu",
    bundles: "deb,appimage",
    updaterPlatform: "linux-x86_64",
    stableLabel: "linux-amd64",
    stableAssetKind: "appimage",
    packageScript: "tauri:build:linux:x64",
    packageCommand: "node scripts/tauri-build.mjs --target x86_64-unknown-linux-gnu",
    buildLabel: {
      zh: "Linux x64",
      en: "Linux x64",
    },
    sourceBuildNote: {
      zh: "源码构建支持；重构完成前不发布正式二进制或更新",
      en: "Source build supported; no release binaries or updates are published during the rewrite",
    },
    latestAssetName: "aio-coding-hub-linux-amd64.AppImage",
    latestSignatureName: "aio-coding-hub-linux-amd64.AppImage.sig",
  },
]);

const LOCAL_BUILD_ONLY_TARGETS = Object.freeze([
  {
    id: "macos-universal",
    packageScript: "tauri:build:mac:universal",
    packageCommand: "node scripts/tauri-build.mjs --target universal-apple-darwin",
    buildLabel: {
      zh: "macOS Universal",
      en: "macOS Universal",
    },
    sourceBuildNote: {
      zh: "实验性源码构建；重构完成前不发布正式二进制或更新",
      en: "Experimental source build; no release binaries or updates are published during the rewrite",
    },
  },
  {
    id: "windows-arm64",
    packageScript: "tauri:build:win:arm64",
    packageCommand: "node scripts/tauri-build.mjs --target aarch64-pc-windows-msvc",
    buildLabel: {
      zh: "Windows ARM64",
      en: "Windows ARM64",
    },
    sourceBuildNote: {
      zh: "实验性源码构建；重构完成前不发布正式二进制或更新",
      en: "Experimental source build; no release binaries or updates are published during the rewrite",
    },
  },
]);

const README_MARKERS = Object.freeze({
  sourceBuild: {
    start: "<!-- SUPPORT_MATRIX_SOURCE_BUILD:START -->",
    end: "<!-- SUPPORT_MATRIX_SOURCE_BUILD:END -->",
  },
});

const README_LOCALES = Object.freeze([
  {
    fileName: "README.md",
    locale: "zh",
  },
  {
    fileName: "README_EN.md",
    locale: "en",
  },
]);

const EXPECTED_DESKTOP_OS_FAMILIES = Object.freeze(["windows", "macos", "linux"]);

const WORKFLOW_PATHS = Object.freeze({
  ci: join(repoRoot, ".github/workflows/ci.yml"),
  devBuild: join(repoRoot, ".github/workflows/dev-build.yml"),
});

function getAllBuildTargets() {
  return [
    ...OFFICIAL_RELEASE_TARGETS.map((item) => ({
      packageScript: item.packageScript,
      packageCommand: item.packageCommand,
      buildLabel: item.buildLabel,
      sourceBuildNote: item.sourceBuildNote,
      official: true,
    })),
    ...LOCAL_BUILD_ONLY_TARGETS.map((item) => ({
      packageScript: item.packageScript,
      packageCommand: item.packageCommand,
      buildLabel: item.buildLabel,
      sourceBuildNote: item.sourceBuildNote,
      official: false,
    })),
  ];
}

function renderMarkdownTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

function renderReadmeSourceBuildTable(locale) {
  const headers = locale === "zh" ? ["分类", "命令", "说明"] : ["Scope", "Command", "Notes"];
  const separator = locale === "zh" ? "；" : "; ";
  const rows = getAllBuildTargets().map((item) => [
    item.official
      ? locale === "zh"
        ? "源码支持"
        : "Source build"
      : locale === "zh"
        ? "实验性"
        : "Experimental",
    `\`pnpm ${item.packageScript}\``,
    `${item.buildLabel[locale]}${separator}${item.sourceBuildNote[locale]}`,
  ]);
  return renderMarkdownTable(headers, rows);
}

function renderReadmeBlock(section, locale) {
  const markers = README_MARKERS[section];
  const table = renderReadmeSourceBuildTable(locale);
  return `${markers.start}\n${table}\n${markers.end}`;
}

function buildDesktopCiMatrix() {
  const seenFamilies = new Set();

  return OFFICIAL_RELEASE_TARGETS.filter((item) => {
    if (seenFamilies.has(item.osFamily)) {
      return false;
    }
    seenFamilies.add(item.osFamily);
    return true;
  }).map((item) => ({
    os_family: item.osFamily,
    runner: item.runner,
  }));
}

function buildSupportContract() {
  return {
    schemaVersion: 1,
    officialTargets: OFFICIAL_RELEASE_TARGETS.map((item) => ({
      id: item.id,
      osFamily: item.osFamily,
      runner: item.runner,
      target: item.target,
      bundles: item.bundles,
      updaterPlatform: item.updaterPlatform,
      stableLabel: item.stableLabel,
      stableAssetKind: item.stableAssetKind,
      packageScript: item.packageScript,
      latestAssetName: item.latestAssetName,
      latestSignatureName: item.latestSignatureName,
    })),
    localBuildOnlyTargets: LOCAL_BUILD_ONLY_TARGETS.map((item) => ({
      id: item.id,
      packageScript: item.packageScript,
      packageCommand: item.packageCommand,
    })),
  };
}

function parseArgs(rawArgs) {
  const args = new Map();

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = rawArgs[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for argument: ${token}`);
    }

    args.set(key, value);
    index += 1;
  }

  return args;
}

function requireArg(args, key) {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function assertExpectedOsFamilies() {
  const actualFamilies = [...new Set(OFFICIAL_RELEASE_TARGETS.map((item) => item.osFamily))].sort();
  const expectedFamilies = [...EXPECTED_DESKTOP_OS_FAMILIES].sort();

  if (actualFamilies.length !== expectedFamilies.length) {
    throw new Error(
      `Desktop OS family drifted. Expected: ${expectedFamilies.join(", ")}. Actual: ${actualFamilies.join(", ")}.`
    );
  }

  for (let index = 0; index < expectedFamilies.length; index += 1) {
    if (actualFamilies[index] !== expectedFamilies[index]) {
      throw new Error(
        `Desktop OS family drifted. Expected: ${expectedFamilies.join(", ")}. Actual: ${actualFamilies.join(", ")}.`
      );
    }
  }
}

function extractMarkedBlock(content, markerName) {
  const { start, end } = README_MARKERS[markerName];
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing README markers: ${start} ... ${end}`);
  }

  const blockEnd = endIndex + end.length;
  return content.slice(startIndex, blockEnd);
}

function assertUniqueTargets(items, getValue, label) {
  const seen = new Set();

  for (const item of items) {
    const value = getValue(item);
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function checkPackageScripts() {
  const packageJsonPath = join(repoRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const expectedBuildTargets = getAllBuildTargets();
  const allowedBuildScripts = new Set(expectedBuildTargets.map((item) => item.packageScript));

  for (const item of expectedBuildTargets) {
    if (scripts[item.packageScript] !== item.packageCommand) {
      throw new Error(
        `package.json script drifted: ${item.packageScript}\nExpected: ${item.packageCommand}\nActual: ${scripts[item.packageScript] ?? "<missing>"}`
      );
    }
  }

  const unexpectedBuildScripts = Object.keys(scripts)
    .filter((name) => name.startsWith("tauri:build:"))
    .filter((name) => !allowedBuildScripts.has(name));

  if (unexpectedBuildScripts.length > 0) {
    throw new Error(
      `Unexpected tauri build scripts outside support matrix: ${unexpectedBuildScripts.join(", ")}`
    );
  }

  if (scripts["check:support-matrix"] !== "node scripts/support-matrix.mjs check") {
    throw new Error("package.json must expose check:support-matrix.");
  }

  if (scripts["audit:deps"] !== "node scripts/check-pnpm-audit.mjs") {
    throw new Error("package.json must expose a fail-close audit:deps script.");
  }
}

function checkReadmes() {
  for (const item of README_LOCALES) {
    const readmePath = join(repoRoot, item.fileName);
    const content = readFileSync(readmePath, "utf8");

    for (const markerName of Object.keys(README_MARKERS)) {
      const actualBlock = extractMarkedBlock(content, markerName).trim();
      const expectedBlock = renderReadmeBlock(markerName, item.locale).trim();
      if (actualBlock !== expectedBlock) {
        throw new Error(
          `${item.fileName} drifted in ${markerName}. Update the support matrix block.`
        );
      }
    }
  }
}

function assertWorkflowContains(content, snippet, label) {
  if (!content.includes(snippet)) {
    throw new Error(`Workflow contract drifted: missing ${label}`);
  }
}

function checkPinnedGithubActions(workflowPath) {
  const content = readFileSync(workflowPath, "utf8");
  const usesMatches = content.matchAll(/^\s*(?:-\s+)?uses:\s+([^@\s]+)@([^\s#]+)/gm);

  for (const match of usesMatches) {
    const actionRef = match[1];
    const versionRef = match[2];

    if (actionRef.startsWith("./") || actionRef.startsWith("docker://")) {
      continue;
    }

    if (!/^[0-9a-f]{40}$/.test(versionRef)) {
      throw new Error(
        `Workflow action must pin to a full commit SHA: ${workflowPath} -> ${actionRef}@${versionRef}`
      );
    }
  }
}

function checkWorkflowContracts() {
  const ciWorkflow = readFileSync(WORKFLOW_PATHS.ci, "utf8");

  assertWorkflowContains(
    ciWorkflow,
    "desktop_matrix=$(node scripts/support-matrix.mjs ci-matrix)",
    "ci desktop matrix loader"
  );
  assertWorkflowContains(
    ciWorkflow,
    "include: ${{ fromJson(needs.support-contract.outputs.desktop_matrix) }}",
    "ci desktop matrix usage"
  );
  assertWorkflowContains(ciWorkflow, "run: pnpm check:support-matrix", "ci support matrix check");
  assertWorkflowContains(ciWorkflow, "run: pnpm audit:deps", "ci fail-close dependency audit");
}

function runSupportMatrixCheck() {
  /*
   * ============================================================================
   * 步骤2：校验单一矩阵与外部引用是否一致
   * ============================================================================
   * 目标：
   *   1) 防止 package scripts、workflow 与 README 再次各写一份
   *   2) 在 CI 中提前拦截支持矩阵和 action pin 漂移
   * 数据源：
   *   1) package.json
   *   2) README.md / README_EN.md
   *   3) .github/workflows/*.yml
   * 操作要点：
   *   1) 只允许矩阵中登记过的 tauri:build:* 脚本
   *   2) README 标记块必须与矩阵渲染结果完全一致
   *   3) CI 只能消费 support-matrix 导出的桌面平台契约
   */
  logger.info("[support-matrix] 开始校验支持矩阵...");

  // 2.1 先校验内部定义没有重复键
  assertUniqueTargets(OFFICIAL_RELEASE_TARGETS, (item) => item.id, "official target id");
  assertUniqueTargets(OFFICIAL_RELEASE_TARGETS, (item) => item.target, "rust target");
  assertUniqueTargets(OFFICIAL_RELEASE_TARGETS, (item) => item.updaterPlatform, "updater platform");
  assertUniqueTargets(OFFICIAL_RELEASE_TARGETS, (item) => item.stableLabel, "stable label");
  assertUniqueTargets(getAllBuildTargets(), (item) => item.packageScript, "package script");
  assertUniqueTargets(buildDesktopCiMatrix(), (item) => item.os_family, "desktop os family");
  assertExpectedOsFamilies();

  // 2.2 再校验 package.json 的构建脚本
  checkPackageScripts();

  // 2.3 校验 workflow 契约和 action pin
  checkWorkflowContracts();
  checkPinnedGithubActions(WORKFLOW_PATHS.ci);
  checkPinnedGithubActions(WORKFLOW_PATHS.devBuild);

  // 2.4 最后校验 README 中的支持矩阵文案
  checkReadmes();

  logger.info("[support-matrix] 支持矩阵校验通过。");
}

function printDesktopCiMatrix() {
  process.stdout.write(JSON.stringify(buildDesktopCiMatrix()));
}

function printSupportContract() {
  process.stdout.write(JSON.stringify(buildSupportContract()));
}

function printReadmeBlock(args) {
  const locale = requireArg(args, "locale");
  const section = requireArg(args, "section");
  if (!README_MARKERS[section]) {
    throw new Error(`Unsupported README section: ${section}`);
  }
  process.stdout.write(`${renderReadmeBlock(section, locale)}\n`);
}

function printUsageAndExit() {
  logger.error(
    "Usage: node scripts/support-matrix.mjs <ci-matrix|contract|check|readme-block> [--key value]"
  );
  process.exit(1);
}

function main() {
  const [command, ...restArgs] = process.argv.slice(2);
  if (!command) {
    printUsageAndExit();
  }

  const args = parseArgs(restArgs);

  switch (command) {
    case "ci-matrix":
      printDesktopCiMatrix();
      return;
    case "contract":
      printSupportContract();
      return;
    case "check":
      runSupportMatrixCheck();
      return;
    case "readme-block":
      printReadmeBlock(args);
      return;
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

main();
