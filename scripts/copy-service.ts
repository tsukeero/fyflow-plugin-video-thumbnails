// Copies the thumbs-collage service (its executable and the FFmpeg libraries beside it) into `bin/<platform>-<arch>/`,
// where the Worker looks for it. The source is a release build of rust-thumbnail-service-public, by default the
// sibling checkout's `target/release`; pass another folder as the first argument.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceDir } from "../service.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const from = resolve(process.argv[2] ?? join(root, "../rust-thumbnail-service-public/target/release"));
const to = serviceDir(root);

/** The service's own files on this platform: its executable and the shared libraries it loads. */
const isServiceFile = (name: string) =>
  process.platform === "win32"
    ? name === "thumbs-collage.exe" || name.endsWith(".dll")
    : name === "thumbs-collage" || /\.(so(\.\d+)*|dylib)$/.test(name);

const names = (await readdir(from, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && isServiceFile(entry.name))
  .map((entry) => entry.name);
if (!names.some((name) => name.startsWith("thumbs-collage")))
  throw new Error(
    `No thumbs-collage executable in ${from}: build the service with \`cargo build --release\``,
  );

await mkdir(to, { recursive: true });
for (const name of names) await copyFile(join(from, name), join(to, name));
console.log(`Copied ${names.length} files from ${from} to ${to}:\n  ${names.join("\n  ")}`);
