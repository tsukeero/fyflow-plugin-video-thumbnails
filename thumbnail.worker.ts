// The `VideoThumbnail` Worker. Its pool is inline with one instance per Profile, and that instance owns one
// thumbs-collage service: started in `setup()`, stopped in `teardown()`, and asked for every Task's thumbnail, so
// the decoding happens in the service's process, never on the Host's thread.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedPath,
  type HostConfig,
  type PoolContext,
  type TaskEnvelope,
  type Worker,
  type WorkerContext,
} from "fyflow-plugin-sdk";
import { serviceDir, thumbnailsDir } from "./data.ts";
import { fieldOf, optionsOf, pathFrom, requestOf } from "./options.ts";
import { framesOf, metadataOf, outputOf } from "./output.ts";
import { ensureService } from "./release.ts";
import { type Service, startService } from "./service.ts";

/** The Profile's start-up fields: every one optional, each overriding where this Plugin looks by itself. */
export interface Config {
  /**
   * The Plugin's data directory, where the service is downloaded to and thumbnails go by default; the Host gives it
   * (`dataDir: true`).
   */
  host?: HostConfig;
  executablePath?: string;
  fontFile?: string;
}

/** The Profile's per-Task fields, under each Task's `settings.profile`; a Flow or its Node may set its own. */
export interface ProfileFields {
  outputDir?: string;
}

export interface ThumbnailResult {
  /** The thumbnail's absolute path. */
  path: string;
  /** The video's absolute path. */
  video: string;
  /** The video's length, in seconds. */
  duration: number;
  width: number;
  height: number;
  /** Each frame's timestamp, in seconds: the one asked for, and the one used after skipping blank frames. */
  frames: { requested: number; actual: number }[];
  /** Whether the thumbnail was already there from an earlier Task, rather than made by this one. */
  reused: boolean;
}

interface Metadata {
  duration?: number;
  size?: { w?: number; h?: number };
  frames?: unknown;
}

const root = fileURLToPath(new URL(".", import.meta.url));

export default class VideoThumbnail
  implements Worker<Record<string, unknown>, unknown, ThumbnailResult, ProfileFields>
{
  readonly #config: Config;
  readonly #pool: PoolContext | undefined;
  #service: Service | undefined;

  constructor(config: Config, pool?: PoolContext) {
    this.#config = config;
    this.#pool = pool;
  }

  async setup(): Promise<void> {
    const executable = await this.#executable();
    this.#service = await startService({
      executable,
      fontFile: this.#config.fontFile ?? join(root, "assets", "fonts", "DejaVuSans.ttf"),
      // Its Tasks in flight have failed already; the pool builds a new instance, and with it a new service.
      onExit: (error) => this.#pool?.terminateWithError(error, { canRestart: true }),
    });
  }

  /** The Profile's `executablePath`, else the pinned release, downloaded into the Plugin's data directory once. */
  async #executable(): Promise<string> {
    const given = this.#config.executablePath;
    if (given !== undefined) {
      if (!existsSync(given))
        throw new Error(
          `No thumbnail service at "${given}", the \`executablePath\` in the fyflow-ext.video-thumbnail section of this Node's Profile`,
        );
      return given;
    }
    const dataDir = this.#config.host?.dataDir;
    if (dataDir === undefined)
      throw new Error(
        "No data directory to download the thumbnail service to: this Host is older than fyflow-plugin-sdk 0.6.0. Set `executablePath` in the fyflow-ext.video-thumbnail section of this Node's Profile",
      );
    return ensureService(serviceDir(dataDir));
  }

  async teardown(): Promise<void> {
    const service = this.#service;
    this.#service = undefined;
    await service?.stop();
  }

  async run(
    envelope: TaskEnvelope<Record<string, unknown>, unknown, ProfileFields>,
    context: WorkerContext,
  ): Promise<ThumbnailResult> {
    context.signal.throwIfAborted();
    const video = pathFrom(envelope, "path");
    const options = optionsOf(envelope);
    const jobId = `fyflow-${randomUUID()}`;
    const { job_id: _, ...request } = requestOf(video, options, jobId);
    const output = fieldOf(envelope, "output");
    if (output !== undefined && typeof output !== "string")
      throw new Error(`\`output\` must be a path, not ${JSON.stringify(output)}`);
    const overwrite = fieldOf(envelope, "overwrite");
    if (overwrite !== undefined && typeof overwrite !== "boolean")
      throw new Error(`\`overwrite\` must be true or false, not ${JSON.stringify(overwrite)}`);
    // Absent when fyflow runs this Worker without a Host, which is what adds `profile`.
    const outputDir: unknown = envelope.settings.profile?.outputDir;
    if (outputDir !== undefined && typeof outputDir !== "string")
      throw new Error(`\`outputDir\` must be a path, not ${JSON.stringify(outputDir)}`);

    // Every path a Flow can name is checked against the Task's Allowed roots, and used where it really leads.
    const { roots } = envelope.settings;
    const readable = await allowedPath(roots, video, "read");
    const stats = await stat(readable).catch(() => {
      throw new Error(`No video at "${video}"`);
    });
    const dataDir = this.#config.host?.dataDir;
    const defaultDir = dataDir === undefined ? undefined : thumbnailsDir(dataDir);
    const target = outputOf({ output, outputDir, defaultDir, video, stats, request });
    // The Plugin's own folder in its data directory is no path a Flow names, so it needs no root.
    const writable =
      output === undefined && outputDir === undefined
        ? target.path
        : await allowedPath(roots, target.path, "write");
    if (target.named && overwrite !== true && existsSync(writable)) {
      const result = resultOf(target.path, video, await readFile(writable), true);
      context.sendProgress(1, "Reused the thumbnail made before");
      return result;
    }

    const service = this.#service;
    if (service === undefined)
      throw new Error("The thumbnail service is not running: this Worker was not set up");
    context.sendProgress(0, "Extracting frames");
    const jpeg = await service.collage(
      { ...request, path: readable, job_id: jobId },
      { signal: context.signal, onProgress: (progress, message) => context.sendProgress(progress, message) },
    );
    // Written beside and then renamed, so a Task stopped halfway never leaves a partial file to be reused.
    await mkdir(dirname(writable), { recursive: true });
    const partial = `${writable}.${jobId}.part`;
    try {
      await writeFile(partial, jpeg);
      await rename(partial, writable);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return resultOf(target.path, video, jpeg, false);
  }
}

/** The Task's result, from the metadata the service wrote into the JPEG. */
function resultOf(path: string, video: string, jpeg: Uint8Array, reused: boolean): ThumbnailResult {
  const meta = metadataOf(jpeg) as Metadata | null;
  if (meta === null)
    throw new Error(`"${path}" has no thumbnail metadata: it was not made by the thumbnail service`);
  return {
    path,
    video,
    duration: meta.duration ?? 0,
    width: meta.size?.w ?? 0,
    height: meta.size?.h ?? 0,
    frames: framesOf(meta.frames),
    reused,
  };
}
