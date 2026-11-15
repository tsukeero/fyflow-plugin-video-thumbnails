import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataOf, serviceDir, thumbnailsDir } from "../data.ts";
import plugin from "../plugin.ts";
import { platformFolder, SERVICE_VERSION } from "../release.ts";

describe("dataOf", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "video-thumbnail-data-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("lists nothing in an empty data directory, or one that is not there yet", () => {
    const empty = {
      summary: `0 thumbnails; thumbnail service ${SERVICE_VERSION} not downloaded yet`,
      items: [],
    };
    expect(dataOf({ dataDir })).toEqual(empty);
    expect(dataOf({ dataDir: join(dataDir, "nowhere") })).toEqual(empty);
  });

  it("lists the thumbnails folder, this version's service, an older one and an unfinished download", async () => {
    await mkdir(thumbnailsDir(dataDir), { recursive: true });
    await writeFile(join(thumbnailsDir(dataDir), "a.0123456789ab.jpg"), "");
    await writeFile(join(thumbnailsDir(dataDir), "b.0123456789ab.jpg"), "");
    await writeFile(join(thumbnailsDir(dataDir), "b.0123456789ab.jpg.fyflow-1.part"), "");
    const current = platformFolder() ?? "thumbs-collage-unknown";
    for (const folder of [current, "thumbs-collage-0.0.1-test", ".download-1"])
      await mkdir(join(serviceDir(dataDir), folder), { recursive: true });

    const { summary, items } = dataOf({ dataDir });
    expect(items.map((i) => i.path).sort()).toEqual(
      ["thumbnails", `service/${current}`, "service/thumbs-collage-0.0.1-test", "service/.download-1"].sort(),
    );
    expect(items.find((i) => i.path === "thumbnails")?.label).toMatch(/^2 thumbnails /);
    expect(items.find((i) => i.path === "service/thumbs-collage-0.0.1-test")?.lost).toMatch(/^Nothing/);
    if (platformFolder() !== undefined)
      expect(summary).toBe(`2 thumbnails; thumbnail service ${SERVICE_VERSION} downloaded`);
  });

  it("is the Plugin's data()", () => {
    expect(plugin.data).toBe(dataOf);
  });
});
