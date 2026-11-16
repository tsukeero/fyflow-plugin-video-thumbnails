// The Plugin's data directory, which the Host keeps across Reloads, updates and reinstalling: the thumbnail service
// downloaded into `service/`, and what Tasks made with no `output` or `outputDir`: thumbnails in `thumbnails/`, frame
// folders in `frames/`, scene folders in `scenes/`. `dataOf` says
// what is there for the Plugin's Data dialog (fyflow-plugin-sdk 0.12.0), where a person sees how much it keeps and
// deletes it: the Plugin itself never deletes any of it.
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginData, PluginDataContext, PluginDataItem } from "fyflow-plugin-sdk";
import { platformFolder, SERVICE_VERSION } from "./release.ts";

export const THUMBNAILS = "thumbnails";
export const SERVICE = "service";
export const FRAMES = "frames";
export const SCENES = "scenes";

/** Where thumbnails go when neither the Task nor its Profile says where. */
export const thumbnailsDir = (dataDir: string) => join(dataDir, THUMBNAILS);
/** Where the service's releases are unpacked, one folder each. */
export const serviceDir = (dataDir: string) => join(dataDir, SERVICE);

/** The entries of `dir`, or none when it is not there (or cannot be read). */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A staging file or folder a job writes before renaming it into place: left behind only by one that never ended. */
const isPart = (entry: Dirent) => entry.name.endsWith(".part");

/**
 * What is in the data directory now, item by item: the thumbnails, frames and scenes folders, what unfinished jobs
 * left in them, and each folder under `service/`.
 */
export function dataOf({ dataDir }: PluginDataContext): PluginData {
  const items: PluginDataItem[] = [];

  const thumbnails = entriesOf(thumbnailsDir(dataDir));
  const made = thumbnails.filter((e) => e.isFile() && /\.jpe?g$/i.test(e.name)).length;
  if (thumbnails.length > 0)
    items.push({
      path: THUMBNAILS,
      label: `${plural(made, "thumbnail")} made where a Task set no output or outputDir`,
      lost: "Made again when a Task next asks for one; earlier Run results naming one point at nothing",
    });
  const kept = [
    { name: FRAMES, one: "frame folder" },
    { name: SCENES, one: "scene folder" },
  ];
  const folders: Record<string, Dirent[]> = { [THUMBNAILS]: thumbnails };
  for (const { name, one } of kept) {
    const entries = entriesOf(join(dataDir, name));
    folders[name] = entries;
    if (entries.length === 0) continue;
    const count = entries.filter((e) => e.isDirectory() && !isPart(e)).length;
    items.push({
      path: name,
      label: `${plural(count, one)} made where a Task set no output or outputDir`,
      lost: "Made again when a Task next asks; earlier Run results naming them point at nothing",
    });
  }
  for (const [name, entries] of Object.entries(folders))
    for (const entry of entries.filter(isPart).sort((a, b) => a.name.localeCompare(b.name)))
      items.push({ path: `${name}/${entry.name}`, label: "An unfinished job", lost: "Nothing" });

  const current = platformFolder();
  let installed = false;
  for (const entry of entriesOf(serviceDir(dataDir)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = `${SERVICE}/${entry.name}`;
    if (entry.name === current) {
      installed = true;
      items.push({
        path,
        label: `Thumbnail service ${SERVICE_VERSION}`,
        lost: "Downloaded again when a thumbnail is next made",
      });
    } else if (entry.name.startsWith(".download-"))
      items.push({ path, label: "An unfinished download of the thumbnail service", lost: "Nothing" });
    else
      items.push({
        path,
        label: `${entry.name}, an older thumbnail service`,
        lost: `Nothing: this version of the Plugin uses ${SERVICE_VERSION}`,
      });
  }

  return {
    summary: `${plural(made, "thumbnail")}; thumbnail service ${SERVICE_VERSION} ${installed ? "downloaded" : "not downloaded yet"}`,
    items,
  };
}
