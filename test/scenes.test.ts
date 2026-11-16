import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENES } from "../data.ts";
import { installedExecutable } from "../release.ts";
import DetectScenes, { type ScenesManifest, type ScenesResult, scenesRequestOf } from "../scenes.worker.ts";
import { TEST_DATA_DIR } from "../scripts/fetch-service.ts";
import { ROOTS } from "./roots.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const video = join(root, "test", "fixtures", "sample.mp4");

const context = () => {
  const progress: [number, string | undefined][] = [];
  return {
    progress,
    signal: new AbortController().signal,
    sendProgress: (p: number, m?: string) => progress.push([p, m]),
  };
};

const envelope = (settings: Record<string, unknown>, input: unknown = { path: video }) => ({
  settings: { ...settings, profile: {} },
  input,
});

describe("scenesRequestOf", () => {
  it("asks for the scenes alone unless told to pick frames, which are 640 wide and skip blank ones", () => {
    expect(scenesRequestOf(envelope({}))).toEqual({});
    expect(scenesRequestOf(envelope({ hint: "anime", minSceneLen: 1, frames: { maxPerScene: 2 } }))).toEqual({
      hint: "anime",
      min_scene_len: 1,
      frames: { max_per_scene: 2, size: { width: 640, fit: "contain" }, format: "jpeg" },
      skip_blank_frames: true,
    });
  });

  it("puts the advanced fields at the top of the request, keeping adaptive: null", () => {
    expect(
      scenesRequestOf(
        envelope({
          detector: "scdet",
          advanced: { adaptive: { ratio: 2, minScore: 3 }, flashFilter: "off", skipNonref: true },
        }),
      ),
    ).toEqual({
      detector: "scdet",
      adaptive: { ratio: 2, min_score: 3 },
      flash_filter: "off",
      skip_nonref: true,
    });
    expect(scenesRequestOf(envelope({ hint: "real", advanced: { adaptive: null } }))).toEqual({
      hint: "real",
      adaptive: null,
    });
  });

  it("refuses wrong options, saying which", () => {
    expect(() => scenesRequestOf(envelope({ hint: "cartoon" }))).toThrow(/`hint` must be one of/);
    expect(() => scenesRequestOf(envelope({ frames: { every: -1 } }))).toThrow(/`frames.every`/);
    expect(() => scenesRequestOf(envelope({ frames: { perScene: 2 } }))).toThrow(
      /`frames.perScene` is not an option/,
    );
    expect(() => scenesRequestOf(envelope({ advanced: { weights: { red: 1 } } }))).toThrow(
      /`advanced.weights.red` is not an option/,
    );
  });
});

const fetched = existsSync(installedExecutable(join(TEST_DATA_DIR, "service")) ?? "");

describe.skipIf(!fetched)("DetectScenes (needs `pnpm fetch-service`)", () => {
  let dir: string;
  let worker: DetectScenes;
  const run = (
    settings: Record<string, unknown>,
    input: unknown = { path: video },
    ctx = context(),
    roots = ROOTS,
  ) =>
    worker.run(
      { settings: { ...settings, profile: { outputDir: dir }, roots }, input },
      ctx,
    ) as Promise<ScenesResult>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "video-thumbnail-scenes-"));
    worker = new DetectScenes({ host: { dataDir: TEST_DATA_DIR } });
    await worker.setup();
  });
  afterAll(async () => {
    await worker.teardown();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the cut after the black opening, and keeps the scene list alone in a folder of its own", async () => {
    const ctx = context();
    const result = await run({ lists: "result" }, { path: video }, ctx);
    expect(result.folder.startsWith(dir)).toBe(true);
    expect(result).toMatchObject({
      manifest: join(result.folder, "scenes.json"),
      count: 2,
      frameCount: 0,
      video,
      detector: "content",
      reused: false,
      frames: [],
    });
    const [first, second] = result.scenes ?? [];
    expect(first?.start).toBe(0);
    expect(first?.end).toBeCloseTo(1, 0);
    expect(second?.mid).toBeCloseTo(((second?.start ?? 0) + (second?.end ?? 0)) / 2);
    expect(await readdir(result.folder)).toEqual(["scenes.json"]);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8")) as ScenesManifest;
    expect(manifest).not.toHaveProperty("scores");
    expect(manifest.scenes[0]).toHaveProperty("mid");
    expect(ctx.progress.at(-1)?.[0]).toBe(1);
  });

  it("picks frames from each scene, named in the manifest relative to the folder", async () => {
    const result = await run({ frames: { every: 1, width: 96 }, lists: "result" });
    expect(result.frameCount).toBeGreaterThan(0);
    expect(result.frames?.[0]?.path).toBe(join(result.folder, "frame_0000.jpg"));
    const manifest = JSON.parse(await readFile(result.manifest, "utf8")) as ScenesManifest;
    expect(manifest.frames?.[0]?.file).toBe("frame_0000.jpg");
    expect(manifest.config).toHaveProperty("frames");
    expect((manifest.config as { frames: object }).frames).not.toHaveProperty("output");
    expect((await readdir(result.folder)).length).toBe(result.frameCount + 1);
  });

  it("leaves the lists in the manifest by default", async () => {
    const result = await run({});
    expect(result).not.toHaveProperty("scenes");
    expect(result).not.toHaveProperty("frames");
  });

  it("reuses the scenes detected before, unless told to overwrite", async () => {
    const first = await run({ minSceneLen: 0.5 });
    const ctx = context();
    expect(await run({ minSceneLen: 0.5 }, { path: video }, ctx)).toEqual({ ...first, reused: true });
    expect(ctx.progress.at(-1)).toEqual([1, "Reused the scenes detected before"]);
    expect(await run({ minSceneLen: 0.5, overwrite: true })).toMatchObject({
      folder: first.folder,
      reused: false,
    });
  });

  it("passes on the service's refusal of a field the detector does not use, leaving no staging folder", async () => {
    await expect(run({ detector: "keyframes", threshold: 10 })).rejects.toThrow(
      /The thumbnail service refused the request \(400\)/,
    );
    expect((await readdir(dir)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("refuses a video out of the Task's Allowed roots, but writes to its own folder", async () => {
    await expect(run({}, { path: video }, context(), [])).rejects.toThrow(/no Allowed roots/);
    const own = (await worker.run(
      { settings: { profile: {}, roots: [{ path: root, access: "read" }] }, input: { path: video } },
      context(),
    )) as ScenesResult;
    expect(own.folder.startsWith(join(TEST_DATA_DIR, SCENES))).toBe(true);
  });
});
