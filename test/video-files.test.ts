import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import IsVideo, { type Settings as IsVideoSettings } from "../is-video.worker.ts";
import VideoFiles, { type Settings } from "../video-files.worker.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const sample = join(root, "test", "fixtures", "sample.mp4");

const context = () => ({ signal: new AbortController().signal, sendProgress: () => {} });
const run = (input: unknown, settings: Settings = {}) =>
  new VideoFiles().run({ settings: { ...settings, profile: {} }, input }, context());

describe("VideoFiles", () => {
  let dir: string;
  const at = (name: string) => join(dir, name);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "video-files-test-"));
    await copyFile(sample, at("movie.mp4"));
    await copyFile(sample, at("MOVIE2.MP4"));
    await copyFile(sample, at("movie.txt"));
    await writeFile(at("fake.mkv"), "not a video");
    await writeFile(at("notes.md"), "# notes");
    await mkdir(at("folder.mp4"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the videos of a list of paths, as `{ path }`, and says why it left out the rest", async () => {
    const result = await run({
      entries: [
        at("movie.mp4"),
        at("fake.mkv"),
        at("notes.md"),
        at("MOVIE2.MP4"),
        at("gone.mp4"),
        "movie.mp4",
      ],
    });
    expect(result.entries).toEqual([{ path: at("movie.mp4") }, { path: at("MOVIE2.MP4") }]);
    expect(result.skipped).toEqual([
      { path: at("fake.mkv"), reason: "not a video container" },
      { path: at("notes.md"), reason: "not a video extension" },
      { path: at("gone.mp4"), reason: "unreadable (ENOENT)" },
      { path: "movie.mp4", reason: "not an absolute path" },
    ]);
  });

  it("keeps a ListFolder entry whole, and leaves out a folder", async () => {
    const file = { path: at("movie.mp4"), name: "movie.mp4", kind: "file", size: 1 };
    const folder = { path: at("folder.mp4"), name: "folder.mp4", kind: "directory", size: 0 };
    const result = await run({ path: dir, entries: [file, folder] });
    expect(result.entries).toEqual([file]);
    expect(result.skipped).toEqual([{ path: at("folder.mp4"), reason: "a directory" }]);
  });

  it("takes the Node's extensions, and with checkContent off trusts them", async () => {
    const entries = [at("movie.mp4"), at("movie.txt"), at("fake.mkv")];
    expect((await run({ entries }, { extensions: [".TXT"] })).entries).toEqual([{ path: at("movie.txt") }]);
    expect((await run({ entries }, { checkContent: false })).entries).toEqual([
      { path: at("movie.mp4") },
      { path: at("fake.mkv") },
    ]);
  });

  it("takes the list, and the path in each item, from where the Node says", async () => {
    const files = [{ file: { location: at("movie.mp4") } }, { file: { location: at("notes.md") } }];
    const result = await run({ listing: { files } }, { list: "listing.files", pathKey: "file.location" });
    expect(result.entries).toEqual([files[0]]);
    expect(result.skipped).toEqual([{ path: at("notes.md"), reason: "not a video extension" }]);
    expect((await run([at("movie.mp4"), at("notes.md")], { list: "." })).entries).toEqual([
      { path: at("movie.mp4") },
    ]);
  });

  it("refuses an input without the list, or an item without a path, saying where it looked", async () => {
    await expect(run({ path: dir })).rejects.toThrow(/No list at `entries` in the Task input/);
    await expect(run({ files: [] }, { list: "listing.files" })).rejects.toThrow(/No list at `listing.files`/);
    await expect(run({ entries: [{ name: "a.mp4" }] })).rejects.toThrow(
      /`entries`\[0\] has no path at `path`/,
    );
  });
});

describe("IsVideo", () => {
  let dir: string;
  const at = (name: string) => join(dir, name);
  const check = (input: unknown, settings: IsVideoSettings = {}) =>
    new IsVideo().run({ settings: { ...settings, profile: {} }, input }, context());

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "is-video-test-"));
    await copyFile(sample, at("movie.mp4"));
    await writeFile(at("fake.mkv"), "not a video");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("says a video is one, and in which container", async () => {
    expect(await check({ path: at("movie.mp4"), size: 1 })).toEqual({
      path: at("movie.mp4"),
      video: true,
      container: "mp4",
    });
  });

  it("says why a file is not one, as a result rather than a failure", async () => {
    expect(await check(at("fake.mkv"))).toEqual({
      path: at("fake.mkv"),
      video: false,
      reason: "not a video container",
    });
    expect(await check({}, { path: at("gone.mp4") })).toMatchObject({
      video: false,
      reason: "unreadable (ENOENT)",
    });
  });

  it("takes its path setting over the input, else the path at pathKey", async () => {
    expect(await check({ path: at("fake.mkv") }, { path: at("movie.mp4") })).toMatchObject({ video: true });
    expect(await check({ file: { at: at("movie.mp4") } }, { pathKey: "file.at" })).toMatchObject({
      video: true,
    });
    await expect(check({ name: "a.mp4" })).rejects.toThrow(/No path at `path` in the Task input/);
  });
});
