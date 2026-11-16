// What the three Workers that ask the thumbs-collage service (`VideoThumbnail`, `ExtractFrames`, `DetectScenes`)
// share: their Profile fields, and a lease on the one service for their executable and font, let go in `teardown()`.
// `setup()` checks what it can at once and starts getting the lease, downloading the service first if it must; the
// first Tasks wait for it, saying what they wait for in their progress, since `setup()` has no Task to report to.
// Their pools are inline, so they share this module, and with it the service, on the Host's thread; the decoding
// happens in the service's process.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig, PoolContext, TaskEnvelope, WorkerContext } from "fyflow-plugin-sdk";
import { bytesOf, currentDownload, onActivity, setFailure } from "./activity.ts";
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
  /** The lease, once `setup()` has started getting it; rejected if the service could not be had. */
  #ready: Promise<Lease> | undefined;
  #lease: Lease | undefined;

  constructor(config: Config, pool?: PoolContext) {
    this.config = config;
    this.#pool = pool;
  }

  /**
   * Fails at once if there is no service to be had (no executable at the Profile's `executablePath`, nowhere to
   * download one to); otherwise starts getting the lease and returns without waiting for it.
   */
  async setup(): Promise<void> {
    const executable = this.#executable();
    const ready = executable().then((path) =>
      acquireService(
        { executable: path, fontFile: this.config.fontFile ?? BUNDLED_FONT },
        // Its Tasks in flight have failed already; the pool builds a new instance, which starts a new service.
        (error) => this.#pool?.terminateWithError(error, { canRestart: true }),
      ),
    );
    ready.then(
      (lease) => {
        this.#lease = lease;
      },
      // A failed download is kept for the Plugin's status; a failed start is kept by `acquireService`.
      (error: Error) => setFailure(error),
    );
    this.#ready = ready;
  }

  /**
   * How to get the service's executable: the Profile's `executablePath`, else the pinned release, downloaded into the
   * Plugin's data directory once. Refused at once when neither can be had.
   */
  #executable(): () => Promise<string> {
    const given = this.config.executablePath;
    if (given !== undefined) {
      if (!existsSync(given))
        throw new Error(
          `No thumbnail service at "${given}", the \`executablePath\` in the fyflow-ext.video-thumbnail section of this Node's Profile`,
        );
      return () => Promise.resolve(given);
    }
    const dataDir = this.config.host?.dataDir;
    if (dataDir === undefined)
      throw new Error(
        "No data directory to download the thumbnail service to: this Host is older than fyflow-plugin-sdk 0.6.0. Set `executablePath` in the fyflow-ext.video-thumbnail section of this Node's Profile",
      );
    return () => ensureService(serviceDir(dataDir));
  }

  async teardown(): Promise<void> {
    const ready = this.#ready;
    this.#ready = undefined;
    this.#lease = undefined;
    // A lease still coming is let go once it comes.
    const lease = await ready?.catch(() => undefined);
    await lease?.release();
  }

  /**
   * The service, once it is ready: a Task that comes before it says in its progress what it waits for (the
   * download, then the start). Refused if this Worker was not set up, or the service could not be had.
   */
  protected async service(context: WorkerContext): Promise<Lease> {
    if (this.#lease !== undefined) return this.#lease;
    const ready = this.#ready;
    if (ready === undefined)
      throw new Error("The thumbnail service is not running: this Worker was not set up");
    const report = () => {
      const download = currentDownload();
      context.sendProgress(
        0,
        download === undefined
          ? "Starting the thumbnail service"
          : `Downloading the thumbnail service, thumbs-collage ${download.version} (${bytesOf(download)})`,
      );
    };
    const stop = onActivity(report);
    report();
    try {
      return await abortable(ready, context.signal);
    } finally {
      stop();
    }
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

/** `promise`, or its rejection with the signal's reason once `signal` aborts, whichever comes first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
