import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containerOf, HEAD_BYTES, hasExtension, normalized, VIDEO_EXTENSIONS } from "../formats.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A head of `HEAD_BYTES` zeros with `parts` written at their offsets, each bytes or ASCII. */
const head = (...parts: [number, string | number[]][]) => {
  const bytes = new Uint8Array(HEAD_BYTES);
  for (const [at, part] of parts)
    bytes.set(typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part, at);
  return bytes;
};

describe("containerOf", () => {
  it("knows the fixture's MP4 by its ftyp box", async () => {
    const sample = await readFile(join(root, "test", "fixtures", "sample.mp4"));
    expect(containerOf(sample.subarray(0, HEAD_BYTES))).toBe("mp4");
  });

  it.each([
    ["mov", head([4, "moov"])],
    ["matroska", head([0, [0x1a, 0x45, 0xdf, 0xa3]])],
    ["avi", head([0, "RIFF"], [8, "AVI "])],
    ["asf", head([0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]])],
    ["flv", head([0, "FLV"])],
    ["mpeg-ps", head([0, [0, 0, 1, 0xba]])],
    ["mpeg-video", head([0, [0, 0, 1, 0xb3]])],
    ["mpeg-ts", head([0, [0x47]], [188, [0x47]])],
    ["m2ts", head([4, [0x47]], [196, [0x47]])],
    ["ogg", head([0, "OggS"])],
    ["realmedia", head([0, ".RMF"])],
  ])("knows %s", (container, bytes) => {
    expect(containerOf(bytes)).toBe(container);
  });

  it("refuses an audio-only MP4, a WAV, text, and a file too short to say", () => {
    expect(containerOf(head([4, "ftypM4A "]))).toBeNull();
    expect(containerOf(head([0, "RIFF"], [8, "WAVE"]))).toBeNull();
    expect(containerOf(new TextEncoder().encode("# not a video\n"))).toBeNull();
    expect(containerOf(new Uint8Array([0x47]))).toBeNull();
    expect(containerOf(new Uint8Array())).toBeNull();
  });
});

describe("hasExtension", () => {
  it("compares without case or a leading dot", () => {
    const wanted = normalized([".MKV", "mp4"]);
    expect(hasExtension("/videos/a.mkv", wanted)).toBe(true);
    expect(hasExtension("C:\\videos\\B.MP4", wanted)).toBe(true);
    expect(hasExtension("/videos/a.avi", wanted)).toBe(false);
    expect(hasExtension("/videos/mp4", wanted)).toBe(false);
  });

  it("has the common video extensions by default, and no audio or image ones", () => {
    const wanted = normalized(VIDEO_EXTENSIONS);
    for (const ext of ["mp4", "mkv", "mov", "webm", "avi", "ts", "rmvb"]) expect(wanted.has(ext)).toBe(true);
    for (const ext of ["mp3", "m4a", "wav", "jpg", "png", "gif"]) expect(wanted.has(ext)).toBe(false);
  });
});
