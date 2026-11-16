// The `DetectScenes` Worker: a video's scene cuts, and optionally frames picked from each scene in the same pass,
// from the service's `POST /scenes`, written into a folder of their own with a manifest, `scenes.json`
// (./folder-job.ts). Without `frames` the folder holds only the manifest, kept all the same: detection decodes the
// whole video, so it is worth not doing twice.
import { basename, join } from "node:path";
import type { TaskEnvelope, Worker, WorkerContext } from "fyflow-plugin-sdk";
import { SCENES } from "./data.ts";
import { IMAGE_KEYS, imageOf, listsOf, objectOf, runFolderJob } from "./folder-job.ts";
import { bool, defined, fieldOf, integer, number, oneOf } from "./options.ts";
import { type ProfileFields, ServiceWorker } from "./service-worker.ts";

export type { Config, ProfileFields } from "./service-worker.ts";

export const SCENES_MANIFEST = "scenes.json";

/** One scene in the manifest, its times in seconds (`end` exclusive), with `mid` added by the Plugin. */
export interface ManifestScene {
  index: number;
  start: number;
  end: number;
  mid: number;
  /** The indexes of its frames in `frames`. */
  frames?: number[];
}

/** One frame in the manifest: `file` relative to its folder. */
export interface ManifestSceneFrame {
  index: number;
  scene: number;
  target: number;
  timestamp: number;
  file: string;
}

/** `scenes.json`: the service's reply, without `scores`, its files relative to the folder. */
export interface ScenesManifest {
  video: string;
  duration: number;
  detector: string;
  scenes: ManifestScene[];
  frames?: ManifestSceneFrame[];
  [key: string]: unknown;
}

export interface ScenesResult {
  /** The scenes' folder, and its manifest, as absolute paths. */
  folder: string;
  manifest: string;
  /** How many scenes. */
  count: number;
  /** How many frames were picked: 0 without `frames`. */
  frameCount: number;
  video: string;
  /** The video's length, in seconds. */
  duration: number;
  detector: string;
  /** Whether the folder was there already from an earlier Task, rather than made by this one. */
  reused: boolean;
  /** With `lists: "result"`: the scenes. */
  scenes?: { index: number; start: number; end: number; mid: number }[];
  /** With `lists: "result"`: the frames picked, absolute paths. */
  frames?: { path: string; index: number; scene: number; target: number; timestamp: number }[];
}

export default class DetectScenes
  extends ServiceWorker
  implements Worker<Record<string, unknown>, unknown, ScenesResult, ProfileFields>
{
  async run(
    envelope: TaskEnvelope<Record<string, unknown>, unknown, ProfileFields>,
    context: WorkerContext,
  ): Promise<ScenesResult> {
    const request = scenesRequestOf(envelope);
    const lists = listsOf(envelope);
    const frames = request.frames as Record<string, unknown> | undefined;
    const done = await runFolderJob<ScenesManifest>({
      envelope,
      context,
      ownDir: this.ownDir(SCENES),
      manifestName: SCENES_MANIFEST,
      what: "the scenes",
      startMessage: "Detecting scenes",
      doneMessage: "Detected the scenes",
      reusedMessage: "Reused the scenes detected before",
      request,
      call: async (job, dir) =>
        (await this.service(context)).scenes(
          {
            ...request,
            ...job,
            ...(frames === undefined ? {} : { frames: { ...frames, output: { mode: "files", dir } } }),
          },
          {
            signal: context.signal,
            onProgress: (progress, message) => context.sendProgress(progress, message),
          },
        ),
      manifestOf: scenesManifestOf,
    });
    const { folder, manifest, data, reused } = done;
    const result: ScenesResult = {
      folder,
      manifest,
      count: data.scenes.length,
      frameCount: data.frames?.length ?? 0,
      video: data.video,
      duration: data.duration,
      detector: data.detector,
      reused,
    };
    if (lists === "result") {
      result.scenes = data.scenes.map(({ index, start, end, mid }) => ({ index, start, end, mid }));
      result.frames = (data.frames ?? []).map((f) => ({
        path: join(folder, f.file),
        index: f.index,
        scene: f.scene,
        target: f.target,
        timestamp: f.timestamp,
      }));
    }
    return result;
  }
}

/**
 * The `/scenes` request, without `path`, `job_id` and the frames' `output`; refused, saying why, if an option is
 * wrong. Which fields go with which detector is the service's to say: it refuses the rest (400), and its message is
 * passed on.
 */
export function scenesRequestOf(
  envelope: TaskEnvelope<Record<string, unknown>, unknown, unknown>,
): Record<string, unknown> {
  const hint = fieldOf(envelope, "hint");
  if (hint !== undefined) oneOf("hint", hint, ["anime", "cg", "real"]);
  const detector = fieldOf(envelope, "detector");
  if (detector !== undefined) oneOf("detector", detector, ["content", "scdet", "keyframes"]);
  const threshold = fieldOf(envelope, "threshold");
  if (threshold !== undefined) number("threshold", threshold, 0);
  const minSceneLen = fieldOf(envelope, "minSceneLen");
  if (minSceneLen !== undefined) number("minSceneLen", minSceneLen, 0);
  const given = fieldOf(envelope, "frames");
  const frames = given === undefined ? undefined : framesOf(given);
  const skipBlankFrames = fieldOf(envelope, "skipBlankFrames") ?? true;
  bool("skipBlankFrames", skipBlankFrames);
  const advanced = fieldOf(envelope, "advanced");
  return defined({
    hint,
    detector,
    threshold,
    min_scene_len: minSceneLen,
    ...(advanced === undefined ? {} : advancedOf(advanced)),
    frames,
    // Only picking frames skips blank ones, so it is sent only with `frames`.
    skip_blank_frames: frames === undefined ? undefined : skipBlankFrames,
  });
}

const FRAME_KEYS = ["every", "minPerScene", "maxPerScene", "margin", "maxFrames", ...IMAGE_KEYS];

/** `frames` in the service's terms, the images 640 wide and fitted inside unless told otherwise. */
function framesOf(given: unknown): Record<string, unknown> {
  const f = objectOf("frames", given, FRAME_KEYS);
  if (f.every !== undefined) number("frames.every", f.every, 0);
  if (f.minPerScene !== undefined) integer("frames.minPerScene", f.minPerScene, 0);
  if (f.maxPerScene !== undefined) integer("frames.maxPerScene", f.maxPerScene, 1);
  if (f.margin !== undefined) number("frames.margin", f.margin, 0);
  if (f.maxFrames !== undefined) integer("frames.maxFrames", f.maxFrames, 1);
  return defined({
    every: f.every,
    min_per_scene: f.minPerScene,
    max_per_scene: f.maxPerScene,
    margin: f.margin,
    max_frames: f.maxFrames,
    ...imageOf("frames", f),
  });
}

/** `advanced` in the service's terms: its fields go at the top of the request. */
function advancedOf(given: unknown): Record<string, unknown> {
  const a = objectOf("advanced", given, ["adaptive", "flashFilter", "weights", "skipNonref"]);
  let adaptive: Record<string, unknown> | null | undefined;
  if (a.adaptive === null) adaptive = null;
  else if (a.adaptive !== undefined) {
    const d = objectOf("advanced.adaptive", a.adaptive, ["ratio", "window", "minScore"]);
    if (d.ratio !== undefined) number("advanced.adaptive.ratio", d.ratio, 0);
    if (d.window !== undefined) integer("advanced.adaptive.window", d.window, 1);
    if (d.minScore !== undefined) number("advanced.adaptive.minScore", d.minScore, 0);
    adaptive = defined({ ratio: d.ratio, window: d.window, min_score: d.minScore });
  }
  if (a.flashFilter !== undefined) oneOf("advanced.flashFilter", a.flashFilter, ["merge", "suppress", "off"]);
  if (a.weights !== undefined) {
    const w = objectOf("advanced.weights", a.weights, ["hue", "sat", "lum"]);
    for (const key of ["hue", "sat", "lum"])
      if (w[key] !== undefined) number(`advanced.weights.${key}`, w[key], 0);
  }
  if (a.skipNonref !== undefined) bool("advanced.skipNonref", a.skipNonref);
  const fields = defined({ flash_filter: a.flashFilter, weights: a.weights, skip_nonref: a.skipNonref });
  // `null` is kept: it turns off the adaptive layer a hint would add.
  return adaptive === undefined ? fields : { ...fields, adaptive };
}

/** What `scenes.json` keeps of the service's reply: no `scores`, files by name only, `mid` on each scene. */
function scenesManifestOf(reply: unknown, video: string): ScenesManifest {
  const {
    scores: _s,
    config,
    scenes,
    frames,
    ...rest
  } = reply as {
    scores?: unknown;
    config?: Record<string, unknown> & { frames?: Record<string, unknown> | null };
    scenes: Omit<ManifestScene, "mid">[];
    frames?: ManifestSceneFrame[];
    duration?: number;
    detector?: string;
  };
  const keptConfig: Record<string, unknown> = { ...config };
  if (config?.frames !== undefined && config.frames !== null) {
    const { output: _o, ...framesConfig } = config.frames;
    keptConfig.frames = framesConfig;
  }
  return {
    ...rest,
    video,
    duration: rest.duration ?? 0,
    detector: rest.detector ?? "",
    scenes: scenes.map((s) => ({ ...s, mid: (s.start + s.end) / 2 })),
    ...(frames === undefined ? {} : { frames: frames.map((f) => ({ ...f, file: basename(f.file) })) }),
    config: keptConfig,
  };
}
