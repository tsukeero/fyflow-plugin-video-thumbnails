import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FRAMES } from "../data.ts";
import ExtractFrames, { type FramesManifest, type FramesResult, framesRequestOf } from "../frames.worker.ts";
import { installedExecutable } from "../release.ts";
import { TEST_DATA_DIR } from "../scripts/fetch-service.ts";
import { ROOTS } from "./roots.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const video = join(root, "test", "fixtures", "sample.mp4");

const context = (signal = new AbortController().signal) => {
  const progress: [number, string | undefined][] = [];
  return { progress, signal, sendProgress: (p: number, m?: string) => progress.push([p, m]) };
};

const envelope = (settings: Record<string, unknown>, input: unknown = { path: video }) => ({
  settings: { ...settings, profile: {} },
  input,
});

describe("framesRequestOf", () => {
  it("asks for 8 frames 640 wide, fitted inside, as JPEG, skipping blank ones, unless told otherwise", () => {
    expect(framesRequestOf(envelope({}))).toEqual({
      selection: { mode: "uniform", frames: 8 },
      size: { width: 640, fit: "contain" },
      format: "jpeg",
      skip_blank_frames: true,
    });
    expect(
      framesRequestOf(
        envelope(
          { height: 200, format: "png" },
          { path: video, selection: { mode: "timestamps", timestamps: [1, 2] }, skipBlankFrames: false },
        ),
      ),
    ).toEqual({
      selection: { mode: "timestamps", timestamps: [1, 2] },
      size: { height: 200, fit: "contain" },
      format: "png",
      skip_blank_frames: false,
    });
  });

  it("refuses wrong options, saying which", () => {
    expect(() => framesRequestOf(envelope({ selection: { mode: "uniform" } }))).toThrow(/`selection.frames`/);
    expect(() => framesRequestOf(envelope({ fit: "fill" }))).toThrow(/`fit` must be one of/);
    expect(() => framesRequestOf(envelope({ quality: 101 }))).toThrow(/`quality` must be at most 100/);
    expect(() => framesRequestOf(envelope({ width: 0 }))).toThrow(/`width` must be an integer of at least 1/);
  });
});

const fetched = existsSync(installedExecutable(join(TEST_DATA_DIR, "service")) ?? "");

describe.skipIf(!fetched)("ExtractFrames (needs `pnpm fetch-service`)", () => {
  let dir: string;
  let worker: ExtractFrames;
  const run = (
    settings: Record<string, unknown>,
    input: unknown = { path: video },
    ctx = context(),
    roots = ROOTS,
  ) =>
    worker.run(
      { settings: { ...settings, profile: { outputDir: dir }, roots }, input },
      ctx,
    ) as Promise<FramesResult>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "video-thumbnail-frames-"));
    worker = new ExtractFrames({ host: { dataDir: TEST_DATA_DIR } });
    await worker.setup();
  });
  afterAll(async () => {
    await worker.teardown();
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts frames into a folder of their own in the Profile's outputDir, with a manifest", async () => {
    const ctx = context();
    const result = await run({ selection: { mode: "uniform", frames: 3 }, width: 160 }, { path: video }, ctx);
    expect(result.folder.startsWith(dir)).toBe(true);
    expect(result.folder).toMatch(/sample\.[0-9a-f]{12}$/);
    expect(result).toMatchObject({
      manifest: join(result.folder, "frames.json"),
      count: 3,
      video,
      duration: 6,
      reused: false,
    });
    expect(result.frames).toBeUndefined();
    expect((await readdir(result.folder)).sort()).toEqual([
      "frame_000.jpg",
      "frame_001.jpg",
      "frame_002.jpg",
      "frames.json",
    ]);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8")) as FramesManifest;
    expect(manifest.video).toBe(video);
    expect(manifest.frames.map((f) => f?.file)).toEqual(["frame_000.jpg", "frame_001.jpg", "frame_002.jpg"]);
    expect(manifest.config).not.toHaveProperty("output");
    // Nothing of the staging folder is left.
    expect((await readdir(dir)).filter((name) => name.endsWith(".part"))).toEqual([]);
    expect(ctx.progress.at(-1)?.[0]).toBe(1);
  });

  it("puts the lists in the result with lists: result", async () => {
    const result = await run({
      selection: { mode: "timestamps", timestamps: [2, 4] },
      width: 160,
      lists: "result",
    });
    expect(result.frames).toEqual([
      { path: join(result.folder, "frame_000.jpg"), index: 0, requested: 2, actual: expect.any(Number) },
      { path: join(result.folder, "frame_001.jpg"), index: 1, requested: 4, actual: expect.any(Number) },
    ]);
    expect(result.missing).toEqual([]);
  });

  it("reuses the folder made before for the same video and options, unless told to overwrite", async () => {
    const settings = { selection: { mode: "uniform", frames: 2 }, width: 120 };
    const first = await run(settings);
    const ctx = context();
    const again = await run(settings, { path: video }, ctx);
    expect(again).toEqual({ ...first, reused: true });
    expect(ctx.progress.at(-1)).toEqual([1, "Reused the frames extracted before"]);
    const overwritten = await run({ ...settings, overwrite: true });
    expect(overwritten).toMatchObject({ folder: first.folder, reused: false });
    const other = await run({ ...settings, width: 130 });
    expect(other.folder).not.toBe(first.folder);
  });

  it("writes PNG frames when asked", async () => {
    const result = await run({ selection: { mode: "uniform", frames: 1 }, width: 100, format: "png" });
    expect(await readdir(result.folder)).toContain("frame_000.png");
  });

  it("fails a Task on a video that is not there, leaving no staging folder", async () => {
    await expect(run({}, { path: join(dir, "missing.mp4") })).rejects.toThrow(/No video at .*missing\.mp4/);
    const bad = join(dir, "bad");
    await mkdir(bad, { recursive: true });
    const text = join(bad, "not-a-video.mp4");
    await writeFile(text, "hello");
    await expect(run({ output: bad }, { path: text })).rejects.toThrow(/The thumbnail service failed/);
    expect(await readdir(bad)).toEqual(["not-a-video.mp4"]);
  });

  it("refuses a video, or an output, out of the Task's Allowed roots, but writes to its own folder", async () => {
    const readOnly = [{ path: root, access: "read" as const }];
    await expect(run({}, { path: video }, context(), [])).rejects.toThrow(/no Allowed roots/);
    await expect(run({}, { path: video }, context(), readOnly)).rejects.toThrow(
      /outside every Allowed root with write access/,
    );
    const own = (await worker.run(
      {
        settings: { selection: { mode: "uniform", frames: 1 }, width: 64, profile: {}, roots: readOnly },
        input: { path: video },
      },
      context(),
    )) as FramesResult;
    expect(own.folder.startsWith(join(TEST_DATA_DIR, FRAMES))).toBe(true);
  });

  it("stops at once when the Task is Cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));
    await expect(run({ overwrite: true }, { path: video }, context(controller.signal))).rejects.toThrow(
      "Cancelled",
    );
  });
});
