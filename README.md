# fyflow-ext.video-thumbnail

A [fyflow-app](../fyflow-app) Plugin that makes JPEG thumbnails and contact sheets of videos, and finds the videos
among files. The decoding is done by [thumbs-collage](https://github.com/tsukeero/rust-video-thumbnail-generator), a
Rust and FFmpeg service the Worker runs beside the Host.

## Set it up

```sh
pnpm install
pnpm fetch-service  # downloads the pinned thumbs-collage release into .service/, for the tests
pnpm check          # typecheck, lint, tests
```

To install it from the app, run `pnpm plugin-folder` and pick `dist/video-thumbnail` with **Choose folder…** on the
Plugins page. That folder holds only what a Host loads (the code, `assets/` and a package.json): the app's
installer copies a folder whole and refuses one holding a link, which this repo's `node_modules` is full of. The
desktop app provides the SDK by itself.

On a server Host you can instead put a link to this repo in the Plugin directory, with `fyflow-plugin-sdk` installed
there (`npm install fyflow-plugin-sdk` in the Plugin directory), then Reload.

## The thumbnail service

The service is not in the Plugin. The `VideoThumbnail` Worker downloads it the first time it starts on a Host, in
`setup()`, from the GitHub release `release.ts` pins: version `SERVICE_VERSION` (0.0.4), one archive per platform,
each checked against its SHA-256 before it is unpacked. It goes into the Plugin's data directory (`dataDir: true`,
fyflow-plugin-sdk 0.6.0), under `service/thumbs-collage-<version>-<platform>/`, which the Host keeps across Reloads,
updates and reinstalling, so it is downloaded once per Host and version. A Host's first thumbnail waits for the
download (about 80 MB on Windows and Linux, which carry their FFmpeg libraries); the Worker tries it three times
before its `setup()` fails. Older versions' folders stay until you delete them.

The release has archives for Windows x64, Linux x64 and macOS arm64. The macOS one needs FFmpeg 8 installed (for
example with Homebrew). On any other platform, or to use a build of your own, set `executablePath` in the Profile;
the Worker then downloads nothing. The service must take `--exit-on-stdin-close` (the Worker always passes it).

To move to a new release, change `SERVICE_VERSION`, run `pnpm fetch-service --hash`, check its hashes against the
release, and paste them into `ASSETS`.

## `VideoThumbnail`

Its Task reads the video at the Task input's `path` and writes a JPEG. `path` comes only from the input, since one
Node makes thumbnails of many videos. Every other field below can be a Node setting or a field of the Task input. A
setting wins over the input, and a nested option (`selection`, `collage`) comes whole from one place, never merged.

| Field | What it is |
| --- | --- |
| `path` | The video, an absolute path. Required, in the Task input only. |
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

**Profile:** the `fyflow-ext.video-thumbnail` section holds `executablePath` (left empty, the downloaded release),
`fontFile` and `outputDir`, each optional. `executablePath` and `fontFile` are start-up fields, so a change takes effect at the Host's next Reload.
`outputDir` is read as each Task is dispatched, and a Flow or one of its Nodes may set its own.

### Short clips

A clip too short for the Task fails, with one of two errors from the thumbnail service:

| `outcome.error` starts with | When |
| --- | --- |
| `The thumbnail service failed (500): duration is too short` | The clip is 1 second or shorter, whatever the settings. |
| `The thumbnail service failed (500): invalid offsets` | `selection`'s `startOffset` and `endOffset` together are as long as the clip or longer. |

To route them apart from other failures, such as clips from games in a big folder, make the Node `optional`, so a
failure goes down its failure Edges instead of stopping the Run. Then give it one failure Edge per error, matched with
`startsWith`, and one failure Edge without a condition for every other error:

```json
{
  "id": "thumb", "kind": "task", "type": "VideoThumbnail", "optional": true,
  "edges": [
    { "on": ["failed"], "when": { "path": "outcome.error", "op": "startsWith",
      "value": "The thumbnail service failed (500): duration is too short" }, "to": "gather" },
    { "on": ["failed"], "when": { "path": "outcome.error", "op": "startsWith",
      "value": "The thumbnail service failed (500): invalid offsets" }, "to": "gather" },
    { "on": ["failed"], "to": "broken" },
    { "to": "gather" }
  ]
}
```

The match is on the message's text, so check these lines if the plugin or the service changes how it words them.

## Finding the videos: `VideoFiles` and `IsVideo`

Two Node Types share one test of whether a file is a video (below):

- **`VideoFiles`** filters a whole list in one Task. It finds the list at `list` in the Task input (`entries` unless
  set, so it fits right after `ListFolder`; `.` for an input that is the list itself), and the path in each item at
  `pathKey` (`path` unless set; an item that is a string is the path). It hands on `{ entries, skipped }`: the
  videos, each item as it came (a path as `{ path }`), and the rest with the reason each was left out. Put a `map`
  over `entries` after it, with a `VideoThumbnail` in its branch, for one thumbnail per video. Its result also has
  `count`, the number of videos. A `map` over an empty list never reaches its join, and the Run is stuck, so when
  a folder may have no videos, route on `outcome.result.count` greater than `0` to the `map`, with the default Edge
  going around it.
- **`IsVideo`** checks one file, for its Edges to route on, like a gate that reads the file. The file is the Task
  input when it is a path, else the path at `pathKey` in it, so inside a `map` it checks each
  item. It hands on `{ path, video, container?, reason? }`. Give it an Edge with the condition
  `outcome.result.video` equals `true` to the Nodes for a video, and one without a condition for the rest (fyflow
  wants one default Edge). Its result has `path` at the top, so a `VideoThumbnail` after it takes it as it is. A
  file that isn't a video is a result, not a failure.

Both key paths are names joined by dots, such as `listing.files` or `file.path`. For anything they can't say, give
the Node a JSONata transform of its input instead.

A file is a video when:

1. its extension is one of `extensions`. Left empty, that is mp4, m4v, mov, mkv, webm, avi, wmv, asf, flv, f4v,
   mpg, mpeg, m2ts, mts, ts, 3gp, 3g2, ogv, vob, rm, rmvb and divx; and
2. unless `checkContent` is off, its first bytes are a video container's signature: MP4/MOV (`ftyp`, except
   audio-only brands like M4A), Matroska/WebM, AVI, ASF/WMV, FLV, MPEG program or transport stream, Ogg or
   RealMedia.

The signature names the container, not what it holds: an `.mkv` or `.ogv` with only audio in it passes, and the
thumbnail Task then fails on it. A video with an extension not in the list is left out even if its content is a
video's. Folders and links in a listing are left out, and so are files that can't be read.

Neither decodes anything: each reads at most 512 bytes of a file. `VideoFiles` reads 16 files at a time and takes
one slot of the `disk` group while it runs. `IsVideo` takes none, since one small read per item shouldn't wait
behind copies.

## How it runs

The Node Type's pool is inline with one Worker instance per Profile, up to 4 Tasks at once, retired after 30 s with
none. The instance starts the service in `setup()`, after downloading it if this Host has not yet:

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

The tests run against the real service, the one `pnpm fetch-service` downloads into `.service/` (given to the Worker
as its data directory), and skip themselves when it is missing. `test/fixtures/sample.mp4` is
1 s of black, then 5 s of ffmpeg's test pattern. `pnpm make-fixture` remakes it with the ffmpeg in `$FFMPEG_DIR/bin`.
