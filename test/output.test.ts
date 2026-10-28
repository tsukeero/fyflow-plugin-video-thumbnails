import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_DIR, framesOf, metadataOf, outputOf } from "../output.ts";

const root = process.platform === "win32" ? "C:\\work" : "/work";
const video = join(root, "videos", "Movie.Final.mp4");
const stats = { size: 1000, mtimeMs: 1_700_000_000_000 };
const request = { selection: { mode: "uniform", frames: 1 } };
const of = (output: string | undefined, outputDir?: string) =>
  outputOf({ output, outputDir, video, stats, request });

describe("outputOf", () => {
  it("writes to a path ending in .jpg or .jpeg as it is, never reusing what is there", () => {
    expect(of(join(root, "thumbs", "cover.jpg"))).toEqual({
      path: join(root, "thumbs", "cover.jpg"),
      named: false,
    });
    expect(of(join(root, "thumbs", "cover.JPEG")).path).toBe(join(root, "thumbs", "cover.JPEG"));
  });

  it("names a file in a folder it is given after the video and a hash of what makes the thumbnail", () => {
    const { path, named } = of(join(root, "thumbs"));
    expect(named).toBe(true);
    expect(path).toMatch(/[\\/]thumbs[\\/]Movie\.Final\.[0-9a-f]{12}\.jpg$/);
  });

  it("falls back to the Profile's outputDir, then to a folder in the system's temp folder", () => {
    expect(of(undefined, join(root, "profile")).path.startsWith(join(root, "profile"))).toBe(true);
    expect(DEFAULT_OUTPUT_DIR).toBe(join(tmpdir(), "fyflow-video-thumbnails"));
    expect(of(undefined).path.startsWith(DEFAULT_OUTPUT_DIR)).toBe(true);
  });

  it("gives the same name for the same video and options, and a new one when either changes", () => {
    const name = of(undefined).path;
    expect(of(undefined).path).toBe(name);
    expect(outputOf({ video, stats: { ...stats, mtimeMs: 1 }, request }).path).not.toBe(name);
    expect(outputOf({ video, stats, request: { selection: { mode: "uniform", frames: 2 } } }).path).not.toBe(
      name,
    );
  });

  it("refuses a relative output or outputDir", () => {
    expect(() => of("thumbs")).toThrow(/`output` must be an absolute path/);
    expect(() => of(undefined, "thumbs")).toThrow(
      /`outputDir` must be an absolute path: "thumbs" is relative; fix it where it is set/,
    );
  });
});

describe("metadataOf", () => {
  const jpeg = (comment: string) => {
    const text = Buffer.from(comment);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(text.length + 2);
    // SOI, an APP0 segment of 4 bytes, the COM segment, then the start of the image data.
    return Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xfe]),
      length,
      text,
      Buffer.from([0xff, 0xda, 0x00, 0x02]),
    ]);
  };

  it("reads the JSON the service writes into the JPEG's comment", () => {
    expect(metadataOf(jpeg('{"duration":6}'))).toEqual({ duration: 6 });
  });

  it("is null for a JPEG without one", () => {
    expect(metadataOf(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
    expect(metadataOf(jpeg("not json"))).toBeNull();
  });
});

describe("framesOf", () => {
  it("reads each frame's timestamps, leaving out the null the service writes for a frame it could not decode", () => {
    const frames = [
      { timestamp_requested: 10, timestamp_actual: 9.5, rect: {} },
      null,
      { timestamp_requested: 30, timestamp_actual: 31 },
    ];
    expect(framesOf(frames)).toEqual([
      { requested: 10, actual: 9.5 },
      { requested: 30, actual: 31 },
    ]);
  });

  it("is empty without frames", () => {
    expect(framesOf(undefined)).toEqual([]);
  });
});
