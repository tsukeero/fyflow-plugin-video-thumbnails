// `fyflow-ext.video-thumbnail`: video thumbnails and contact sheets, made by a thumbs-collage service the Worker runs
// beside the Host. Every option may be a Node setting or a field of the Task input; a setting wins. fyflow's schema
// subset cannot say which fields go with which mode, so the settings schema lists them all and the Worker checks the
// merged options itself (./options.ts).
import { definePlugin } from "fyflow-plugin-sdk";

const absolutePath = (description: string) => ({ type: "string", minLength: 1, description });

// The Plugin's Profile section. The executable and font are start-up fields, since the service is started with them in
// `setup()`; `outputDir` is a per-Task field, read as each Task is dispatched, so a Flow or Node may set its own.
const profileSchema = {
  type: "object",
  properties: {
    executablePath: absolutePath(
      "The thumbs-collage executable; left empty, the one `pnpm copy-service` put in the Plugin's bin folder",
    ),
    fontFile: absolutePath("A TTF font for timestamps; left empty, the bundled DejaVu Sans"),
    outputDir: absolutePath(
      "Where thumbnails go when a Task names no output; left empty, a folder in the system's temp folder",
    ),
  },
  additionalProperties: false,
};

const seconds = (description: string) => ({ type: "number", minimum: 0, description });
const count = (description: string) => ({ type: "integer", minimum: 1, description });
const pixels = (description: string) => ({ type: "integer", minimum: 0, description });
const fraction = (description: string) => ({ type: "number", minimum: 0, maximum: 1, description });
const channel = { type: "integer", minimum: 0, maximum: 255 };

const settingsSchema = {
  type: "object",
  properties: {
    path: absolutePath("The video, an absolute path; left empty, the Task input's `path`"),
    output: absolutePath(
      "A .jpg file to write, or a folder to name one in; left empty, the Profile's outputDir or the temp folder",
    ),
    overwrite: {
      type: "boolean",
      description:
        "Make the thumbnail again even if this video and these options made one in the folder before",
    },
    selection: {
      type: "object",
      required: ["mode"],
      description: "Which frames: `uniform` takes `frames` evenly spaced, `timestamps` the ones listed",
      properties: {
        mode: { enum: ["uniform", "timestamps"] },
        frames: count("uniform: how many frames"),
        startOffset: seconds("uniform: seconds to leave out at the start"),
        endOffset: seconds("uniform: seconds to leave out at the end"),
        timestamps: { type: "array", items: seconds("a timestamp"), description: "timestamps: in seconds" },
      },
      additionalProperties: false,
    },
    collage: {
      type: "object",
      required: ["mode"],
      description:
        "How the frames are laid out: `grid` in rows and columns, `advanced` each where a piece says",
      properties: {
        mode: { enum: ["grid", "advanced"] },
        rows: count("grid: rows"),
        cols: count("grid: columns"),
        pieces: {
          type: "array",
          description: "advanced: where each frame goes, as fractions of the collage from 0 to 1",
          items: {
            type: "object",
            required: ["x", "y", "w", "h"],
            properties: {
              x: fraction("left"),
              y: fraction("top"),
              w: fraction("width"),
              h: fraction("height"),
            },
            additionalProperties: false,
          },
        },
        spacing: pixels("pixels between frames"),
        margin: pixels("pixels around the frames"),
        width: count("the collage's width in pixels; left empty, from the height or the video"),
        height: count("the collage's height in pixels; left empty, from the width and the video's shape"),
        background: {
          type: "object",
          required: ["r", "g", "b"],
          description: "the colour behind the frames (opaque black unless set)",
          properties: { r: channel, g: channel, b: channel, a: channel },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    fit: {
      enum: ["cover", "contain", "stretch"],
      description: "How a frame fills its place: cover crops, contain letterboxes, stretch distorts",
    },
    renderTimestamps: { type: "boolean", description: "Draw each frame's timestamp on it" },
    skipBlankFrames: { type: "boolean", description: "Step past black or solid frames (on unless set off)" },
    forceFallback: {
      enum: [0, 1, 2],
      description:
        "Force a decoding method: 0 seeks, 1 keyframes only, 2 decodes everything (slow, for damaged videos)",
    },
    thumbWidth: count("A width hint for decoding frames"),
    thumbHeight: count("A height hint for decoding frames"),
  },
  additionalProperties: false,
};

const outputSchema = {
  type: "object",
  required: ["path", "video", "duration", "width", "height", "frames", "reused"],
  properties: {
    path: { type: "string", description: "the thumbnail's absolute path" },
    video: { type: "string", description: "the video's absolute path" },
    duration: { type: "number", description: "the video's length in seconds" },
    width: { type: "integer", description: "the thumbnail's width in pixels" },
    height: { type: "integer", description: "the thumbnail's height in pixels" },
    frames: {
      type: "array",
      description: "each frame's timestamp in seconds, as asked for and as used after skipping blank frames",
      items: {
        type: "object",
        required: ["requested", "actual"],
        properties: { requested: { type: "number" }, actual: { type: "number" } },
      },
    },
    reused: { type: "boolean", description: "true when an earlier Task had made it already" },
  },
};

export default definePlugin({
  id: "fyflow-ext.video-thumbnail",
  version: "0.1.0",
  base: import.meta.url,
  profile: {
    schema: profileSchema,
    startup: ["executablePath", "fontFile"],
  },
  workers: {
    thumbnail: { url: "./thumbnail.worker.ts", settingsSchema, outputSchema },
  },
  nodeTypes: {
    VideoThumbnail: {
      worker: "thumbnail",
      // The decoding is in the service's process: one instance (and so one service) per Profile, on the Host's
      // thread, sending it up to four Tasks at once, and stopping it after 30 s with none.
      inline: true,
      pool: { maxThreads: 1, maxConcurrentTasks: 4, idleTimeout: 30_000 },
      profile: ["executablePath", "fontFile", "outputDir"],
      icon: "image",
      description: "Makes a JPEG thumbnail or contact sheet of a video's frames.",
    },
  },
});
