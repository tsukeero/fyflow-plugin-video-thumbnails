// Where a thumbnail goes, and what it says about itself. A Task's `output` is a file when it ends in .jpg or
// .jpeg and a folder otherwise; without one, the Profile's `outputDir`, else the Plugin's own folder in its data
// directory.
// In a folder the file is named after the video and a hash of everything that makes the thumbnail, so running a
// Task again on an unchanged video finds the thumbnail it made before.
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { absolute } from "./options.ts";

export interface OutputQuery {
  /** The Task's `output`: a .jpg/.jpeg file, or a folder. */
  output?: string | undefined;
  /** The Task's `outputDir`: the Profile's, or the Flow's or its Node's own. */
  outputDir?: string | undefined;
  /** The Plugin's own folder, for when neither says: absent when the Host gives the Plugin no data directory. */
  defaultDir?: string | undefined;
  video: string;
  /** The video's size and last change: a video replaced at the same path makes a new name. */
  stats: { size: number; mtimeMs: number };
  /** The service request, without its job id: what the thumbnail is made with. */
  request: unknown;
}

export interface Output {
  path: string;
  /** Whether the name was made here (and so a file already there may be reused), rather than given. */
  named: boolean;
}

export function outputOf({ output, outputDir, defaultDir, video, stats, request }: OutputQuery): Output {
  if (output !== undefined && !absolute(output))
    throw new Error(`\`output\` must be an absolute path: "${output}" is relative`);
  if (output === undefined && outputDir !== undefined && !absolute(outputDir))
    throw new Error(
      `\`outputDir\` must be an absolute path: "${outputDir}" is relative; fix it where it is set, in the fyflow-ext.video-thumbnail section of this Node's Profile or in the Flow's own values`,
    );
  if (output !== undefined && /\.jpe?g$/i.test(output)) return { path: resolve(output), named: false };
  const given = output ?? outputDir ?? defaultDir;
  if (given === undefined)
    throw new Error(
      "No folder to put the thumbnail in: this Host gives the Plugin no data directory, so set `output`, or `outputDir` in the fyflow-ext.video-thumbnail section of this Node's Profile",
    );
  const folder = resolve(given);
  const hash = createHash("sha256")
    .update(JSON.stringify({ video, size: stats.size, mtimeMs: stats.mtimeMs, request }))
    .digest("hex")
    .slice(0, 12);
  return { path: join(folder, `${basename(video, extname(video))}.${hash}.jpg`), named: true };
}

/**
 * The JSON the service writes into a JPEG's comment (COM) segment: the video, its duration, the collage's size and
 * each frame's timestamps. Null when there is none.
 */
export function metadataOf(jpeg: Uint8Array): unknown {
  const bytes = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Segments follow the start-of-image marker, each a marker and a length counting itself, until the image data.
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; ) {
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker === 0xda) return null;
    if (marker === 0xfe) {
      try {
        return JSON.parse(bytes.toString("utf8", at + 4, at + 2 + length));
      } catch {
        return null;
      }
    }
    at += 2 + length;
  }
  return null;
}

/**
 * Each frame's timestamps, from the metadata's `frames`: the requested one and the one used. The service writes null
 * for a frame it could not decode (it still makes the collage when at most a fifth are missing), and those are left
 * out.
 */
export function framesOf(frames: unknown): { requested: number; actual: number }[] {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter(
      (f): f is { timestamp_requested?: unknown; timestamp_actual?: unknown } =>
        f !== null && typeof f === "object",
    )
    .map((f) => ({
      requested: typeof f.timestamp_requested === "number" ? f.timestamp_requested : 0,
      actual: typeof f.timestamp_actual === "number" ? f.timestamp_actual : 0,
    }));
}
