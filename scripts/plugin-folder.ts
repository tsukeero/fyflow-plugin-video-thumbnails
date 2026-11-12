// Makes `dist/video-thumbnail/`: the Plugin as a Host loads it, and nothing else. It is the folder to pick with
// "Choose folder…" in the app, whose installer copies a folder whole and refuses one holding a link (pnpm's
// node_modules is made of them). The service is not in it: a Worker downloads it on first use (./release.ts).
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** What the Plugin needs at run time, beside a package.json of its own. */
const FILES = [
  "plugin.ts",
  "thumbnail.worker.ts",
  "video-files.worker.ts",
  "is-video.worker.ts",
  "formats.ts",
  "options.ts",
  "output.ts",
  "service.ts",
  "release.ts",
  "README.md",
  "LICENSE",
];
const FOLDERS = ["assets"];

/** Makes the Plugin folder at `to`, replacing what is there. */
export async function makePluginFolder(to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const name of FILES) await cp(join(root, name), join(to, name));
  // `dereference`: copied as files, so a linked file or folder never reaches the Host as a link.
  for (const name of FOLDERS)
    await cp(join(root, name), join(to, name), { recursive: true, dereference: true });
  const {
    devDependencies: _d,
    scripts: _s,
    packageManager: _p,
    engines: _e,
    ...manifest
  } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(to, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  const to = resolve(process.argv[2] ?? join(root, "dist", "video-thumbnail"));
  await makePluginFolder(to);
  console.log(`Made the Plugin folder ${to}: pick it with "Choose folder…" on the app's Plugins page`);
}
