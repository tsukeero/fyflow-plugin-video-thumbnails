import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installedExecutable } from "../release.ts";
import { TEST_DATA_DIR } from "../scripts/fetch-service.ts";
import { type Service, startService } from "../service.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const executable = installedExecutable(join(TEST_DATA_DIR, "service")) ?? "";
const video = join(root, "test", "fixtures", "sample.mp4");
const request = (jobId: string, path = video) => ({
  path,
  job_id: jobId,
  selection: { mode: "uniform", frames: 1 },
  collage: { mode: "grid", rows: 1, cols: 1, width: 160 },
});

const exited = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe.skipIf(!existsSync(executable))("startService (needs `pnpm fetch-service`)", () => {
  let service: Service | undefined;
  afterEach(async () => {
    await service?.stop();
    service = undefined;
  });

  it("starts the service on a free port and makes a JPEG, reporting its progress", async () => {
    service = await startService({ executable });
    expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const progress: number[] = [];
    const jpeg = await service.collage(request("p1"), { onProgress: (p) => progress.push(p) });
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(progress.at(-1)).toBe(1);
  });

  it("says what the service said when it fails or refuses a request", async () => {
    service = await startService({ executable });
    await expect(service.collage(request("e1", join(root, "missing.mp4")))).rejects.toThrow(
      /The thumbnail service failed \(500\): .+/,
    );
    await expect(service.collage({ path: video, selection: { mode: "bogus" } })).rejects.toThrow(
      /The thumbnail service refused the request \(422\): .*unknown variant `bogus`/,
    );
  });

  it("stops the service, and is gone afterwards", async () => {
    service = await startService({ executable });
    const { pid, url } = service;
    await service.stop();
    expect(exited(pid)).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("tells its owner, with the exit and the service's last words, when the service dies by itself", async () => {
    let died: Error | undefined;
    service = await startService({ executable, onExit: (error) => (died = error) });
    process.kill(service.pid);
    await expect.poll(() => died?.message).toMatch(/The thumbnail service exited unexpectedly/);
    expect(died?.message).toMatch(/Listening on/);
    await expect(service.collage(request("after"))).rejects.toThrow(/exited unexpectedly/);
  });

  it("refuses to start an executable that is not there, naming it", async () => {
    await expect(startService({ executable: join(root, "nope.exe") })).rejects.toThrow(/nope\.exe/);
  });
});
