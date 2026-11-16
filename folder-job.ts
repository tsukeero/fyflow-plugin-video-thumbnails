// What `ExtractFrames` and `DetectScenes` share: the options for the images they write, and the folder a job writes
// into. Each job gets `<base>/<video name>.<hash>/`, holding its images and a manifest (`frames.json`,
// `scenes.json`). The service writes into a staging folder beside it, `<folder>.<job id>.part`, the manifest is
// added, and the staging folder is renamed into place: a folder with the job's name is always complete, and an
// earlier one is reused rather than made again.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowedPath, type TaskEnvelope, type WorkerContext } from "fyflow-plugin-sdk";
import { bool, defined, fieldOf, integer, object, oneOf, only, pathFrom } from "./options.ts";
import { baseOf, nameOf } from "./output.ts";
import { outputDirOf, type ProfileFields } from "./service-worker.ts";

type Envelope = TaskEnvelope<Record<string, unknown>, unknown, ProfileFields>;

export type Lists = "file" | "result";

/** `lists`: whether the result carries the lists (`result`), or only the manifest's path (`file`, the default). */
export function listsOf(envelope: Envelope): Lists {
  const lists = fieldOf(envelope, "lists") ?? "file";
  oneOf("lists", lists, ["file", "result"]);
  return lists as Lists;
}

/** The image options' names, as Node settings and Task input fields. */
export const IMAGE_KEYS = ["width", "height", "fit", "format", "quality"] as const;

/**
 * The images' size, format and quality in the service's terms (`size`, `format`, `quality`), from `options`: 640 wide
 * when neither side is set, fitted with `contain` unless told otherwise.
 */
export function imageOf(name: string, options: Record<string, unknown>): Record<string, unknown> {
  const { width, height, fit, format, quality } = options;
  const at = (key: string) => (name === "" ? key : `${name}.${key}`);
  if (width !== undefined) integer(at("width"), width, 1);
  if (height !== undefined) integer(at("height"), height, 1);
  if (fit !== undefined) oneOf(at("fit"), fit, ["cover", "contain", "stretch"]);
  if (format !== undefined) oneOf(at("format"), format, ["jpeg", "png"]);
  if (quality !== undefined) {
    integer(at("quality"), quality, 1);
    if ((quality as number) > 100)
      throw new Error(`\`${at("quality")}\` must be at most 100, not ${quality}`);
  }
  return defined({
    size: defined({
      width: width === undefined && height === undefined ? 640 : width,
      height,
      fit: fit ?? "contain",
    }),
    format: format ?? "jpeg",
    quality,
  });
}

/** `value`, the option `name`, as an object: refused, saying why, unless it is one with no keys beyond `keys`. */
export function objectOf(name: string, value: unknown, keys: string[]): Record<string, unknown> {
  const o = object(name, value);
  only(name, o, undefined, keys);
  return o;
}

export interface FolderJob<M> {
  envelope: Envelope;
  context: WorkerContext;
  /** The Plugin's own folder for this Node Type, in its data directory; absent without one. */
  ownDir: string | undefined;
  /** `frames.json` or `scenes.json`. */
  manifestName: string;
  /** What goes in the folder, for errors: "the frames". */
  what: string;
  /** Progress when the folder is there already: "Reused the frames extracted before". */
  reusedMessage: string;
  /** Progress as the job starts. */
  startMessage: string;
  /** Progress once the folder is in place: the service's own last update may come after its reply, and be lost. */
  doneMessage: string;
  /** The service request without `path`, `job_id` and the output: what the folder's name is made from. */
  request: Record<string, unknown>;
  /** Asks the service for the job, writing its images into `dir` (made already); resolves with the reply. */
  call(request: { path: string; job_id: string }, dir: string): Promise<unknown>;
  /** The manifest to keep, from the service's reply: its files relative to the folder. */
  manifestOf(reply: unknown, video: string): M;
}

export interface Done<M> {
  /** The folder's absolute path, and its manifest's. */
  folder: string;
  manifest: string;
  data: M;
  reused: boolean;
}

/** Runs one job into its folder, or reuses the folder an earlier one made. */
export async function runFolderJob<M>(job: FolderJob<M>): Promise<Done<M>> {
  const { envelope, context } = job;
  context.signal.throwIfAborted();
  const video = pathFrom(envelope, "path");
  const output = fieldOf(envelope, "output");
  if (output !== undefined && typeof output !== "string")
    throw new Error(`\`output\` must be a folder, not ${JSON.stringify(output)}`);
  const overwrite = fieldOf(envelope, "overwrite") ?? false;
  bool("overwrite", overwrite);
  const outputDir = outputDirOf(envelope);

  // Every path a Flow can name is checked against the Task's Allowed roots, and used where it really leads.
  const { roots } = envelope.settings;
  const readable = await allowedPath(roots, video, "read");
  const stats = await stat(readable).catch(() => {
    throw new Error(`No video at "${video}"`);
  });
  const base = baseOf({ output, outputDir, defaultDir: job.ownDir }, job.what);
  const folder = join(base, nameOf(video, stats, { path: video, ...job.request }));
  const manifest = join(folder, job.manifestName);
  // The Plugin's own folder in its data directory is no path a Flow names, so it needs no root.
  const writable =
    output === undefined && outputDir === undefined ? folder : await allowedPath(roots, folder, "write");

  const kept = join(writable, job.manifestName);
  if (overwrite !== true && existsSync(kept)) {
    const data = JSON.parse(await readFile(kept, "utf8")) as M;
    context.sendProgress(1, job.reusedMessage);
    return { folder, manifest, data, reused: true };
  }

  const jobId = `fyflow-${crypto.randomUUID()}`;
  const staging = `${writable}.${jobId}.part`;
  try {
    await mkdir(staging, { recursive: true });
    context.sendProgress(0, job.startMessage);
    const reply = await job.call({ path: readable, job_id: jobId }, staging);
    const data = job.manifestOf(reply, video);
    await writeFile(join(staging, job.manifestName), `${JSON.stringify(data, null, 2)}\n`);
    if (overwrite === true) await rm(writable, { recursive: true, force: true });
    try {
      await rename(staging, writable);
    } catch (error) {
      // Another Task moved the same folder into place first: that one will do.
      if (!existsSync(kept)) throw error;
      await rm(staging, { recursive: true, force: true });
      return { folder, manifest, data: JSON.parse(await readFile(kept, "utf8")) as M, reused: true };
    }
    context.sendProgress(1, job.doneMessage);
    return { folder, manifest, data, reused: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
