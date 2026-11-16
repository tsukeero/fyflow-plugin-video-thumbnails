import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installedExecutable } from "../release.ts";
import { TEST_DATA_DIR } from "../scripts/fetch-service.ts";
import { acquireService, type Lease, type Service, startService } from "../service.ts";

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

// A fake service run by Node: no `pnpm fetch-service` needed.
const fake = { executable: process.execPath, args: [join(root, "test", "fake-service.ts")] };

describe("acquireService", () => {
  const leases: Lease[] = [];
  const acquire = async (
    onExit?: (error: Error) => void,
    key: typeof fake & { fontFile?: string } = fake,
  ) => {
    const lease = await acquireService(key, onExit);
    leases.push(lease);
    return lease;
  };
  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.release();
  });

  it("shares one process between leases, also while it is starting, and the last release stops it", async () => {
    const [a, b] = await Promise.all([acquire(), acquire()]);
    const c = await acquire();
    expect(b.pid).toBe(a.pid);
    expect(c.pid).toBe(a.pid);
    await a.release();
    await a.release();
    await b.release();
    expect(exited(a.pid)).toBe(false);
    await c.release();
    expect(exited(a.pid)).toBe(true);
    const d = await acquire();
    expect(d.pid).not.toBe(a.pid);
  });

  it("starts one process for each executable and font", async () => {
    const a = await acquire();
    const b = await acquire(undefined, { ...fake, fontFile: "other.ttf" });
    expect(b.pid).not.toBe(a.pid);
  });

  it("tells every holder when the process dies, and the next acquire starts a new one", async () => {
    const died: Error[] = [];
    const a = await acquire((error) => died.push(error));
    await acquire((error) => died.push(error));
    process.kill(a.pid);
    await expect.poll(() => died.length).toBe(2);
    expect(died[0]?.message).toMatch(/exited unexpectedly/);
    const c = await acquire();
    expect(c.pid).not.toBe(a.pid);
  });

  it("says a service without /frames or /scenes is older than 0.1.0, naming executablePath", async () => {
    const lease = await acquire();
    await expect(lease.frames({ path: "x" })).rejects.toThrow(
      /This thumbs-collage has no \/frames: it is older than 0\.1\.0\. Update it, or clear `executablePath`/,
    );
    await expect(lease.scenes({ path: "x" })).rejects.toThrow(/has no \/scenes/);
  });
});
