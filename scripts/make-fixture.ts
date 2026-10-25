// Makes `test/fixtures/sample.mp4`: 6 s of 320x180 H.264, one second of solid black and then ffmpeg's test pattern
// with a running timer, so a test can see blank frames skipped. The clip is committed; this only remakes it. Uses
// the ffmpeg in `$FFMPEG_DIR/bin`, else the one on the PATH.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const fromDir = process.env.FFMPEG_DIR === undefined ? undefined : join(process.env.FFMPEG_DIR, "bin", exe);
const ffmpeg = fromDir !== undefined && existsSync(fromDir) ? fromDir : exe;
const out = fileURLToPath(new URL("../test/fixtures/sample.mp4", import.meta.url));

execFileSync(
  ffmpeg,
  [
    ...["-y", "-hide_banner", "-loglevel", "error"],
    ...["-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=1"],
    ...["-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=5"],
    ...["-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-crf", "30", "-movflags", "+faststart"],
    out,
  ],
  { stdio: "inherit" },
);
console.log(`Wrote ${out}`);
