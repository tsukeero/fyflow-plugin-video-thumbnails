// What the three Workers that ask the thumbs-collage service (`VideoThumbnail`, `ExtractFrames`, `DetectScenes`)
// share: their Profile fields, and a lease on the one service for their executable and font, taken in `setup()` and
// let go in `teardown()`. Their pools are inline, so they share this module, and with it the service, on the Host's
// thread; the decoding happens in the service's process.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig, PoolContext, TaskEnvelope } from "fyflow-plugin-sdk";
import { serviceDir } from "./data.ts";
import { ensureService } from "./release.ts";
import { acquireService, type Lease } from "./service.ts";

/** The Profile's start-up fields: every one optional, each overriding where this Plugin looks by itself. */
export interface Config {
  /**
   * The Plugin's data directory, where the service is downloaded to and its output goes by default; the Host gives
   * it (`dataDir: true`).
   */
  host?: HostConfig;
  executablePath?: string;
  fontFile?: string;
}

/** The Profile's per-Task fields, under each Task's `settings.profile`; a Flow or its Node may set its own. */
export interface ProfileFields {
  outputDir?: string;
}

const root = fileURLToPath(new URL(".", import.meta.url));
const BUNDLED_FONT = join(root, "assets", "fonts", "DejaVuSans.ttf");

export class ServiceWorker {
  protected readonly config: Config;
  readonly #pool: PoolContext | undefined;
  #lease: Lease | undefined;

  constructor(config: Config, pool?: PoolContext) {
    this.config = config;
    this.#pool = pool;
  }

  async setup(): Promise<void> {
    this.#lease = await acquireService(
      { executable: await this.#executable(), fontFile: this.config.fontFile ?? BUNDLED_FONT },
      // Its Tasks in flight have failed already; the pool builds a new instance, which starts a new service.
      (error) => this.#pool?.terminateWithError(error, { canRestart: true }),
    );
  }

  /** The Profile's `executablePath`, else the pinned release, downloaded into the Plugin's data directory once. */
  async #executable(): Promise<string> {
    const given = this.config.executablePath;
    if (given !== undefined) {
      if (!existsSync(given))
        throw new Error(
          `No thumbnail service at "${given}", the \`executablePath\` in the fyflow-ext.video-thumbnail section of this Node's Profile`,
        );
      return given;
    }
    const dataDir = this.config.host?.dataDir;
    if (dataDir === undefined)
      throw new Error(
        "No data directory to download the thumbnail service to: this Host is older than fyflow-plugin-sdk 0.6.0. Set `executablePath` in the fyflow-ext.video-thumbnail section of this Node's Profile",
      );
    return ensureService(serviceDir(dataDir));
  }

  async teardown(): Promise<void> {
    const lease = this.#lease;
    this.#lease = undefined;
    await lease?.release();
  }

  /** The service, between `setup()` and `teardown()`. */
  protected get service(): Lease {
    if (this.#lease === undefined)
      throw new Error("The thumbnail service is not running: this Worker was not set up");
    return this.#lease;
  }

  /** The folder the Plugin keeps this Worker's output in by default, under `name` in its data directory. */
  protected ownDir(name: string): string | undefined {
    const dataDir = this.config.host?.dataDir;
    return dataDir === undefined ? undefined : join(dataDir, name);
  }
}

/** The Profile's `outputDir`, checked; absent when fyflow runs a Worker without a Host, which is what adds `profile`. */
export function outputDirOf(
  envelope: TaskEnvelope<Record<string, unknown>, unknown, ProfileFields>,
): string | undefined {
  const outputDir: unknown = envelope.settings.profile?.outputDir;
  if (outputDir !== undefined && typeof outputDir !== "string")
    throw new Error(`\`outputDir\` must be a path, not ${JSON.stringify(outputDir)}`);
  return outputDir;
}
