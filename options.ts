// What a `VideoThumbnail` Task asks for: the video's path and the thumbnail's options, each taken from the Node's
// settings, else from the Task input's field of the same name, else a default; and the service request they make.
// fyflow's schema subset cannot say which fields go with which mode, and values from the input never meet the
// settings schema at all, so the options are checked here, once they are merged.
import { platform } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { TaskEnvelope } from "fyflow-plugin-sdk";

export type Selection =
  | { mode: "uniform"; frames: number; startOffset?: number; endOffset?: number }
  | { mode: "timestamps"; timestamps: number[] };

export interface Background {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Where one frame goes, as fractions of the collage from 0 to 1. */
export interface Piece {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Frame {
  spacing?: number;
  margin?: number;
  width?: number;
  height?: number;
  background?: Background;
}

export type Collage =
  | ({ mode: "grid"; rows: number; cols: number } & Frame)
  | ({ mode: "advanced"; pieces: Piece[] } & Frame);

export type Fit = "cover" | "contain" | "stretch";

export interface ThumbnailOptions {
  selection: Selection;
  collage: Collage;
  fit?: Fit;
  renderTimestamps?: boolean;
  skipBlankFrames?: boolean;
  forceFallback?: 0 | 1 | 2;
  thumbWidth?: number;
  thumbHeight?: number;
}

/** What a Task with no options makes: one frame from the middle of the video, blank frames skipped, 640 wide. */
export const DEFAULT_OPTIONS: Readonly<ThumbnailOptions> = Object.freeze<ThumbnailOptions>({
  selection: { mode: "uniform", frames: 1 },
  collage: { mode: "grid", rows: 1, cols: 1, width: 640 },
  fit: "cover",
  skipBlankFrames: true,
  renderTimestamps: false,
});

const OPTION_KEYS = [
  "selection",
  "collage",
  "fit",
  "renderTimestamps",
  "skipBlankFrames",
  "forceFallback",
  "thumbWidth",
  "thumbHeight",
] as const;

const WINDOWS = platform() === "win32";

type Envelope = TaskEnvelope<Record<string, unknown>>;

/** The Node's setting `key`, else the Task input's field of the same name; undefined when neither is there. */
export function fieldOf(envelope: Envelope, key: string): unknown {
  const set = envelope.settings[key];
  if (set !== undefined && set !== "") return set;
  const input = envelope.input;
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The absolute path a Task names in `field`, from its setting or its Task input. Nothing is resolved against the
 * Host's working directory.
 */
export function pathFrom(envelope: Envelope, field: string): string {
  const given = fieldOf(envelope, field);
  if (given === undefined || given === null || given === "")
    throw new Error(
      `No \`${field}\`: set it in the Node's settings, or pass it as \`${field}\` in the Task input`,
    );
  if (typeof given !== "string") throw new Error(`\`${field}\` must be a path, not ${JSON.stringify(given)}`);
  if (!absolute(given)) throw new Error(`\`${field}\` must be an absolute path: "${given}" is relative`);
  return resolve(given);
}

/** Absolute here: on Windows with a drive or a network share, since `\x` alone depends on the current drive. */
export function absolute(path: string): boolean {
  return WINDOWS ? /^([a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(path) : isAbsolute(path);
}

/** The Task's options, each from its settings, else its input, else the default; refused, saying why, if wrong. */
export function optionsOf(envelope: Envelope): ThumbnailOptions {
  const options: Record<string, unknown> = { ...DEFAULT_OPTIONS };
  for (const key of OPTION_KEYS) {
    const given = fieldOf(envelope, key);
    if (given !== undefined) options[key] = given;
  }
  return checked(options);
}

function checked(options: Record<string, unknown>): ThumbnailOptions {
  const {
    selection,
    collage,
    fit,
    renderTimestamps,
    skipBlankFrames,
    forceFallback,
    thumbWidth,
    thumbHeight,
  } = options;
  checkSelection(selection);
  checkCollage(collage);
  if (fit !== undefined) oneOf("fit", fit, ["cover", "contain", "stretch"]);
  if (renderTimestamps !== undefined) bool("renderTimestamps", renderTimestamps);
  if (skipBlankFrames !== undefined) bool("skipBlankFrames", skipBlankFrames);
  if (forceFallback !== undefined) oneOf("forceFallback", forceFallback, [0, 1, 2]);
  if (thumbWidth !== undefined) integer("thumbWidth", thumbWidth, 1);
  if (thumbHeight !== undefined) integer("thumbHeight", thumbHeight, 1);
  return options as unknown as ThumbnailOptions;
}

function checkSelection(selection: unknown): asserts selection is Selection {
  const s = object("selection", selection);
  oneOf("selection.mode", s.mode, ["uniform", "timestamps"]);
  if (s.mode === "uniform") {
    only("selection", s, "uniform", ["frames", "startOffset", "endOffset"]);
    integer("selection.frames", s.frames, 1);
    if (s.startOffset !== undefined) number("selection.startOffset", s.startOffset, 0);
    if (s.endOffset !== undefined) number("selection.endOffset", s.endOffset, 0);
  } else {
    only("selection", s, "timestamps", ["timestamps"]);
    list("selection.timestamps", s.timestamps).forEach((t, i) => {
      number(`selection.timestamps[${i}]`, t, 0);
    });
  }
}

function checkCollage(collage: unknown): asserts collage is Collage {
  const c = object("collage", collage);
  oneOf("collage.mode", c.mode, ["grid", "advanced"]);
  const frame = ["spacing", "margin", "width", "height", "background"];
  if (c.mode === "grid") {
    only("collage", c, "grid", ["rows", "cols", ...frame]);
    integer("collage.rows", c.rows, 1);
    integer("collage.cols", c.cols, 1);
  } else {
    only("collage", c, "advanced", ["pieces", ...frame]);
    list("collage.pieces", c.pieces).forEach((piece, i) => {
      const p = object(`collage.pieces[${i}]`, piece);
      only(`collage.pieces[${i}]`, p, undefined, ["x", "y", "w", "h"]);
      for (const key of ["x", "y", "w", "h"]) fraction(`collage.pieces[${i}].${key}`, p[key]);
    });
  }
  if (c.spacing !== undefined) integer("collage.spacing", c.spacing, 0);
  if (c.margin !== undefined) integer("collage.margin", c.margin, 0);
  if (c.width !== undefined) integer("collage.width", c.width, 1);
  if (c.height !== undefined) integer("collage.height", c.height, 1);
  if (c.background !== undefined) {
    const b = object("collage.background", c.background);
    only("collage.background", b, undefined, ["r", "g", "b", "a"]);
    for (const key of ["r", "g", "b", "a"])
      if (key !== "a" || b.a !== undefined) channel(`collage.background.${key}`, b[key]);
  }
}

const fail = (name: string, must: string, value: unknown): never => {
  throw new Error(`\`${name}\` must be ${must}, not ${JSON.stringify(value)}`);
};

function object(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(name, "an object", value);
  return value as Record<string, unknown>;
}

function list(name: string, value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) fail(name, "a non-empty list", value);
  return value as unknown[];
}

/** Refuses a key `value` has beyond `keys`: a typo, or a field of the other mode. */
function only(name: string, value: Record<string, unknown>, mode: string | undefined, keys: string[]) {
  for (const key of Object.keys(value))
    if (key !== "mode" && !keys.includes(key))
      throw new Error(
        mode === undefined
          ? `\`${name}.${key}\` is not an option; ${name} takes ${keys.join(", ")}`
          : `\`${name}.${key}\` is not an option of "${mode}"; it takes ${keys.join(", ")}`,
      );
}

function oneOf(name: string, value: unknown, allowed: readonly unknown[]) {
  if (!allowed.includes(value))
    fail(name, `one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`, value);
}

function bool(name: string, value: unknown) {
  if (typeof value !== "boolean") fail(name, "true or false", value);
}

function number(name: string, value: unknown, min: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min)
    fail(name, `a number of at least ${min}`, value);
}

function integer(name: string, value: unknown, min: number) {
  if (!Number.isInteger(value) || (value as number) < min) fail(name, `an integer of at least ${min}`, value);
}

function fraction(name: string, value: unknown) {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) fail(name, "a number from 0 to 1", value);
}

function channel(name: string, value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)
    fail(name, "an integer from 0 to 255", value);
}

/** The body of the service's `POST /make_collage`: its own field names, and only what is set. */
export function requestOf(path: string, options: ThumbnailOptions, jobId: string): Record<string, unknown> {
  const { selection, collage } = options;
  const request: Record<string, unknown> = {
    path,
    job_id: jobId,
    selection:
      selection.mode === "uniform"
        ? defined({
            mode: "uniform",
            frames: selection.frames,
            start_offset: selection.startOffset,
            end_offset: selection.endOffset,
          })
        : { mode: "timestamps", timestamps: selection.timestamps },
    collage: defined({
      ...(collage.mode === "grid"
        ? { mode: "grid", rows: collage.rows, cols: collage.cols }
        : {
            mode: "advanced",
            pieces: collage.pieces.map(({ x, y, w, h }) => ({
              x_percent: x,
              y_percent: y,
              w_percent: w,
              h_percent: h,
            })),
          }),
      spacing: collage.spacing,
      margin: collage.margin,
      width: collage.width,
      height: collage.height,
      background: collage.background && { a: 255, ...collage.background },
    }),
  };
  return defined({
    ...request,
    fit: options.fit,
    render_timestamps: options.renderTimestamps,
    skip_blank_frames: options.skipBlankFrames,
    force_fallback: options.forceFallback,
    thumb_w: options.thumbWidth,
    thumb_h: options.thumbHeight,
  });
}

/** `value` without its undefined fields. */
function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
