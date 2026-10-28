// The Plugin as a Host runs it: its declarations handed to fyflow's own `createRuntime`, without the keys only the
// app reads, and a Flow run on it.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FlowDefinition, type RegistryDocument, validateDefinition } from "fyflow-orchestration";
import { createRuntime } from "fyflow-orchestration/scheduler";
import { CPU_GROUP, DISK_GROUP, type PluginNodeType } from "fyflow-plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../plugin.ts";
import { EXECUTABLE, serviceDir } from "../service.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const video = join(root, "test", "fixtures", "sample.mp4");

/** `config` stands in for the Profile's start-up fields, which the Host gives each Node Type as its config. */
const registryOf = (config: Record<string, unknown> = {}): RegistryDocument => ({
  workers: { ...plugin.workers },
  nodeTypes: Object.fromEntries(
    Object.entries(plugin.nodeTypes ?? {}).map(
      ([name, { icon: _i, description: _d, profile: _p, ...declaration }]) => [
        name,
        { ...(declaration as PluginNodeType), config },
      ],
    ),
  ),
  // The `disk` and `cpu` groups its Node Type names, as the Host's built-in Plugin declares them.
  groups: {
    [DISK_GROUP]: { type: "ConcurrentLimitGroup", config: { limit: 4 } },
    [CPU_GROUP]: { type: "ConcurrentLimitGroup", config: { limit: availableParallelism() } },
  },
});

/** What `validateDefinition` judges a Flow against: the registry's workers and Node Types, and no predicates. */
const judgedBy = () => {
  const { workers = {}, nodeTypes = {} } = registryOf();
  return { predicates: [], workers, nodeTypes };
};

const flowOf = (settings: Record<string, unknown>): FlowDefinition => ({
  flowId: "thumbnail",
  version: 1,
  entry: "thumb",
  nodes: [
    { id: "thumb", kind: "task", type: "VideoThumbnail", settings, edges: [{ to: "done" }] },
    { id: "done", kind: "end", outcome: "completed" },
  ],
});

describe("the Plugin's declarations", () => {
  it("is what fyflow accepts: its schemas in fyflow's subset, its Node Type on its pool", () => {
    expect(() => createRuntime(registryOf(), {}, { base: plugin.base })).not.toThrow();
  });

  it("lets fyflow refuse a Flow whose settings are wrong before it runs", () => {
    const findings = validateDefinition(flowOf({ fit: "fill" }), judgedBy());
    expect(findings.map((f) => f.rule)).toContain("FD-V33");
    expect(
      validateDefinition(flowOf({ fit: "contain", selection: { mode: "uniform", frames: 2 } }), judgedBy()),
    ).toEqual([]);
  });
});

describe.skipIf(!existsSync(join(serviceDir(root), EXECUTABLE)))(
  "the Plugin in a runtime (needs `pnpm copy-service`)",
  () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "video-thumbnail-plugin-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("runs a Flow: fyflow sets the Worker up, so its service makes the thumbnail", async () => {
      // No Host here to add the per-Task `outputDir` under `settings.profile`, so the Node names the folder.
      const runtime = createRuntime(registryOf(), {}, { base: plugin.base });
      try {
        const { done } = runtime.start(flowOf({ output: dir, renderTimestamps: true }), { path: video });
        const state = await done;
        expect(state.outcome).toBe("completed");
        const thumb = Object.values(state.nodes).find((n) => n.nodeId === "thumb");
        expect(thumb?.result).toMatchObject({ video, width: 640, height: 360, reused: false });
        const result = thumb?.result as { path: string } | undefined;
        expect(result?.path.startsWith(dir)).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    });
  },
);
