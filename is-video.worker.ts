// The `IsVideo` Worker: whether one file is a video, by `VideoFiles`' test (./formats.ts), for the Node's Edges to
// route on (`outcome.result.video`). The file is its `path` setting, else the Task input when it is a path, else the
// path at `pathKey` in it, so in a `map` over a listing it checks each item. A file that is no video is a result,
// never a failure.
import type { TaskEnvelope, Worker, WorkerContext } from "fyflow-plugin-sdk";
import { normalized, VIDEO_EXTENSIONS, valueAt, verdictOf } from "./formats.ts";

export interface Settings {
  path?: string;
  pathKey?: string;
  extensions?: string[];
  checkContent?: boolean;
}

export interface IsVideoResult {
  path: string;
  video: boolean;
  /** The container its first bytes say it is, when they were read and it is a video. */
  container?: string;
  /** Why it is not a video. */
  reason?: string;
}

export default class IsVideo implements Worker<Settings, unknown, IsVideoResult> {
  async run(envelope: TaskEnvelope<Settings>, context: WorkerContext): Promise<IsVideoResult> {
    const { pathKey = "path", extensions = [...VIDEO_EXTENSIONS], checkContent = true } = envelope.settings;
    context.signal.throwIfAborted();
    const set = envelope.settings.path;
    const { input } = envelope;
    const path =
      set !== undefined && set !== "" ? set : typeof input === "string" ? input : valueAt(input, pathKey);
    if (typeof path !== "string")
      throw new Error(
        `No path at \`${pathKey}\` in the Task input: set \`path\`, or set \`pathKey\` to where the path is`,
      );
    return { path, ...(await verdictOf(path, normalized(extensions), checkContent)) };
  }
}
