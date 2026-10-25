// The thumbs-collage service, run as a child process: started on a free port of 127.0.0.1, sent one
// `POST /make_collage` per thumbnail, and heard on its `/ws-progress` WebSocket, which broadcasts every job's progress
// by job id. It is started with `--exit-on-stdin-close` and its stdin kept open, so it dies with us however we end.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/** The service's executable's file name on this platform. */
export const EXECUTABLE = process.platform === "win32" ? "thumbs-collage.exe" : "thumbs-collage";

/** Where `pnpm copy-service` puts the service for this platform, under the Plugin's folder `root`. */
export function serviceDir(root: string): string {
  return join(root, "bin", `${process.platform}-${process.arch}`);
}

export interface StartOptions {
  executable: string;
  /** A TTF font for timestamp overlays; without one the service draws none. */
  fontFile?: string | undefined;
  /** How long the service may take to say where it listens (10 s unless set). */
  startTimeoutMs?: number;
  /** Called once if the service exits without being stopped, with the exit and its last lines of output. */
  onExit?: (error: Error) => void;
}

export interface CollageOptions {
  signal?: AbortSignal | undefined;
  /** The job's progress as the service reports it: a fraction from 0 to 1, and what it is doing. */
  onProgress?: (progress: number, message: string) => void;
}

export interface Service {
  readonly url: string;
  readonly pid: number;
  /** Makes one collage, the request in the service's own terms; resolves with the JPEG. */
  collage(request: Record<string, unknown>, options?: CollageOptions): Promise<Uint8Array>;
  /** Stops the service: closes its stdin, and kills it if it has not exited a few seconds later. */
  stop(): Promise<void>;
}

/** How many of the service's last lines of output an error carries. */
const TAIL_LINES = 50;
/** No limit on concurrent jobs worth having in the service: the Worker's pool is what limits them. */
const MAX_JOBS = 64;

export async function startService(options: StartOptions): Promise<Service> {
  const args = [
    "--bind",
    "127.0.0.1:0",
    "--ws-progress",
    "--exit-on-stdin-close",
    "--max-workers",
    `${MAX_JOBS}`,
  ];
  if (options.fontFile !== undefined) args.push("--font-file", options.fontFile);
  const child = spawn(options.executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const tail = outputTail(child);
  const url = await listening(child, tail, options);
  return new RunningService(child, url, tail, options.onExit);
}

/** The last lines `child` wrote, on either stream. Both are always read: a full pipe would block the service. */
function outputTail(child: ChildProcess): { lines: string[]; text(): string } {
  const lines: string[] = [];
  const read = (stream: NodeJS.ReadableStream | null) => {
    let partial = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? "";
      lines.push(...parts.filter((line) => line.length > 0));
      if (lines.length > TAIL_LINES) lines.splice(0, lines.length - TAIL_LINES);
    });
  };
  read(child.stdout);
  read(child.stderr);
  return { lines, text: () => lines.join("\n") };
}

/** The service's URL, once it says where it listens; refused if it fails, exits or takes too long first. */
function listening(
  child: ChildProcess,
  tail: { lines: string[]; text(): string },
  options: StartOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.startTimeoutMs ?? 10_000;
    const done = (error?: Error, url?: string) => {
      clearTimeout(timer);
      clearInterval(poll);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error === undefined && url !== undefined) return resolve(url);
      child.kill();
      reject(error);
    };
    const onError = (error: Error) =>
      done(new Error(`Could not start the thumbnail service "${options.executable}": ${error.message}`));
    const onExit = (code: number | null, signal: string | null) =>
      done(
        new Error(`The thumbnail service exited while starting (${exitOf(code, signal)}):\n${tail.text()}`),
      );
    const timer = setTimeout(
      () => done(new Error(`The thumbnail service did not start in ${timeoutMs} ms:\n${tail.text()}`)),
      timeoutMs,
    );
    // The tail is the one reader of stdout; the line we wait for is looked for there.
    const poll = setInterval(() => {
      for (const line of tail.lines) {
        const match = /Listening on (http:\/\/\S+)/.exec(line);
        if (match?.[1] !== undefined) return done(undefined, match[1]);
      }
    }, 10);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

const exitOf = (code: number | null, signal: string | null) =>
  signal !== null ? `killed by ${signal}` : `exit code ${code}`;

class RunningService implements Service {
  readonly url: string;
  readonly pid: number;
  readonly #child: ChildProcess;
  readonly #tail: { text(): string };
  readonly #progress = new Map<string, (progress: number, message: string) => void>();
  /** Every request in flight, to abort with the reason should the service die under it. */
  readonly #inFlight = new Set<AbortController>();
  #socket: WebSocket | undefined;
  #exit: Promise<void>;
  /** Why requests can no longer be made: the service stopped, or died. */
  #gone: Error | undefined;

  constructor(
    child: ChildProcess,
    url: string,
    tail: { text(): string },
    onExit: ((error: Error) => void) | undefined,
  ) {
    this.#child = child;
    this.url = url;
    this.pid = child.pid ?? -1;
    this.#tail = tail;
    this.#exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve();
        if (this.#gone !== undefined) return;
        const error = new Error(
          `The thumbnail service exited unexpectedly (${exitOf(code, signal)}):\n${this.#tail.text()}`,
        );
        this.#gone = error;
        this.#socket?.close();
        for (const controller of this.#inFlight) controller.abort(error);
        onExit?.(error);
      });
    });
    this.#listen();
  }

  /** Hears the progress broadcast. Only progress is lost if it fails: the requests are plain HTTP. */
  #listen() {
    const socket = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws-progress`);
    socket.addEventListener("message", (event) => {
      try {
        const update = JSON.parse(String(event.data)) as {
          job_id?: string;
          progress?: number;
          message?: string;
        };
        if (update.job_id !== undefined && typeof update.progress === "number")
          this.#progress.get(update.job_id)?.(update.progress, update.message ?? "");
      } catch {
        // Not a progress update: nothing to report.
      }
    });
    socket.addEventListener("error", () => {});
    this.#socket = socket;
  }

  /** Resolves once the progress socket is open, or has failed: a job started before misses its first updates. */
  opened(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.CONNECTING) return Promise.resolve();
    return new Promise((resolve) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
    });
  }

  async collage(request: Record<string, unknown>, options: CollageOptions = {}): Promise<Uint8Array> {
    if (this.#gone !== undefined) throw this.#gone;
    await this.opened();
    const controller = new AbortController();
    this.#inFlight.add(controller);
    const jobId = typeof request.job_id === "string" ? request.job_id : undefined;
    if (jobId !== undefined && options.onProgress !== undefined)
      this.#progress.set(jobId, options.onProgress);
    const signal =
      options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    try {
      const response = await fetch(`${this.url}/make_collage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw new Error(await refusalOf(response));
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      this.#inFlight.delete(controller);
      if (jobId !== undefined) this.#progress.delete(jobId);
    }
  }

  async stop(): Promise<void> {
    this.#gone ??= new Error("The thumbnail service was stopped");
    this.#socket?.close();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin?.end();
    const killed = setTimeout(() => this.#child.kill(), 3000);
    await this.#exit;
    clearTimeout(killed);
  }
}

/** What a failed response says: the service's `{ error }` (500), its plain text (422), or its being busy (429). */
async function refusalOf(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") said = body.error;
  } catch {
    // Plain text, as it is.
  }
  if (response.status === 429)
    return `The thumbnail service is busy (429): ${said}. Lower this Profile's maxConcurrentTasks`;
  if (response.status < 500) return `The thumbnail service refused the request (${response.status}): ${said}`;
  return `The thumbnail service failed (${response.status}): ${said}`;
}
