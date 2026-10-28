# fyflow-ext.video-thumbnail

A [fyflow-app](../fyflow-app) Plugin that makes JPEG thumbnails and contact sheets of videos, and finds the videos
among files. The decoding is done by [thumbs-collage](../rust-thumbnail-service-public), a Rust and FFmpeg service
the Worker runs beside the Host.

## Set it up

```sh
pnpm install
pnpm copy-service   # copies thumbs-collage and its FFmpeg libraries into bin/<platform>-<arch>/
pnpm check          # typecheck, lint, tests
```

`pnpm copy-service` reads `../rust-thumbnail-service-public/target/release` unless you pass another folder. `bin/` is
not committed. The release build needs `--exit-on-stdin-close` (the Worker always passes it).

To install it from the app, run `pnpm plugin-folder` and pick `dist/video-thumbnail` with **Choose folder…** on the
Plugins page. That folder holds only what a Host loads (the code, `assets/`, `bin/` and a package.json): the app's
installer copies a folder whole and refuses one holding a link, which this repo's `node_modules` is full of. The
desktop app provides the SDK by itself.

On a server Host you can instead put a link to this repo in the Plugin directory, with `fyflow-plugin-sdk` installed
there (`npm install fyflow-plugin-sdk` in the Plugin directory), then Reload.

## `VideoThumbnail`

Its Task reads a video and writes a JPEG. Every field below can be a Node setting or a field of the Task input. A
setting wins over the input, and a nested option (`selection`, `collage`) comes whole from one place, never merged.

| Field | What it is |
| --- | --- |
| `path` | The video, an absolute path. Required. |
| `output` | A `.jpg`/`.jpeg` file to write, or a folder to name one in. |
| `overwrite` | Make it again even if this video and these options made one in the folder before. |
| `selection` | `{ mode: "uniform", frames, startOffset?, endOffset? }` (offsets in seconds) or `{ mode: "timestamps", timestamps }`. |
| `collage` | `{ mode: "grid", rows, cols }` or `{ mode: "advanced", pieces: [{ x, y, w, h }] }` (fractions from 0 to 1), each with `spacing`, `margin`, `width`, `height`, `background: { r, g, b, a? }`. |
| `fit` | `cover` (crop), `contain` (letterbox) or `stretch`. |
| `renderTimestamps` | Draw each frame's timestamp, in the bundled DejaVu Sans unless the Profile names a font. |
| `skipBlankFrames` | Step past black or solid frames. |
| `forceFallback` | `0` seek, `1` keyframes only, `2` decode everything (slow, for damaged videos). |
| `thumbWidth`, `thumbHeight` | Size hints for decoding frames. |

With nothing set, the thumbnail is one frame from the middle of the video, 640 pixels wide, blank frames skipped.

**Where the file goes.** First `output`. Without it, the Profile's `outputDir`. Without that,
`<system temp>/fyflow-video-thumbnails/`, which the OS may clear, so it suits a thumbnail the next Node uses rather
than one to keep. In a folder, the file is named `<video name>.<hash>.jpg`. The hash covers the video's path, size and
last change, and the options, so running a Task again on an unchanged video reuses the file (`reused: true`) unless
`overwrite` is set. A `.jpg` path that is given is always written.

**Result:** `{ path, video, duration, width, height, frames: [{ requested, actual }], reused }`. A frame's `actual`
timestamp differs from the one `requested` when blank frames were skipped.

**Profile:** the `fyflow-ext.video-thumbnail` section holds `executablePath`, `fontFile` and `outputDir`, each
optional. `executablePath` and `fontFile` are start-up fields, so a change takes effect at the Host's next Reload.
`outputDir` is read as each Task is dispatched, and a Flow or one of its Nodes may set its own.

## `VideoFiles`

Keeps the videos among the `entries` that reach it, which are `ListFolder`'s entries or absolute paths. It hands on
`{ entries, skipped }`: the videos, each as it came (a path as `{ path }`), and the rest with the reason each was left
out. Put a `map` over `entries` after it, with a `VideoThumbnail` in its branch, for one thumbnail per video. The
thumbnail service never sees a file that isn't a video, so no Task fails on one.

A file is a video when:

1. its extension is one of `extensions`. Left empty, that is mp4, m4v, mov, mkv, webm, avi, wmv, asf, flv, f4v,
   mpg, mpeg, m2ts, mts, ts, 3gp, 3g2, ogv, vob, rm, rmvb and divx; and
2. unless `checkContent` is off, its first bytes are a video container's signature: MP4/MOV (`ftyp`, except
   audio-only brands like M4A), Matroska/WebM, AVI, ASF/WMV, FLV, MPEG program or transport stream, Ogg or
   RealMedia.

The signature names the container, not what it holds: an `.mkv` or `.ogv` with only audio in it passes, and the
thumbnail Task then fails on it. A video with an extension not in the list is left out even if its content is a
video's. Folders and links in a listing are left out, and so are files it cannot read.

It decodes nothing and reads at most 512 bytes of each file, 16 files at a time. It takes one slot of the `disk`
group while it runs.

## How it runs

The Node Type's pool is inline with one Worker instance per Profile, up to 4 Tasks at once, retired after 30 s with
none. The instance starts the service in `setup()`:

- on a free port of 127.0.0.1;
- with its progress WebSocket on;
- with `--exit-on-stdin-close`, so it dies with the Host however the Host ends.

Each Task takes one slot of the Host's `cpu` group and one of its `disk` group while it runs. The service makes
each thumbnail on one thread, so a Task keeps one processor busy. It usually reads the video with a few seeks per
frame, but for a damaged video it falls back to reading nearly all of it, once or twice.

Each Task is one `POST /make_collage`. Its progress arrives over the WebSocket and goes to the Task's progress. If the
service dies, the Tasks in flight fail with its last lines of output, and the Worker asks its pool to replace it.

`setup()`, `teardown()` and that last request (`terminateWithError`) are the Worker lifecycle fyflow-plugin-sdk
promises since 0.5.0.

**Not in v1:** Allowed roots. Unlike `fyflow.fs`, this Plugin reads any video and writes any path it is given.

## Tests

The tests run against the real service and skip themselves when `bin/` is missing. `test/fixtures/sample.mp4` is
1 s of black, then 5 s of ffmpeg's test pattern. `pnpm make-fixture` remakes it with the ffmpeg in `$FFMPEG_DIR/bin`.
