// The `VideoFiles` Worker: of the list that reaches it (`ListFolder`'s entries, or absolute paths), the videos, each
// as it came, and why each other one was left out. Where the list is in the Task input, and where the path is in each
// item, are the Node's settings. A video has one of the Node's extensions and, unless the Node turns it off, a video
// container's signature in its first bytes (./formats.ts). Nothing is decoded.
import type { TaskEnvelope, Worker, WorkerContext } from "fyflow-plugin-sdk";
import { normalized, VIDEO_EXTENSIONS, valueAt, verdictOf } from "./formats.ts";

export interface Settings {
  list?: string;
  pathKey?: string;
  extensions?: string[];
  checkContent?: boolean;
}

export interface VideoFilesResult {
  /** How many videos: a `map` over no `entries` can never reach its join, so route around it when this is 0. */
  count: number;
  /** The videos, as objects: each object item as it came, and each path as `{ path }`. */
  entries: Record<string, unknown>[];
  /** The rest, in the order they came, and why. */
  skipped: { path: string; reason: string }[];
}

/** How many files are read at once: on a network share, waiting on each in turn is most of the time it takes. */
const AT_ONCE = 16;

export default class VideoFiles implements Worker<Settings, unknown, VideoFilesResult> {
  async run(envelope: TaskEnvelope<Settings>, context: WorkerContext): Promise<VideoFilesResult> {
    const {
      list = "entries",
      pathKey = "path",
      extensions = [...VIDEO_EXTENSIONS],
      checkContent = true,
    } = envelope.settings;
    const wanted = normalized(extensions);
    const items = itemsAt(envelope.input, list);
    const paths = items.map((item, i) => pathOf(item, pathKey, `${listName(list)}[${i}]`));

    // Each item's reason to be left out, in its place, however the reads finish; null for a video.
    const reasons: (string | null)[] = new Array(items.length).fill(null);
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < items.length) {
        const index = next++;
        context.signal.throwIfAborted();
        const item = items[index];
        const kind =
          typeof item === "object" && item !== null ? (item as { kind?: unknown }).kind : undefined;
        if (kind !== undefined && kind !== "file") reasons[index] = `a ${kind}`;
        else {
          const verdict = await verdictOf(paths[index] as string, wanted, checkContent);
          reasons[index] = verdict.video ? null : verdict.reason;
        }
        done++;
        if (done % 100 === 0)
          context.sendProgress(done / items.length, `Looked at ${done} of ${items.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, lane));

    const result: VideoFilesResult = { count: 0, entries: [], skipped: [] };
    items.forEach((item, index) => {
      const path = paths[index] as string;
      const reason = reasons[index] ?? null;
      if (reason === null)
        result.entries.push(typeof item === "string" ? { path } : (item as Record<string, unknown>));
      else result.skipped.push({ path, reason });
    });
    result.count = result.entries.length;
    context.sendProgress(1, `${result.count} of ${items.length} are videos`);
    return result;
  }
}

const listName = (list: string) => (list === "." ? "the Task input" : `\`${list}\``);

/** The list at `list` in the Task input; refused, saying where it looked, if there is none. */
function itemsAt(input: unknown, list: string): unknown[] {
  const items = valueAt(input, list);
  if (!Array.isArray(items))
    throw new Error(
      `No list at ${listName(list)} in the Task input: put this Node after a \`ListFolder\`, or set \`list\` to where the list is`,
    );
  return items;
}

/** The absolute path `item` names: the item itself when it is a string, else the string at `pathKey` in it. */
function pathOf(item: unknown, pathKey: string, name: string): string {
  const path = typeof item === "string" ? item : valueAt(item, pathKey);
  if (typeof path !== "string")
    throw new Error(
      `${name} has no path at \`${pathKey}\`: set \`pathKey\` to where its path is (${JSON.stringify(item)})`,
    );
  return path;
}
