// The Plugin's status, through the service's life: not downloaded, downloading, starting, running, failed. The service
// is the fake one (./fake-service.ts), run with Node, so no download is needed.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setDownload, setFailure } from "../activity.ts";
import { serviceDir } from "../data.ts";
import { installedExecutable, platformFolder, SERVICE_VERSION } from "../release.ts";
import { acquireService, type Lease } from "../service.ts";
import { status } from "../status.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fake = { executable: process.execPath, args: [join(root, "test", "fake-service.ts")] };
const detail = (s: ReturnType<typeof status>, label: string) =>
  s.details?.find((d) => d.label === label)?.value;

describe.skipIf(platformFolder() === undefined)("status", () => {
  let dataDir: string;
  const leases: Lease[] = [];
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "video-thumbnail-status-"));
  });
  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.release();
    setDownload(undefined);
    setFailure(undefined);
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("says the first Task downloads the service, until it is downloaded", async () => {
    expect(status({ dataDir })).toEqual({
      level: "ok",
      summary: `thumbs-collage ${SERVICE_VERSION} not downloaded yet: the first Task downloads it`,
      details: [{ label: "Downloaded to", value: installedExecutable(serviceDir(dataDir)) }],
    });
    const executable = installedExecutable(serviceDir(dataDir)) as string;
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "");
    expect(status({ dataDir }).summary).toBe(
      `thumbs-collage ${SERVICE_VERSION} not running: the next Task starts it`,
    );
  });

  it("says how far a download is", () => {
    setDownload({ version: SERVICE_VERSION, received: 12_345_678, total: 40_100_000 });
    const s = status({ dataDir });
    expect(s.level).toBe("info");
    expect(s.summary).toBe(
      `Downloading thumbs-collage ${SERVICE_VERSION} (12.3 of 40.1 MB): Tasks start once it is ready`,
    );
    setDownload({ version: SERVICE_VERSION, received: 1_000_000, total: undefined });
    expect(detail(status({ dataDir }), "Downloaded")).toBe("1.0 MB");
  });

  it("says the service is starting, then running with its process and jobs, then not running once let go", async () => {
    const acquiring = acquireService(fake);
    expect(status({ dataDir })).toMatchObject({
      level: "info",
      summary: "Starting thumbs-collage: Tasks start once it is ready",
    });
    const lease = await acquiring;
    leases.push(lease);
    const s = status({ dataDir });
    expect(s).toMatchObject({ level: "ok", summary: "thumbs-collage running · 0 jobs in flight" });
    expect(detail(s, "Process")).toBe(String(lease.pid));
    expect(detail(s, "Address")).toBe(lease.url);
    expect(detail(s, "Executable")).toBe(process.execPath);
    // The fake answers every request at once, with a 404: a job is in flight only until then.
    const job = lease.frames({ path: "x" }).catch(() => {});
    expect(status({ dataDir }).summary).toBe("thumbs-collage running · 1 job in flight");
    await job;
    await lease.release();
    leases.splice(0);
    expect(status({ dataDir }).summary).toMatch(/not (running|downloaded yet)/);
  });

  it("tells several services apart", async () => {
    leases.push(await acquireService(fake), await acquireService({ ...fake, fontFile: "other.ttf" }));
    const s = status({ dataDir });
    expect(s.summary).toBe("2 thumbs-collage services running · 0 jobs in flight");
    expect(detail(s, "Service 2: Process")).toBe(String(leases[1]?.pid));
  });

  it("warns with the last failure, its first line, until a service starts", async () => {
    await expect(acquireService({ executable: join(root, "nowhere") })).rejects.toThrow();
    const s = status({ dataDir });
    expect(s.level).toBe("warning");
    expect(s.summary).toMatch(/^thumbs-collage failed: Could not start the thumbnail service ".*nowhere"/);
    expect(detail(s, "Last failure")).not.toContain("\n");
    leases.push(await acquireService(fake));
    expect(status({ dataDir }).level).toBe("ok");
  });

  it("warns when a running service dies", async () => {
    const lease = await acquireService(fake, () => {});
    process.kill(lease.pid);
    await expect.poll(() => status({ dataDir }).level).toBe("warning");
    expect(status({ dataDir }).summary).toMatch(
      /^thumbs-collage failed: The thumbnail service exited unexpectedly/,
    );
    await lease.release();
  });
});
