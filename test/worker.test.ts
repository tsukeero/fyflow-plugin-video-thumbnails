import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXECUTABLE, serviceDir } from "../service.ts";
import VideoThumbnail, { type ThumbnailResult } from "../thumbnail.worker.ts";

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

describe("VideoThumbnail without a service", () => {
  it("fails setup, naming the Profile's executablePath, when the service is not there", async () => {
    const worker = new VideoThumbnail({ executablePath: join(root, "nowhere", EXECUTABLE) });
    await expect(worker.setup()).rejects.toThrow(
      /No thumbnail service at .*nowhere.*`executablePath` in the fyflow-ext.video-thumbnail section of this Node.s Profile/,
    );
  });
});

describe.skipIf(!existsSync(join(serviceDir(root), EXECUTABLE)))(
  "VideoThumbnail (needs `pnpm copy-service`)",
  () => {
    let dir: string;
    let worker: VideoThumbnail;
    // The Profile's `outputDir` reaches each Task, as the Host gives it, under `settings.profile`.
    const run = (settings: Record<string, unknown>, input: unknown = {}, ctx = context()) =>
      worker.run(
        { settings: { ...settings, profile: { outputDir: dir } }, input },
        ctx,
      ) as Promise<ThumbnailResult>;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "video-thumbnail-test-"));
      worker = new VideoThumbnail({});
      await worker.setup();
    });
    afterAll(async () => {
      await worker.teardown();
      await rm(dir, { recursive: true, force: true });
    });

    it("makes a thumbnail of the middle of the video in the Profile's outputDir, and describes it", async () => {
      const ctx = context();
      const result = await run({}, { path: video }, ctx);
      expect(result.path.startsWith(dir)).toBe(true);
      expect(result.path).toMatch(/sample\.[0-9a-f]{12}\.jpg$/);
      expect(result).toMatchObject({ video, duration: 6, width: 640, height: 360, reused: false });
      expect(result.frames).toEqual([{ requested: 3, actual: 3 }]);
      expect((await stat(result.path)).size).toBeGreaterThan(1000);
      expect(ctx.progress.at(-1)?.[0]).toBe(1);
    });

    it("reuses the thumbnail it made before for the same video and options, unless told to overwrite", async () => {
      const first = await run({ path: video, selection: { mode: "uniform", frames: 2 } });
      const again = await run({ path: video, selection: { mode: "uniform", frames: 2 } });
      expect(again).toEqual({ ...first, reused: true });
      const overwritten = await run({
        path: video,
        selection: { mode: "uniform", frames: 2 },
        overwrite: true,
      });
      expect(overwritten).toMatchObject({ path: first.path, reused: false });
    });

    it("writes to a .jpg path it is given, making its folders", async () => {
      const output = join(dir, "nested", "deeper", "cover.jpg");
      const result = await run({ output }, { path: video });
      expect(result.path).toBe(output);
      expect((await stat(output)).isFile()).toBe(true);
    });

    it("skips the black opening when asked for a frame there", async () => {
      const result = await run({ path: video, selection: { mode: "timestamps", timestamps: [0.2] } });
      expect(result.frames[0]?.requested).toBe(0.2);
      expect(result.frames[0]?.actual).toBeGreaterThan(1);
    });

    it("makes a contact sheet with the advanced layout and timestamps from the bundled font", async () => {
      const result = await run(
        { path: video },
        {
          selection: { mode: "timestamps", timestamps: [2, 4] },
          collage: {
            mode: "advanced",
            pieces: [
              { x: 0, y: 0, w: 0.5, h: 1 },
              { x: 0.5, y: 0, w: 0.5, h: 1 },
            ],
            width: 800,
            height: 225,
          },
          renderTimestamps: true,
        },
      );
      expect(result).toMatchObject({ width: 800, height: 225 });
      expect(result.frames.map((f) => f.requested)).toEqual([2, 4]);
    });

    it("fails a Task on a video that is not there, or not a video, saying so", async () => {
      await expect(run({ path: join(dir, "missing.mp4") })).rejects.toThrow(/No video at .*missing\.mp4/);
      const text = join(dir, "not-a-video.mp4");
      await writeFile(text, "hello");
      await expect(run({ path: text })).rejects.toThrow(/The thumbnail service failed/);
    });

    it("fails a Task whose options are wrong before asking the service", async () => {
      await expect(run({ path: video }, { collage: { mode: "grid" } })).rejects.toThrow(/`collage.rows`/);
    });

    it("stops at once when the Task is Cancelled", async () => {
      const controller = new AbortController();
      controller.abort(new Error("Cancelled"));
      const ctx = { ...context(), signal: controller.signal };
      await expect(run({ path: video, overwrite: true }, {}, ctx)).rejects.toThrow("Cancelled");
    });
  },
);
