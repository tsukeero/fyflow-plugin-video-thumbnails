// Where a thumbnail goes, and what it says about itself. A Task's `output` is a file when it ends in .jpg or
// .jpeg and a folder otherwise; without one, the Profile's `outputDir`, else a folder in the system's temp folder.
// In a folder the file is named after the video and a hash of everything that makes the thumbnail, so running a
// Task again on an unchanged video finds the thumbnail it made before.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { absolute } from "./options.ts";

/** Where thumbnails go when neither the Task nor its Profile says: the OS may clean it up, so it is not storage. */
export const DEFAULT_OUTPUT_DIR = join(tmpdir(), "fyflow-video-thumbnails");

export interface OutputQuery {
  /** The Task's `output`: a .jpg/.jpeg file, or a folder. */
  output?: string | undefined;
  /** The Profile's `outputDir`. */
  outputDir?: string | undefined;
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

export function outputOf({ output, outputDir, video, stats, request }: OutputQuery): Output {
  if (output !== undefined && !absolute(output))
    throw new Error(`\`output\` must be an absolute path: "${output}" is relative`);
  if (output === undefined && outputDir !== undefined && !absolute(outputDir))
    throw new Error(
      `\`outputDir\` on this Profile must be an absolute path: "${outputDir}" is relative; fix the Profile`,
    );
  if (output !== undefined && /\.jpe?g$/i.test(output)) return { path: resolve(output), named: false };
  const folder = resolve(output ?? outputDir ?? DEFAULT_OUTPUT_DIR);
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
