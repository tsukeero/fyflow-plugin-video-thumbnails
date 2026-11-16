# fyflow-ext.video-thumbnail

A [fyflow](https://github.com/fyflow/fyflow-app) Plugin that makes JPEG thumbnails and contact sheets of videos,
extracts frames as separate images, detects scene cuts, and finds the videos among files. The decoding is done by
[thumbs-collage](https://github.com/tsukeero/rust-video-thumbnail-generator), a Rust and FFmpeg service the Workers run
beside the Host.

## Install

In the app, install **Video thumbnails** from **Browse** on the Plugins page: it is in the official Plugin
repository. It needs a Host on fyflow-plugin-sdk 0.11 or later; on 0.12 its card also has a Data dialog
([below](#its-data-directory)). Then, on the Profiles page, give it the folders it
may touch (below): until then every Task is refused.

## Allowed roots

The Plugin takes the Host's Allowed roots (`roots: true`): the folders a person lets its Tasks reach, set on the
Profiles page, for every Plugin that takes them or for this one alone. Every path a Flow names is checked against
them, where it really leads (a link out of a root is refused):

| Node Type | Needs |
| --- | --- |
| `VideoThumbnail` | `read` on the video; `write` on `output`, or on `outputDir`. Its own `thumbnails` folder, used when neither is set, needs none. |
| `ExtractFrames`, `DetectScenes` | As `VideoThumbnail`, with their own `frames` and `scenes` folders. |
| `VideoFiles` | `read` on each file, when `checkContent` is on. A file out of reach is left out, with the reason `out of reach: …`; with no Allowed roots at all, the Task fails. |
| `IsVideo` | `read` on the file, when `checkContent` is on. A file out of reach fails the Task: it is the Profile to fix, not a file that is no video. |

The Profile's own fields (`executablePath`, `fontFile`) are not checked: only a Profile sets them.

## Develop

```sh
pnpm install
pnpm fetch-service  # downloads the pinned thumbs-collage release into .service/, for the tests
pnpm check          # typecheck, lint, tests
```

To try a build of your own in the app, run `pnpm plugin-folder` and pick `dist/video-thumbnail` with **Choose folder…** on the
Plugins page. That folder holds only what a Host loads (the code, `assets/` and a package.json): the app's
installer copies a folder whole and refuses one holding a link, which this repo's `node_modules` is full of. The
desktop app provides the SDK by itself.

On a server Host you can instead put a link to this repo in the Plugin directory, with `fyflow-plugin-sdk` installed
there (`npm install fyflow-plugin-sdk` in the Plugin directory), then Reload.

## The thumbnail service

The service is not in the Plugin. The first of the `VideoThumbnail`, `ExtractFrames` and `DetectScenes` Workers to start
on a Host downloads it, once its `setup()` has begun, from the GitHub release `release.ts` pins: version `SERVICE_VERSION` (0.1.0), one archive per platform,
each checked against its SHA-256 before it is unpacked. It goes into the Plugin's data directory (`dataDir: true`,
fyflow-plugin-sdk 0.6.0), under `service/thumbs-collage-<version>-<platform>/`, which the Host keeps across Reloads,
updates and reinstalling, so it is downloaded once per Host and version. A Host's first Tasks wait for the
download (about 80 MB on Windows and Linux, which carry their FFmpeg libraries), saying so in their progress with how
much has arrived; the Worker tries it three times before they fail, as every Task of that Worker instance then does
until its pool retires it. Older versions' folders stay until you delete them from the Plugin's Data dialog.

The release has archives for Windows x64, Linux x64 and macOS arm64. The macOS one needs FFmpeg 8 installed (for
example with Homebrew). On any other platform, or to use a build of your own, set `executablePath` in the Profile;
the Worker then downloads nothing. The service must take `--exit-on-stdin-close` (the Worker always passes it).

To move to a new release, change `SERVICE_VERSION`, run `pnpm fetch-service --hash`, check its hashes against the
release, and paste them into `ASSETS`.

`ExtractFrames` and `DetectScenes` need thumbs-collage 0.1.0 or later. With an older one in `executablePath`, their
Tasks fail with `This thumbs-collage has no /frames: it is older than 0.1.0`.

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

**Where the file goes.** First `output`. Without it, the Profile's `outputDir`. Without that, the Plugin's own
`thumbnails/` folder in its data directory (`<Host data>/plugin-data/fyflow-ext.video-thumbnail/thumbnails/`),
which nothing clears by itself ([below](#its-data-directory)). In a folder, the file is named `<video name>.<hash>.jpg`. The hash covers the video's path, size and
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

## `ExtractFrames` and `DetectScenes`

Both write a folder per job, `<video name>.<hash>/`, holding the images and a manifest (`frames.json`,
`scenes.json`): the service's reply, with each `file` relative to the folder, so the folder can be moved. Their
options come from the Node's settings or the Task input as `VideoThumbnail`'s do, and `path` from the input only.

**Where the folder goes.** In `output` (a folder), else the Profile's `outputDir`, else the Plugin's own `frames/` or
`scenes/` folder in its data directory. The hash covers the video's path, size and last change, and the options, as
for thumbnails: a Task on an unchanged video with the same options reuses the folder (`reused: true`) unless
`overwrite` is set. The service writes into `<folder>.<job id>.part/` beside it, which is renamed into place once the
manifest is written, so a folder with the job's name is always complete.

**`lists`.** `file` (the default) leaves the lists in the manifest; `result` also puts them in the Task's result, with
absolute paths, for a `map` right after. With `file`, a Flow reads the manifest with fyflow.fs's `ReadFile`
(`as: "json"`), which needs a `read` root on the folder: for the Plugin's own folders, add the Plugin's data folder as
a root ([below](#its-data-directory)). Either way the result has `count`: a `map` over an empty list never reaches
its join, so route on `count` greater than `0`.

**Size and memory.** `width`, `height` and `fit` size every image of a job: 640 wide when neither side is set; with
both, `contain` (the default) fits inside the box, `cover` crops to it, `stretch` distorts. There is no cap on counts
or sizes. The service holds every frame decoded until the job ends, about `frames × width × height × 4` bytes, so
2,000 frames at 4K would take about 66 GB and abort it: keep counts and sizes sane. `format` is `jpeg` (the default)
or `png`; `quality` (JPEG only) is the service's, 80, unless set. JPEG frames carry the service's metadata (video,
duration, index, timestamps, scene) in their comment segment; PNG frames carry none.

### `ExtractFrames`

One image per requested timestamp (the service's `POST /frames`), named `frame_000.jpg` on.

| Field | What it is |
| --- | --- |
| `output`, `overwrite`, `lists` | As above. |
| `selection` | As `VideoThumbnail`'s; 8 evenly spaced frames unless set. |
| `width`, `height`, `fit`, `format`, `quality` | As above. |
| `skipBlankFrames` | Step past black or solid frames (on unless set off). |
| `forceFallback` | As `VideoThumbnail`'s. |

**Result:** `{ folder, manifest, count, video, duration, reused }`, and with `lists: "result"` also
`frames: [{ path, index, requested, actual }]` and `missing` (the indexes in the selection the service could not
decode, which `frames` leaves out).

### `DetectScenes`

Scene cuts, and optionally frames picked from each scene in the same pass (the service's `POST /scenes`). The
detectors follow [PySceneDetect](https://www.scenedetect.com/).

| Field | What it is |
| --- | --- |
| `output`, `overwrite`, `lists` | As above. |
| `hint` | `anime`, `cg` or `real`: what kind of video this is, picking the detector's defaults; explicit fields win. Unset unless given. |
| `detector` | `content` (the default) or `scdet` decode every frame, about one full decode of the video; `keyframes` reads only packet flags, fast but only as good as the encoder's keyframes. |
| `threshold` | The score at which a cut fires; the detector's own unless set. |
| `minSceneLen` | The shortest scene, in seconds (0.6 unless set). |
| `frames` | `{ every, minPerScene, maxPerScene, margin, maxFrames, width, height, fit, format, quality }`: frames per scene, `ceil(length / every)` between the two bounds (2 s, 1 to 3 unless set), `margin` seconds in from each end. Left out, only the scenes are detected. |
| `skipBlankFrames` | With `frames`: a blank pick is replaced by the nearest frame that isn't (on unless set off). |
| `advanced` | `{ adaptive: { ratio, window, minScore } or null, flashFilter, weights: { hue, sat, lum }, skipNonref }`, for tuning. |

The service refuses a field the chosen detector doesn't use (`threshold` with `keyframes`, say) with a 400, and the
Task fails with its message.

The service's measured scores for each `hint` (F1, on 898 labelled cuts) are 0.92 for anime, 0.95 for CG films and
0.93 for live action, against 0.90 with none: set it when you know. `advanced.skipNonref` decodes only the frames
other frames refer to, 1.3 to 2 times faster for a slightly lower score; it also helps with interlaced H.264 TV
recordings the full pass finds too damaged.

**Result:** `{ folder, manifest, count, frameCount, video, duration, detector, reused }`, `count` being the scenes,
and with `lists: "result"` also `scenes: [{ index, start, end, mid }]` (seconds, `end` exclusive, `mid` the middle)
and `frames: [{ path, index, scene, target, timestamp }]`. Without `frames` the folder holds only `scenes.json`,
kept like any other: detection decodes the whole video, so it is worth not doing twice.

### Examples

Frames of every video in a folder, each classified by an image tagger:

```
ListFolder → VideoFiles → map(entries) → ExtractFrames (lists: result) → map(frames) → ClassifyImage
```

One frame from the middle of each scene: `DetectScenes` with `lists: "result"`, then an `ExtractFrames` whose
JSONata transform turns the scenes' middles into its selection (or a `VideoThumbnail`, with a `collage` that has a
place for each):

```json
{
  "id": "per-scene", "kind": "task", "type": "ExtractFrames",
  "transform": { "lang": "jsonata",
    "expr": "{ \"path\": video, \"selection\": { \"mode\": \"timestamps\", \"timestamps\": [scenes.mid] } }" }
}
```

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

## Its data directory

The Host keeps the Plugin's data directory across Reloads, updates and reinstalling. It holds:

- `service/thumbs-collage-<version>-<platform>/`: the downloaded service, and any older version's folder;
- `thumbnails/`, `frames/`, `scenes/`: what Tasks that set neither `output` nor `outputDir` made;
- `*.part` files and folders in those three: what a job that never ended left behind ([Cancelling](#cancelling)).

The Plugin never deletes any of them. On a Host with fyflow-plugin-sdk 0.12, its card's **Data** link lists them with
their sizes (the Plugin's `data()`, in `data.ts`), and a person deletes one, or all, there. Deleting the service only
means it is downloaded again; deleting `thumbnails/`, `frames/` or `scenes/` means Tasks make them again, and earlier Run
results name files that are gone. A `*.part` is free to delete.

To prune thumbnails from a Flow instead, for example with `fyflow.fs`'s delete after a later Node has used them, or
to let another Plugin read them (an image tagger), give that Plugin an Allowed root on the Profiles page with **Add a
Plugin's data folder** (fyflow-app with ADR-0032), picking `fyflow-ext.video-thumbnail`. That root is the whole data
directory, service included, so point the delete at `thumbnails/` (or `frames/`, `scenes/`) or what is in it, and
grant `read` where reading is all that is needed, as for `ReadFile` on a manifest. This Plugin's own Tasks reach its
own folders without a root.

## How it runs

`VideoThumbnail`, `ExtractFrames` and `DetectScenes` each have an inline pool with one Worker instance per Profile,
retired after 30 s with no Tasks; `VideoThumbnail` and `ExtractFrames` run up to 4 Tasks at once, `DetectScenes` 2
(each decodes the whole video). They share one service per executable and font, so normally one for the Host: the
first instance to start starts it, after downloading it if this Host has not yet, and the last one to stop stops it.
It runs:

- on a free port of 127.0.0.1;
- with its progress WebSocket on;
- with `--exit-on-stdin-close`, so it dies with the Host however the Host ends;
- with a job limit (64) high enough never to matter: the pools and the Host's Resource Groups are the limit.

Each Task takes one slot of the Host's `cpu` group and one of its `disk` group while it runs. The service decodes on
one thread per job, so a Task keeps one processor busy. To hold these Node Types to fewer at once than that, make a
Resource Group of your own and name it in a Flow's `groups` or a Node's.

Each Task is one request: `POST /make_collage`, `/frames` or `/scenes`. Its progress arrives over the WebSocket and
goes to the Task's progress. If the service dies, the Tasks in flight fail with its last lines of output, every
instance using it asks its pool to replace it, and the next one to start starts a new service.

`setup()` only checks what it can at once (that `executablePath` names a file, that there is a data directory to
download to), failing there if not, and starts getting the service without waiting for it: `setup()` has no Task to
report to. A Task that comes before the service is ready says in its progress what it waits for, `Downloading the
thumbnail service, thumbs-collage 0.1.0 (12.3 of 80.1 MB)`, then `Starting the thumbnail service`, and a cancelled one
stops waiting. `setup()`, `teardown()` and that last request (`terminateWithError`) are the Worker lifecycle
fyflow-plugin-sdk promises since 0.5.0.

### Status

The Plugin's card on the Host's Plugins page (`status()`, fyflow-plugin-sdk 0.6.0) says what the service is doing:

| Status | When |
| --- | --- |
| `ok` thumbs-collage running · 2 jobs in flight | Running, with its process id, address, jobs in flight and executable in the details; each service apart if a Profile's own `executablePath` or `fontFile` started another. |
| `info` Downloading thumbs-collage 0.1.0 (12.3 of 80.1 MB) | A first Task is waiting for the download. |
| `info` Starting thumbs-collage | A service is starting, and has not yet said where it listens. |
| `warning` thumbs-collage failed: … | The last download or start failed, or a running service died: the first line of why, and when. Cleared once a service starts. |
| `ok` thumbs-collage 0.1.0 not running / not downloaded yet | No Task has needed it lately: the next one starts it, downloading it first if it is not there. |

It reads what the Workers share on the Host's thread, and never starts or downloads anything itself.

### Cancelling

A cancelled Task stops at once: the Plugin aborts its request and removes its staging folder. The service (0.1.0)
does not notice, though. The job runs to its end, keeping a processor busy after the Host has given the Task's `cpu`
slot to the next Task (a minute or more for `DetectScenes` on a long video), and an `ExtractFrames` or `DetectScenes`
job writes its images into a staging folder again. The Data dialog lists such leftovers as `*.part`, free to delete.
Stopping the job is the service's to do, and has been asked for there.

## Tests

The tests run against the real service, the one `pnpm fetch-service` downloads into `.service/` (given to the Worker
as its data directory), and skip themselves when it is missing. `test/fixtures/sample.mp4` is
1 s of black, then 5 s of ffmpeg's test pattern. `pnpm make-fixture` remakes it with the ffmpeg in `$FFMPEG_DIR/bin`.

## Release

The Plugin is released into the official fyflow Plugin repository,
[fyflow/fyflow-plugins](https://github.com/fyflow/fyflow-plugins). On a tag `<id>@<version>`,
`.github/workflows/release.yml` calls its reusable workflow, which builds the Plugin folder (`fyflow.build`,
`pnpm plugin-folder`), packs `dist/video-thumbnail` (`fyflow.pack`) and creates a GitHub Release with the tarball. The
tarball is the code, the font and the licences, a few hundred KB: the service is not in it. The index shows
`fyflow.name`, `fyflow.icon`, `description` and `homepage`. CI's `pack` job checks every push packs the same way.

1. Set the version in `package.json` and in `plugin.ts` (they must agree), and commit.
2. Check it packs and installs: `pnpm plugin-folder`, then `npx fyflow-plugin pack dist/video-thumbnail --out <dir>`,
   upload the tarball on a Host's Plugins page (`FYFLOW_PLUGINS_INSTALL=any`), add an Allowed root, and run a Task of
   each Node Type. The first Task of a service Node Type downloads the service.
3. Tag and push: `git tag fyflow-ext.video-thumbnail@<version> && git push origin fyflow-ext.video-thumbnail@<version>`.
4. With a `FYFLOW_PLUGINS_TOKEN` secret (a classic token with `public_repo`), the workflow opens the PR against
   fyflow-plugins itself. Without one it stops after the Release, and the PR is opened by hand from the run's artifacts,
   as fyflow-plugin-anidb's README describes. Watch its checks with
   `gh pr checks <url> --repo fyflow/fyflow-plugins --watch`: its **admit** check must pass.

A published version never changes: to fix one, release the next. The service's version is part of the Plugin's: a new
thumbs-collage release means a new Plugin version with new hashes in `release.ts`.
