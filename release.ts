// The thumbs-collage service is not shipped with the Plugin: a Worker downloads its release archive from GitHub the
// first time it starts, into the Plugin's data directory, which the Host keeps across Reloads, updates and
// reinstalling. Each archive is pinned by version and SHA-256, so a release changed after the fact is refused, and a
// new version means new hashes here (`pnpm fetch-service --hash` prints them).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setDownload } from "./activity.ts";
import { EXECUTABLE } from "./service.ts";

export const SERVICE_VERSION = "0.2.0";
export const SERVICE_REPO = "tsukeero/rust-video-thumbnail-generator";

export interface Asset {
  /** The archive's file name in the release; its folder inside is the same name without the extension. */
  name: string;
  sha256: string;
}

/** The release's archives, by `${process.platform}-${process.arch}`. The macOS one needs FFmpeg 8 installed. */
export const ASSETS: Record<string, Asset> = {
  "win32-x64": {
    name: `thumbs-collage-${SERVICE_VERSION}-windows-x86_64.zip`,
    sha256: "e1ab421b0182df611598d59e8b87c4a064f31c39d0b7bb11dc3fed2a06e1de6d",
  },
  "linux-x64": {
    name: `thumbs-collage-${SERVICE_VERSION}-linux-x86_64.tar.gz`,
    sha256: "0c0ac36ae7a0d2d6d5619a83278e2f12c8cc76929badef389cf88f93b4938195",
  },
  "darwin-arm64": {
    name: `thumbs-collage-${SERVICE_VERSION}-macos-aarch64.tar.gz`,
    sha256: "e6ec379b14d9a7cd121c500ab9aef22ee1cf8613bfc2fbc438a135eb5045a42c",
  },
};

export const assetUrl = (asset: Asset) =>
  `https://github.com/${SERVICE_REPO}/releases/download/v${SERVICE_VERSION}/${asset.name}`;

const folderOf = (asset: Asset) => asset.name.replace(/\.(zip|tar\.gz)$/, "");

/** The folder this platform's archive unpacks into, if the release has one for it. */
export function platformFolder(): string | undefined {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  return asset === undefined ? undefined : folderOf(asset);
}

export interface EnsureOptions {
  /** This platform's archive unless set; tests give their own. */
  asset?: Asset;
  /** Where to fetch `asset` from; its GitHub release unless set. */
  url?: string;
  /** How many times to try the download before giving up (3 unless set). */
  attempts?: number;
}

/** Where `ensureService(dir)` puts this platform's executable, whether it is there yet or not. */
export function installedExecutable(
  dir: string,
  asset = ASSETS[`${process.platform}-${process.arch}`],
): string | undefined {
  return asset === undefined ? undefined : join(dir, folderOf(asset), EXECUTABLE);
}

/** Downloads in flight in this process, by the folder they make, so instances starting together share one. */
const inFlight = new Map<string, Promise<void>>();

/**
 * The service's executable under `dir`, downloaded, checked and unpacked there first if it is not there yet. The
 * unpacked folder is moved into place whole, so a folder that is there is complete, whichever process made it.
 */
export function ensureService(dir: string, options: EnsureOptions = {}): Promise<string> {
  const target = `${process.platform}-${process.arch}`;
  const asset = options.asset ?? ASSETS[target];
  if (asset === undefined)
    return Promise.reject(
      new Error(
        `thumbs-collage ${SERVICE_VERSION} has no release for ${target}: build it from https://github.com/${SERVICE_REPO} and set \`executablePath\` in the fyflow-ext.video-thumbnail section of this Node's Profile`,
      ),
    );
  const folder = join(dir, folderOf(asset));
  const executable = join(folder, EXECUTABLE);
  if (existsSync(executable)) return Promise.resolve(executable);
  let pending = inFlight.get(folder);
  if (pending === undefined) {
    pending = install(dir, folder, asset, options).finally(() => inFlight.delete(folder));
    inFlight.set(folder, pending);
  }
  return pending.then(() => executable);
}

async function install(dir: string, folder: string, asset: Asset, options: EnsureOptions): Promise<void> {
  const url = options.url ?? assetUrl(asset);
  const attempts = options.attempts ?? 3;
  let bytes: Uint8Array | undefined;
  try {
    for (let attempt = 1; bytes === undefined; attempt++) {
      try {
        bytes = await download(url);
      } catch (error) {
        if (attempt >= attempts)
          throw new Error(
            `Could not download the thumbnail service from ${url}: ${(error as Error).message}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  } finally {
    setDownload(undefined);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== asset.sha256)
    throw new Error(
      `The thumbnail service downloaded from ${url} is not the one this Plugin pins: its SHA-256 is ${sha256}, not ${asset.sha256}`,
    );

  const work = join(dir, `.download-${randomUUID()}`);
  try {
    await mkdir(work, { recursive: true });
    const archive = join(work, asset.name);
    await writeFile(archive, bytes);
    const unpacked = join(work, "unpacked");
    await mkdir(unpacked);
    await extract(archive, unpacked);
    const inside = join(unpacked, folderOf(asset));
    if (!existsSync(join(inside, EXECUTABLE)))
      throw new Error(
        `${asset.name} holds no ${folderOf(asset)}/${EXECUTABLE}, only: ${(await readdir(unpacked)).join(", ")}`,
      );
    try {
      await rename(inside, folder);
    } catch (error) {
      // Another process moved its copy into place first: that one will do.
      if (!existsSync(join(folder, EXECUTABLE))) throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** How often a download's progress is passed on, at most. */
const PROGRESS_EVERY_MS = 500;

/** The archive at `url`, its progress passed on (./activity.ts) for the Plugin's status and the Tasks waiting. */
async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let reported = 0;
  setDownload({ version: SERVICE_VERSION, received, total });
  if (response.body === null) return new Uint8Array(await response.arrayBuffer());
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (Date.now() - reported >= PROGRESS_EVERY_MS) {
      reported = Date.now();
      setDownload({ version: SERVICE_VERSION, received, total });
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Unpacks `archive` into `to` with the system's tar: on Windows, its own bsdtar, which reads zip too (a tar earlier
 * on the PATH, such as Git's, may not).
 */
function extract(archive: string, to: string): Promise<void> {
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ["-xf", archive, "-C", to], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      reject(new Error(`Could not run ${tar} to unpack ${archive}: ${error.message}`)),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${tar} failed to unpack ${archive} (exit code ${code}): ${stderr}`)),
    );
  });
}
