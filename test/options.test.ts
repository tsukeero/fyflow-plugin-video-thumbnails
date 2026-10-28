import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, optionsOf, pathFrom, requestOf } from "../options.ts";

const envelope = (settings: Record<string, unknown>, input: unknown = {}) => ({
  settings: { ...settings, profile: {} },
  input,
});
const video = process.platform === "win32" ? "C:\\videos\\movie.mp4" : "/videos/movie.mp4";

describe("pathFrom", () => {
  it("takes the Node's setting over the Task input's field", () => {
    expect(pathFrom(envelope({ path: video }, { path: "/elsewhere.mp4" }), "path")).toBe(video);
  });

  it("takes the Task input's field when the setting is empty or left out", () => {
    expect(pathFrom(envelope({ path: "" }, { path: video }), "path")).toBe(video);
    expect(pathFrom(envelope({}, { path: video }), "path")).toBe(video);
  });

  it("refuses a missing or relative path, naming the field", () => {
    expect(() => pathFrom(envelope({}, {}), "path")).toThrow(/No `path`/);
    expect(() => pathFrom(envelope({ path: "movie.mp4" }), "path")).toThrow(
      /`path` must be an absolute path/,
    );
    expect(() => pathFrom(envelope({ path: 3 }), "path")).toThrow(/`path` must be a path/);
  });
});

describe("optionsOf", () => {
  it("gives a single blank-skipping frame from the middle, 640 wide, when nothing is set", () => {
    expect(optionsOf(envelope({}))).toEqual(DEFAULT_OPTIONS);
    expect(DEFAULT_OPTIONS).toEqual({
      selection: { mode: "uniform", frames: 1 },
      collage: { mode: "grid", rows: 1, cols: 1, width: 640 },
      fit: "cover",
      skipBlankFrames: true,
      renderTimestamps: false,
    });
  });

  it("takes each option from the Node's settings, else the Task input, else the default", () => {
    const options = optionsOf(envelope({ fit: "contain" }, { fit: "stretch", renderTimestamps: true }));
    expect(options.fit).toBe("contain");
    expect(options.renderTimestamps).toBe(true);
    expect(options.skipBlankFrames).toBe(true);
  });

  it("takes a nested option whole from one source, never merging the two", () => {
    const options = optionsOf(
      envelope(
        { collage: { mode: "grid", rows: 3, cols: 3 } },
        { collage: { mode: "advanced", pieces: [{ x: 0, y: 0, w: 1, h: 1 }] } },
      ),
    );
    expect(options.collage).toEqual({ mode: "grid", rows: 3, cols: 3 });
  });

  it("accepts every mode and option the service has", () => {
    const all = {
      selection: { mode: "timestamps", timestamps: [1.5, 10] },
      collage: {
        mode: "advanced",
        pieces: [
          { x: 0, y: 0, w: 0.5, h: 1 },
          { x: 0.5, y: 0, w: 0.5, h: 1 },
        ],
        spacing: 2,
        margin: 4,
        width: 1920,
        height: 1080,
        background: { r: 10, g: 20, b: 30 },
      },
      fit: "stretch",
      renderTimestamps: true,
      skipBlankFrames: false,
      forceFallback: 2,
      thumbWidth: 320,
      thumbHeight: 180,
    };
    expect(optionsOf(envelope({}, all))).toEqual(all);
  });

  it.each([
    [{ selection: { mode: "random" } }, /`selection.mode` must be one of "uniform", "timestamps"/],
    [{ selection: { mode: "uniform" } }, /`selection.frames` must be an integer of at least 1/],
    [
      { selection: { mode: "uniform", frames: 2, timestamps: [1] } },
      /`selection.timestamps` is not an option of "uniform"/,
    ],
    [
      { selection: { mode: "timestamps", timestamps: [] } },
      /`selection.timestamps` must be a non-empty list/,
    ],
    [
      { selection: { mode: "timestamps", timestamps: [-1] } },
      /`selection.timestamps\[0\]` must be a number of at least 0/,
    ],
    [{ collage: { mode: "grid", rows: 2 } }, /`collage.cols` must be an integer of at least 1/],
    [
      { collage: { mode: "advanced", pieces: [{ x: 0, y: 0, w: 2, h: 1 }] } },
      /`collage.pieces\[0\].w` must be a number from 0 to 1/,
    ],
    [
      { collage: { mode: "grid", rows: 1, cols: 1, background: { r: 300, g: 0, b: 0 } } },
      /`collage.background.r` must be an integer from 0 to 255/,
    ],
    [{ fit: "fill" }, /`fit` must be one of "cover", "contain", "stretch"/],
    [{ forceFallback: 3 }, /`forceFallback` must be one of 0, 1, 2/],
    [{ renderTimestamps: "yes" }, /`renderTimestamps` must be true or false/],
    [{ selection: "uniform" }, /`selection` must be an object/],
  ])("refuses %j, saying why", (input, message) => {
    expect(() => optionsOf(envelope({}, input))).toThrow(message);
  });
});

describe("requestOf", () => {
  it("writes the service's request: snake_case, percent-named pieces, the job id", () => {
    const request = requestOf(
      video,
      {
        selection: { mode: "uniform", frames: 4, startOffset: 1, endOffset: 2 },
        collage: { mode: "advanced", pieces: [{ x: 0, y: 0, w: 1, h: 1 }], background: { r: 1, g: 2, b: 3 } },
        fit: "cover",
        renderTimestamps: true,
        skipBlankFrames: false,
        forceFallback: 1,
        thumbWidth: 320,
      },
      "job-1",
    );
    expect(request).toEqual({
      path: video,
      job_id: "job-1",
      selection: { mode: "uniform", frames: 4, start_offset: 1, end_offset: 2 },
      collage: {
        mode: "advanced",
        pieces: [{ x_percent: 0, y_percent: 0, w_percent: 1, h_percent: 1 }],
        background: { r: 1, g: 2, b: 3, a: 255 },
      },
      fit: "cover",
      render_timestamps: true,
      skip_blank_frames: false,
      force_fallback: 1,
      thumb_w: 320,
    });
  });
});
