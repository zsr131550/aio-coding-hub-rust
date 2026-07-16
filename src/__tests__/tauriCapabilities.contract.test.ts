import { describe, expect, it } from "vitest";

const capabilitySources = import.meta.glob("../../src-tauri/capabilities/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const benchmarkPermissionSources = import.meta.glob(
  "../../src-tauri/permissions/benchmark/*.toml",
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
) as Record<string, string>;

const buildScriptSources = import.meta.glob("../../src-tauri/build.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const benchmarkRustSources = import.meta.glob("../../src-tauri/src/benchmark.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

type CapabilityDefinition = {
  identifier: string;
  windows: string[];
  permissions: unknown[];
};

function parseCapabilityDefinitions() {
  return Object.entries(capabilitySources)
    .map(([path, source]) => ({
      path: path.split("/").pop() ?? path,
      data: JSON.parse(source) as CapabilityDefinition,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

describe("tauri capabilities contract", () => {
  it("keeps only the renderer-owned main-core capability", () => {
    const definitions = parseCapabilityDefinitions();

    expect(definitions.map((item) => item.path)).toEqual(["main-core.json"]);

    expect(definitions.every((item) => item.data.windows.includes("main"))).toBe(true);

    const coreCapability = definitions.find((item) => item.data.identifier === "main-core");
    expect(coreCapability?.data.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "core:window:allow-start-dragging",
      "core:window:allow-internal-toggle-maximize",
      "benchmark:allow-commands",
    ]);
  });

  it("grants only the benchmark protocol commands through an inlined plugin ACL", () => {
    const permissions = Object.entries(benchmarkPermissionSources);
    expect(permissions.map(([path]) => path.split("/").pop())).toEqual(["commands.toml"]);
    expect(permissions[0]?.[1].replace(/\r\n/g, "\n")).toBe(
      [
        "[[permission]]",
        'identifier = "allow-commands"',
        'description = "Allows the isolated benchmark renderer to report protocol milestones and execute fixed benchmark workloads."',
        'commands.allow = ["record", "request_logs", "run_gateway_load", "finish"]',
        "",
      ].join("\n")
    );

    const buildScript = Object.values(buildScriptSources)[0];
    expect(buildScript).toContain('.plugin("benchmark", tauri_build::InlinedPlugin::new())');

    const benchmarkRust = Object.values(benchmarkRustSources)[0]?.replace(/\r\n/g, "\n");
    expect(benchmarkRust).toContain(
      [
        "tauri::generate_handler![",
        "                record,",
        "                request_logs,",
        "                run_gateway_load,",
        "                finish",
        "            ]",
      ].join("\n")
    );
    expect(benchmarkRust).toContain("let config = REPORTER.get()?.as_ref()?.config();");
  });
});
