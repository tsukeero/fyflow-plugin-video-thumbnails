// The `VideoThumbnail` Worker. Its pool is inline with one instance per Profile, and that instance owns one
// thumbs-collage service: started in `setup()`, stopped in `teardown()`, and asked for every Task's thumbnail, so
// the decoding happens in the service's process, never on the Host's thread.
//
// `setup()`, `teardown()` and the constructor's second argument are fyflow's (its envelope worker calls them on the
// class a Plugin gives it), not yet promised by fyflow-plugin-sdk, which types only the constructor's config and
// `run`.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskEnvelope, Worker, WorkerContext } from "fyflow-plugin-sdk";
import { fieldOf, optionsOf, pathFrom, requestOf } from "./options.ts";
import { metadataOf, outputOf } from "./output.ts";
import { EXECUTABLE, type Service, serviceDir, startService } from "./service.ts";

/** A Profile's config: every field optional, each overriding where this Plugin looks by itself. */
export interface Config {
  executablePath?: string;
  fontFile?: string;
  outputDir?: string;
}

/** What fyflow hands a Worker beside its config: how it asks its pool to replace it. */
interface PoolContext {
  terminateWithError(error: Error, options?: { canRestart?: boolean }): void;
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
  frames?: { timestamp_requested?: number; timestamp_actual?: number }[];
}

const root = fileURLToPath(new URL(".", import.meta.url));

export default class VideoThumbnail implements Worker<Record<string, unknown>, unknown, ThumbnailResult> {
  readonly #config: Config;
  readonly #pool: PoolContext | undefined;
  #service: Service | undefined;

  constructor(config: Config, pool?: PoolContext) {
    this.#config = config;
    this.#pool = pool;
  }

  async setup(): Promise<void> {
    const executable = this.#config.executablePath ?? join(serviceDir(root), EXECUTABLE);
    if (!existsSync(executable))
      throw new Error(
        this.#config.executablePath === undefined
          ? `No thumbnail service at "${executable}": run \`pnpm copy-service\` in the Plugin's folder, or set \`executablePath\` on this Profile`
          : `No thumbnail service at "${executable}", the \`executablePath\` on this Profile`,
      );
    this.#service = await startService({
      executable,
      fontFile: this.#config.fontFile ?? join(root, "assets", "fonts", "DejaVuSans.ttf"),
      // Its Tasks in flight have failed already; the pool builds a new instance, and with it a new service.
      onExit: (error) => this.#pool?.terminateWithError(error, { canRestart: true }),
    });
  }

  async teardown(): Promise<void> {
    const service = this.#service;
    this.#service = undefined;
    await service?.stop();
  }

  async run(
    envelope: TaskEnvelope<Record<string, unknown>>,
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

    const stats = await stat(video).catch(() => {
      throw new Error(`No video at "${video}"`);
    });
    const target = outputOf({ output, outputDir: this.#config.outputDir, video, stats, request });
    if (target.named && overwrite !== true && existsSync(target.path)) {
      const result = resultOf(target.path, video, await readFile(target.path), true);
      context.sendProgress(1, "Reused the thumbnail made before");
      return result;
    }

    const service = this.#service;
    if (service === undefined)
      throw new Error("The thumbnail service is not running: this Worker was not set up");
    context.sendProgress(0, "Extracting frames");
    const jpeg = await service.collage(
      { ...request, job_id: jobId },
      { signal: context.signal, onProgress: (progress, message) => context.sendProgress(progress, message) },
    );
    // Written beside and then renamed, so a Task stopped halfway never leaves a partial file to be reused.
    await mkdir(dirname(target.path), { recursive: true });
    const partial = `${target.path}.${jobId}.part`;
    try {
      await writeFile(partial, jpeg);
      await rename(partial, target.path);
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
    frames: (meta.frames ?? []).map((f) => ({
      requested: f.timestamp_requested ?? 0,
      actual: f.timestamp_actual ?? 0,
    })),
    reused,
  };
}
