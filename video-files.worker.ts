// The `VideoFiles` Worker: of the entries that reach it (`ListFolder`'s, or absolute paths), the videos, each as it
// came, and why each other one was left out. A video has one of the Node's extensions and, unless the Node turns it
// off, a video container's signature in its first bytes (./formats.ts). Nothing is decoded: it is a filter, cheap
// enough to put before every `VideoThumbnail`.
import type { TaskEnvelope, Worker, WorkerContext } from "fyflow-plugin-sdk";
import { containerOf, hasExtension, headOf, normalized, VIDEO_EXTENSIONS } from "./formats.ts";
import { absolute } from "./options.ts";

export interface Settings {
  extensions?: string[];
  checkContent?: boolean;
}

/** An entry as it reached the Node: an absolute path, or an object with one, such as a `ListFolder` entry. */
export type Entry = string | { path: string; kind?: string; [key: string]: unknown };

export interface VideoFilesResult {
  /** The videos, as objects: each object entry as it came, and each path as `{ path }`. */
  entries: { path: string; [key: string]: unknown }[];
  /** The rest, in the order they came, and why. */
  skipped: { path: string; reason: string }[];
}

/** How many files are read at once: on a network share, waiting on each in turn is most of the time it takes. */
const AT_ONCE = 16;

export default class VideoFiles implements Worker<Settings, unknown, VideoFilesResult> {
  async run(envelope: TaskEnvelope<Settings>, context: WorkerContext): Promise<VideoFilesResult> {
    const { extensions = [...VIDEO_EXTENSIONS], checkContent = true } = envelope.settings;
    const wanted = normalized(extensions);
    const given = entriesOf(envelope.input);

    // Each entry's verdict, in its place, however the reads finish.
    const verdicts: (string | null)[] = new Array(given.length).fill(null);
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < given.length) {
        const index = next++;
        context.signal.throwIfAborted();
        verdicts[index] = await reasonToSkip(given[index] as Entry, wanted, checkContent);
        done++;
        if (done % 100 === 0)
          context.sendProgress(done / given.length, `Looked at ${done} of ${given.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, given.length) }, lane));

    const result: VideoFilesResult = { entries: [], skipped: [] };
    given.forEach((entry, index) => {
      const object = typeof entry === "string" ? { path: entry } : entry;
      const reason = verdicts[index] ?? null;
      if (reason === null) result.entries.push(object);
      else result.skipped.push({ path: object.path, reason });
    });
    context.sendProgress(1, `${result.entries.length} of ${given.length} are videos`);
    return result;
  }
}

/** The Task input's `entries`, each an absolute path or an object with one; refused, saying why, if not. */
function entriesOf(input: unknown): Entry[] {
  const entries =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).entries
      : undefined;
  if (!Array.isArray(entries))
    throw new Error(
      "No `entries` in the Task input: pass a list of paths, or put this Node after a `ListFolder`",
    );
  entries.forEach((entry, i) => {
    const path = typeof entry === "object" && entry !== null ? (entry as { path?: unknown }).path : entry;
    if (typeof path !== "string")
      throw new Error(`\`entries[${i}]\` must be a path or an object with one, not ${JSON.stringify(entry)}`);
  });
  return entries as Entry[];
}

/** Why `entry` is not a video, or null when it is one. */
async function reasonToSkip(entry: Entry, wanted: ReadonlySet<string>, checkContent: boolean) {
  const path = typeof entry === "string" ? entry : entry.path;
  if (typeof entry !== "string" && entry.kind !== undefined && entry.kind !== "file")
    return `a ${entry.kind}`;
  if (!absolute(path)) return "not an absolute path";
  if (!hasExtension(path, wanted)) return "not a video extension";
  if (!checkContent) return null;
  try {
    return containerOf(await headOf(path)) === null ? "not a video container" : null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return `unreadable${typeof code === "string" ? ` (${code})` : ""}`;
  }
}
