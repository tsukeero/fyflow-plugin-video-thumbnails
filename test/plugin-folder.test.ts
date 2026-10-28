import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePluginFolder } from "../scripts/plugin-folder.ts";
import { EXECUTABLE, serviceDir } from "../service.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every entry under `dir`, as the app's installer walks it: links are reported, never followed. */
async function entriesOf(dir: string): Promise<{ path: string; link: boolean }[]> {
  const found: { path: string; link: boolean }[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const entry = await lstat(path);
    found.push({ path: relative(dir, path).replace(/\\/g, "/"), link: entry.isSymbolicLink() });
    if (entry.isDirectory() && !entry.isSymbolicLink())
      found.push(...(await entriesOf(path)).map((e) => ({ ...e, path: `${name}/${e.path}` })));
  }
  return found;
}

describe.skipIf(!existsSync(join(serviceDir(root), EXECUTABLE)))(
  "makePluginFolder (needs `pnpm copy-service`)",
  () => {
    let to: string;
    beforeAll(async () => {
      to = join(await mkdtemp(join(tmpdir(), "video-thumbnail-folder-")), "video-thumbnail");
      await makePluginFolder(to);
    });
    afterAll(async () => {
      await rm(join(to, ".."), { recursive: true, force: true });
    });

    it("holds the Plugin's code, its font and its service, and nothing a Host does not load", async () => {
      const paths = (await entriesOf(to)).map((e) => e.path);
      expect(paths.filter((p) => !p.includes("/"))).toEqual(
        expect.arrayContaining(["plugin.ts", "thumbnail.worker.ts", "options.ts", "output.ts", "service.ts"]),
      );
      expect(paths).toContain("assets/fonts/DejaVuSans.ttf");
      expect(paths).toContain(`bin/${process.platform}-${process.arch}/${EXECUTABLE}`);
      for (const left of ["node_modules", "test", "scripts", ".git", "pnpm-lock.yaml", "tsconfig.json"])
        expect(paths.some((p) => p === left || p.startsWith(`${left}/`))).toBe(false);
    });

    it("holds no link, which the app's installer refuses", async () => {
      expect((await entriesOf(to)).filter((e) => e.link)).toEqual([]);
    });

    it("has a package.json with the SDK as its only dependency, a peer", async () => {
      const manifest = JSON.parse(await readFile(join(to, "package.json"), "utf8"));
      expect(manifest.peerDependencies).toEqual({ "fyflow-plugin-sdk": "^0.5.0" });
      expect(manifest.devDependencies).toBeUndefined();
      expect(manifest.scripts).toBeUndefined();
    });
  },
);
