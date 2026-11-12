// The Plugin as a Host runs it: its declarations handed to fyflow's own `createRuntime`, without the keys only the
// app reads, and a Flow run on it.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FlowDefinition,
  findings,
  type RegistryDocument,
  validateDefinition,
} from "fyflow-orchestration";
import { createRuntime } from "fyflow-orchestration/scheduler";
import { CPU_GROUP, DISK_GROUP, type PluginNodeType } from "fyflow-plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../plugin.ts";
import { installedExecutable } from "../release.ts";
import { TEST_DATA_DIR } from "../scripts/fetch-service.ts";
import { ROOTS } from "./roots.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The Host gives each Worker the Plugin's data directory, where the service is downloaded to. */
const hostConfig = { host: { dataDir: TEST_DATA_DIR } };
const video = join(root, "test", "fixtures", "sample.mp4");

/** `config` stands in for the Profile's start-up fields, which the Host gives each Node Type as its config. */
const registryOf = (config: Record<string, unknown> = {}): RegistryDocument => ({
  // Every Worker of this Plugin is a JS one, with a `url`: no Python Workers. A Host puts each Task's Allowed roots
  // in its settings; here the Node Types' settings carry them, so each Worker's settings schema takes them.
  workers: Object.fromEntries(
    Object.entries(plugin.workers ?? {}).map(([name, entry]) => {
      const schema = entry.settingsSchema as { properties?: Record<string, unknown> } | undefined;
      return [
        name,
        {
          ...entry,
          settingsSchema: { ...schema, properties: { ...schema?.properties, roots: { type: "array" } } },
        },
      ];
    }),
  ) as NonNullable<RegistryDocument["workers"]>,
  nodeTypes: Object.fromEntries(
    Object.entries(plugin.nodeTypes ?? {}).map(
      ([name, { icon: _i, description: _d, profile: _p, ...declaration }]) => [
        name,
        { ...(declaration as PluginNodeType), config, settings: { roots: ROOTS } },
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
    expect(() => createRuntime(registryOf(hostConfig), {}, { base: plugin.base })).not.toThrow();
  });

  it("has input schemas that take every input its Workers take, as fyflow holds a Run's input to them", () => {
    const { thumbnail, videoFiles, isVideo } = plugin.workers as Record<
      string,
      { inputSchema: Record<string, unknown> }
    >;
    const entry = {
      name: "a.mp4",
      path: "D:/a.mp4",
      relativePath: "a.mp4",
      kind: "file",
      size: 1,
      modifiedAt: "",
    };
    const fits = (schema: Record<string, unknown> | undefined, value: unknown) =>
      expect(findings(schema ?? {}, value)).toEqual([]);
    expect(findings(thumbnail?.inputSchema ?? {}, {})).not.toEqual([]); // `path` is the input's
    fits(thumbnail?.inputSchema, { path: "D:/a.mp4", video: true, container: "mp4" }); // an IsVideo result
    fits(thumbnail?.inputSchema, entry);
    fits(videoFiles?.inputSchema, { path: "D:/", entries: [entry, "D:/b.mkv"] });
    fits(videoFiles?.inputSchema, ["D:/a.mp4"]); // `list: "."`
    fits(videoFiles?.inputSchema, { listing: { files: [] } }); // `list: "listing.files"`
    fits(isVideo?.inputSchema, "D:/a.mp4");
    fits(isVideo?.inputSchema, entry);
    fits(isVideo?.inputSchema, { file: { path: "D:/a.mp4" } }); // `pathKey: "file.path"`
  });

  it("lets fyflow refuse a Flow whose settings are wrong before it runs", () => {
    const findings = validateDefinition(flowOf({ fit: "fill" }), judgedBy());
    expect(findings.map((f) => f.rule)).toContain("FD-V33");
    expect(
      validateDefinition(flowOf({ fit: "contain", selection: { mode: "uniform", frames: 2 } }), judgedBy()),
    ).toEqual([]);
  });
});

describe.skipIf(!existsSync(installedExecutable(join(TEST_DATA_DIR, "service")) ?? ""))(
  "the Plugin in a runtime (needs `pnpm fetch-service`)",
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
      const runtime = createRuntime(registryOf(hostConfig), {}, { base: plugin.base });
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

    it("runs VideoFiles before a map of VideoThumbnail: one thumbnail per video, and none without one", async () => {
      const flow: FlowDefinition = {
        flowId: "thumbnails",
        version: 1,
        entry: "videos",
        nodes: [
          {
            id: "videos",
            kind: "task",
            type: "VideoFiles",
            // Around the map when there are no videos: a map over none never reaches its join.
            edges: [
              { to: "each", when: { path: "outcome.result.count", op: "gt", value: 0 } },
              { to: "done" },
            ],
          },
          { id: "each", kind: "map", over: "entries", branch: "thumb" },
          {
            id: "thumb",
            kind: "task",
            type: "VideoThumbnail",
            settings: { output: dir },
            edges: [{ to: "gather" }],
          },
          { id: "gather", kind: "join", of: "each", edges: [{ to: "done" }] },
          { id: "done", kind: "end", outcome: "completed" },
        ],
      };
      expect(validateDefinition(flow, judgedBy())).toEqual([]);
      const runtime = createRuntime(registryOf(hostConfig), {}, { base: plugin.base });
      try {
        const { done } = runtime.start(flow, { entries: [video, join(root, "README.md")] });
        const state = await done;
        expect(state.outcome).toBe("completed");
        const thumbs = Object.values(state.nodes).filter((n) => n.nodeId === "thumb");
        expect(thumbs.map((n) => (n.result as { video?: string } | undefined)?.video)).toEqual([video]);
        const none = await runtime.start(flow, { entries: [join(root, "README.md")] }).done;
        expect(none.outcome).toBe("completed");
        expect(Object.values(none.nodes).some((n) => n.nodeId === "thumb")).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    });

    it("routes on IsVideo in a map: each video to VideoThumbnail, the rest past it", async () => {
      const flow: FlowDefinition = {
        flowId: "thumbnails-by-item",
        version: 1,
        entry: "each",
        nodes: [
          { id: "each", kind: "map", over: "paths", branch: "check" },
          {
            id: "check",
            kind: "task",
            type: "IsVideo",
            edges: [
              { to: "thumb", when: { path: "outcome.result.video", op: "eq", value: true } },
              { to: "gather" }, // the rest: fyflow wants one Edge without a condition
            ],
          },
          {
            id: "thumb",
            kind: "task",
            type: "VideoThumbnail",
            // IsVideo's result is what reaches it, and has the `path` it reads.
            settings: { output: dir },
            edges: [{ to: "gather" }],
          },
          { id: "gather", kind: "join", of: "each", edges: [{ to: "done" }] },
          { id: "done", kind: "end", outcome: "completed" },
        ],
      };
      expect(validateDefinition(flow, judgedBy())).toEqual([]);
      const runtime = createRuntime(registryOf(hostConfig), {}, { base: plugin.base });
      try {
        const { done } = runtime.start(flow, { paths: [join(root, "README.md"), video] });
        const state = await done;
        expect(state.outcome).toBe("completed");
        const ran = (id: string) => Object.values(state.nodes).filter((n) => n.nodeId === id);
        expect(ran("check").map((n) => (n.result as { video: boolean }).video)).toEqual([false, true]);
        expect(ran("thumb").map((n) => (n.result as { video?: string } | undefined)?.video)).toEqual([video]);
      } finally {
        await runtime.shutdown();
      }
    });
  },
);
