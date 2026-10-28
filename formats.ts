// Which files are videos: by extension, and by the signature at the start of the file. A signature says which
// container a file is, not that it holds a video stream: an .mkv or .ogv may hold only audio. Audio-only MP4s say
// so in their brand, and are refused.
import { open } from "node:fs/promises";
import { extname } from "node:path";

/** The extensions a video has unless a Node says otherwise: those FFmpeg reads that are mostly video. */
export const VIDEO_EXTENSIONS: readonly string[] = Object.freeze([
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "asf",
  "flv",
  "f4v",
  "mpg",
  "mpeg",
  "m2ts",
  "mts",
  "ts",
  "3gp",
  "3g2",
  "ogv",
  "vob",
  "rm",
  "rmvb",
  "divx",
]);

/** How much of a file its signature is read from: enough for two MPEG-TS packets of 192 bytes. */
export const HEAD_BYTES = 512;

/** `extensions` as they are compared: lower case, without a leading dot. */
export function normalized(extensions: readonly string[]): Set<string> {
  return new Set(extensions.map((e) => e.replace(/^\./, "").toLowerCase()));
}

/** Whether `path`'s extension is one of `extensions` (from `normalized`). */
export function hasExtension(path: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(path).slice(1).toLowerCase());
}

/** ISO base media (MP4, MOV, 3GP) brands of audio-only files: iTunes audio, audiobooks, protected audio. */
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P "]);

/** The first box types of a QuickTime file older than `ftyp`. */
const QUICKTIME_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

const ASF = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11];

/** The video container `head` (a file's first bytes) starts as, or null when it is none of them. */
export function containerOf(head: Uint8Array): string | null {
  const ascii = (from: number, length: number) =>
    String.fromCharCode(...head.subarray(from, from + length)).padEnd(length, "\0");
  const at = (from: number, bytes: readonly number[]) => bytes.every((b, i) => head[from + i] === b);

  if (ascii(4, 4) === "ftyp") return AUDIO_BRANDS.has(ascii(8, 4)) ? null : "mp4";
  if (QUICKTIME_BOXES.has(ascii(4, 4))) return "mov";
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "matroska";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return "avi";
  if (at(0, ASF)) return "asf";
  if (ascii(0, 3) === "FLV") return "flv";
  if (at(0, [0x00, 0x00, 0x01, 0xba])) return "mpeg-ps";
  if (at(0, [0x00, 0x00, 0x01, 0xb3])) return "mpeg-video";
  if (head[0] === 0x47 && head[188] === 0x47) return "mpeg-ts";
  if (head[4] === 0x47 && head[196] === 0x47) return "m2ts";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === ".RMF") return "realmedia";
  return null;
}

/** The first `HEAD_BYTES` of the file at `path`, or fewer if it is shorter. */
export async function headOf(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
