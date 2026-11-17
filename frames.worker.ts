// The `ExtractFrames` Worker: one image per requested timestamp, from the service's `POST /frames`, written into a
// folder of their own with a manifest, `frames.json` (./folder-job.ts). Its pool is inline, sharing the service with
// the Plugin's other service Node Types (./service-worker.ts).
import { basename, join } from "node:path";
import type { TaskEnvelope, Worker, WorkerContext } from "fyflow-plugin-sdk";
import { FRAMES } from "./data.ts";
import { IMAGE_KEYS, imageOf, listsOf, runFolderJob } from "./folder-job.ts";
import { bool, checkSelection, defined, fieldOf, oneOf, selectionOf } from "./options.ts";
import { fingerprintOf } from "./output.ts";
import { type ProfileFields, ServiceWorker } from "./service-worker.ts";

export type { Config, ProfileFields } from "./service-worker.ts";

export const FRAMES_MANIFEST = "frames.json";

/** One frame in the manifest: `file` relative to its folder. */
export interface ManifestFrame {
  index: number;
  timestamp_requested: number;
  timestamp_actual: number;
  file: string;
}

/** `frames.json`: the service's reply, its files relative to the folder, `null` for each frame it could not decode. */
export interface FramesManifest {
  video: string;
  duration: number;
  frames: (ManifestFrame | null)[];
  [key: string]: unknown;
}

export interface FramesResult {
  /** The frames' folder, and its manifest, as absolute paths. */
  folder: string;
  manifest: string;
  /** How many frames were extracted: the ones the service could not decode are not counted. */
  count: number;
  video: string;
  /** The video's length, in seconds. */
  duration: number;
  /** Whether the folder was there already from an earlier Task, rather than made by this one. */
  reused: boolean;
  /**
   * The video file's fp1 fingerprint, `fp1:` and 32 hex digits: a stable identity across renames and moves, from
   * thumbs-collage 0.2.0 on. Absent for output an older service made.
   */
  fingerprint?: string;
  /** With `lists: "result"`: the frames, absolute paths, without the missing ones. */
  frames?: { path: string; index: number; requested: number; actual: number }[];
  /** With `lists: "result"`: the indexes of the frames the service could not decode. */
  missing?: number[];
}

/** The frames a Task with no `selection` asks for. */
export const DEFAULT_SELECTION = { mode: "uniform", frames: 8 } as const;

export default class ExtractFrames
  extends ServiceWorker
  implements Worker<Record<string, unknown>, unknown, FramesResult, ProfileFields>
{
  async run(
    envelope: TaskEnvelope<Record<string, unknown>, unknown, ProfileFields>,
    context: WorkerContext,
  ): Promise<FramesResult> {
    const request = framesRequestOf(envelope);
    const lists = listsOf(envelope);
    const done = await runFolderJob<FramesManifest>({
      envelope,
      context,
      ownDir: this.ownDir(FRAMES),
      manifestName: FRAMES_MANIFEST,
      what: "the frames",
      startMessage: "Extracting frames",
      doneMessage: "Extracted the frames",
      reusedMessage: "Reused the frames extracted before",
      request,
      call: async (job, dir) =>
        (await this.service(context)).frames(
          { ...request, ...job, output: { mode: "files", dir } },
          {
            signal: context.signal,
            onProgress: (progress, message) => context.sendProgress(progress, message),
          },
        ),
      manifestOf: framesManifestOf,
    });
    const { folder, manifest, data, reused } = done;
    const frames = data.frames.filter((f): f is ManifestFrame => f !== null);
    const result: FramesResult = {
      folder,
      manifest,
      count: frames.length,
      video: data.video,
      duration: data.duration,
      reused,
      ...fingerprintOf(data.fingerprint),
    };
    if (lists === "result") {
      result.frames = frames.map((f) => ({
        path: join(folder, f.file),
        index: f.index,
        requested: f.timestamp_requested,
        actual: f.timestamp_actual,
      }));
      result.missing = data.frames.flatMap((f, i) => (f === null ? [i] : []));
    }
    return result;
  }
}

/** The `/frames` request, without `path`, `job_id` and `output`; refused, saying why, if an option is wrong. */
export function framesRequestOf(
  envelope: TaskEnvelope<Record<string, unknown>, unknown, unknown>,
): Record<string, unknown> {
  const selection = fieldOf(envelope, "selection") ?? DEFAULT_SELECTION;
  checkSelection(selection);
  const skipBlankFrames = fieldOf(envelope, "skipBlankFrames") ?? true;
  bool("skipBlankFrames", skipBlankFrames);
  const forceFallback = fieldOf(envelope, "forceFallback");
  if (forceFallback !== undefined) oneOf("forceFallback", forceFallback, [0, 1, 2]);
  const image = Object.fromEntries(IMAGE_KEYS.map((key) => [key, fieldOf(envelope, key)]));
  return defined({
    selection: selectionOf(selection),
    ...imageOf("", image),
    skip_blank_frames: skipBlankFrames,
    force_fallback: forceFallback,
  });
}

/** What `frames.json` keeps of the service's reply: its files by name only, and no `config.output`. */
function framesManifestOf(reply: unknown, video: string): FramesManifest {
  const { config, frames, ...rest } = reply as {
    config?: Record<string, unknown>;
    frames: ({ file: string } | null)[];
  };
  const { output: _, ...kept } = config ?? {};
  return {
    ...rest,
    video,
    duration: (rest as { duration?: number }).duration ?? 0,
    frames: frames.map((f) =>
      f === null ? null : { ...f, file: basename(f.file) },
    ) as (ManifestFrame | null)[],
    config: kept,
  };
}
