// Downloads the pinned thumbs-collage release into `.service/`, as a Host would into the Plugin's data directory, for
// the tests that run the real service. With `--hash`, instead prints the SHA-256 of every archive of the release
// SERVICE_VERSION names, to paste into release.ts's ASSETS when moving to a new version.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS, assetUrl, ensureService, SERVICE_VERSION } from "../release.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The data directory the tests give the Worker, as the Host gives it `host.dataDir`. */
export const TEST_DATA_DIR = join(root, ".service");

if (import.meta.main) {
  if (process.argv.includes("--hash")) {
    for (const [target, asset] of Object.entries(ASSETS)) {
      const response = await fetch(assetUrl(asset));
      if (!response.ok) throw new Error(`${assetUrl(asset)}: ${response.status} ${response.statusText}`);
      const sha256 = createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex");
      console.log(
        `${target}  ${asset.name}  ${sha256}${sha256 === asset.sha256 ? "" : "  (differs from ASSETS)"}`,
      );
    }
  } else {
    const executable = await ensureService(join(TEST_DATA_DIR, "service"));
    console.log(`thumbs-collage ${SERVICE_VERSION} is at ${executable}`);
  }
}
