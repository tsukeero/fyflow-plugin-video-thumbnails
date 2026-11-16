// ensureService against a release served from here: an archive made on the spot, so no network is needed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentDownload, type Download, onActivity } from "../activity.ts";
import { ASSETS, type Asset, ensureService, installedExecutable, SERVICE_VERSION } from "../release.ts";
import { EXECUTABLE } from "../service.ts";

const tar =
  process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

describe("ensureService", () => {
  let dir: string;
  let server: Server;
  let url: string;
  let asset: Asset;
  let requests = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "video-thumbnail-release-"));
    const name = "thumbs-collage-9.9.9-test";
    await mkdir(join(dir, "src", name), { recursive: true });
    await writeFile(join(dir, "src", name, EXECUTABLE), "not really an executable");
    const archive = join(dir, `${name}.tar.gz`);
    const made = spawnSync(tar, ["-czf", archive, "-C", join(dir, "src"), name]);
    expect(made.status).toBe(0);
    const bytes = await readFile(archive);
    asset = { name: `${name}.tar.gz`, sha256: createHash("sha256").update(bytes).digest("hex") };
    server = createServer((_request, response) => {
      requests++;
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/archive`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads, checks and unpacks the release once, however many ask at the same time", async () => {
    const to = join(dir, "data");
    requests = 0;
    const seen: (Download | undefined)[] = [];
    const stop = onActivity(() => seen.push(currentDownload()));
    const [a, b] = await Promise.all([ensureService(to, { asset, url }), ensureService(to, { asset, url })]);
    stop();
    // Its progress is passed on as it goes, for the Plugin's status and the Tasks waiting, and cleared at the end.
    expect(seen[0]).toEqual({ version: SERVICE_VERSION, received: 0, total: expect.any(Number) });
    expect(seen.at(-1)).toBeUndefined();
    expect(currentDownload()).toBeUndefined();
    expect(a).toBe(join(to, "thumbs-collage-9.9.9-test", EXECUTABLE));
    expect(b).toBe(a);
    expect(a).toBe(installedExecutable(to, asset));
    expect(await readFile(a, "utf8")).toBe("not really an executable");
    expect(requests).toBe(1);
    // Nothing left of the download beside the unpacked folder.
    expect(await readdir(to)).toEqual(["thumbs-collage-9.9.9-test"]);

    expect(await ensureService(to, { asset, url })).toBe(a);
    expect(requests).toBe(1);
  });

  it("refuses an archive whose SHA-256 is not the pinned one, and keeps nothing of it", async () => {
    const to = join(dir, "tampered");
    await expect(ensureService(to, { asset: { ...asset, sha256: "0".repeat(64) }, url })).rejects.toThrow(
      /not the one this Plugin pins: its SHA-256 is [0-9a-f]{64}, not 0{64}/,
    );
    expect(existsSync(join(to, "thumbs-collage-9.9.9-test"))).toBe(false);
  });

  it("gives up after its attempts when the download fails", async () => {
    await expect(
      ensureService(join(dir, "nowhere"), { asset, url: "http://127.0.0.1:1/archive", attempts: 1 }),
    ).rejects.toThrow(/Could not download the thumbnail service from http:\/\/127\.0\.0\.1:1\/archive/);
  });

  it(`pins an archive of ${SERVICE_VERSION} for each platform the release has`, () => {
    expect(Object.keys(ASSETS).sort()).toEqual(["darwin-arm64", "linux-x64", "win32-x64"]);
    for (const { name, sha256 } of Object.values(ASSETS)) {
      expect(name).toContain(`-${SERVICE_VERSION}-`);
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
