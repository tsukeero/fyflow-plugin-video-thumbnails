// The thumbs-collage service, run as a child process: started on a free port of 127.0.0.1, sent one request per job
// (`POST /make_collage`, `/frames` or `/scenes`), and heard on its `/ws-progress` WebSocket, which broadcasts every
// job's progress by job id. It is started with `--exit-on-stdin-close` and its stdin kept open, so it dies with us
// however we end. The Workers share one process for each executable and font (`acquireService`), whichever Node Type
// and Profile they serve.
import { type ChildProcess, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { setFailure } from "./activity.ts";

/** The service's executable's file name on this platform. */
export const EXECUTABLE = process.platform === "win32" ? "thumbs-collage.exe" : "thumbs-collage";

export interface StartOptions {
  executable: string;
  /** Arguments given before the service's own: tests run a fake service as a script for Node. */
  args?: readonly string[] | undefined;
  /** A TTF font for timestamp overlays; without one the service draws none. */
  fontFile?: string | undefined;
  /** How long the service may take to say where it listens (10 s unless set). */
  startTimeoutMs?: number | undefined;
  /** Called once if the service exits without being stopped, with the exit and its last lines of output. */
  onExit?: (error: Error) => void;
}

export interface JobOptions {
  signal?: AbortSignal | undefined;
  /** The job's progress as the service reports it: a fraction from 0 to 1, and what it is doing. */
  onProgress?: (progress: number, message: string) => void;
}

export interface Service {
  readonly url: string;
  readonly pid: number;
  /** How many requests are in flight. */
  readonly jobs: number;
  /** Makes one collage, the request in the service's own terms; resolves with the JPEG. */
  collage(request: Record<string, unknown>, options?: JobOptions): Promise<Uint8Array>;
  /** Extracts frames (`POST /frames`, service 0.1.0); resolves with the service's JSON reply. */
  frames(request: Record<string, unknown>, options?: JobOptions): Promise<unknown>;
  /** Detects scenes, and picks frames from them if asked (`POST /scenes`, service 0.1.0); resolves with its reply. */
  scenes(request: Record<string, unknown>, options?: JobOptions): Promise<unknown>;
  /** Stops the service: closes its stdin, and kills it if it has not exited a few seconds later. */
  stop(): Promise<void>;
}

/** How many of the service's last lines of output an error carries. */
const TAIL_LINES = 50;
/**
 * No limit on concurrent jobs worth having in the service: the Node Types' pools and the Host's Resource Groups are
 * what limit them, so a Task is never refused (429) for another Node Type's or Profile's jobs on the same service.
 */
const MAX_JOBS = 64;

export async function startService(options: StartOptions): Promise<Service> {
  const args = [
    ...(options.args ?? []),
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

  get jobs(): number {
    return this.#inFlight.size;
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

  async collage(request: Record<string, unknown>, options: JobOptions = {}): Promise<Uint8Array> {
    return this.#job("/make_collage", request, options, (body) => new Uint8Array(body));
  }

  frames(request: Record<string, unknown>, options: JobOptions = {}): Promise<unknown> {
    return this.#job("/frames", request, options, jsonOf);
  }

  scenes(request: Record<string, unknown>, options: JobOptions = {}): Promise<unknown> {
    return this.#job("/scenes", request, options, jsonOf);
  }

  /** Posts one job, reporting its progress, and reads its reply; aborted with the reason if the service dies. */
  async #job<T>(
    path: string,
    request: Record<string, unknown>,
    options: JobOptions,
    read: (body: Buffer) => T,
  ): Promise<T> {
    if (this.#gone !== undefined) throw this.#gone;
    const controller = new AbortController();
    this.#inFlight.add(controller);
    const jobId = typeof request.job_id === "string" ? request.job_id : undefined;
    if (jobId !== undefined && options.onProgress !== undefined)
      this.#progress.set(jobId, options.onProgress);
    const signal =
      options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    try {
      await this.opened();
      let reply: Reply;
      try {
        reply = await post(`${this.url}${path}`, JSON.stringify(request), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        // The connection breaks before the process is seen to exit when the service dies: give it a moment to.
        await Promise.race([this.#exit, new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
        if (this.#gone !== undefined) throw this.#gone;
        throw new Error(`The thumbnail service's connection failed: ${causeOf(error)}`, { cause: error });
      }
      if (reply.status === 404 && path !== "/make_collage")
        throw new Error(
          `This thumbs-collage has no ${path}: it is older than 0.1.0. Update it, or clear \`executablePath\` in the fyflow-ext.video-thumbnail section of this Node's Profile`,
        );
      if (reply.status < 200 || reply.status >= 300) throw new Error(refusalOf(reply));
      return read(reply.body);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (options.signal?.aborted) throw options.signal.reason;
      throw error;
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

interface Reply {
  status: number;
  body: Buffer;
}

/**
 * Posts `body` as JSON to `url` and reads the whole reply. With `node:http` rather than `fetch`, whose reply must start
 * within 5 minutes: the service answers a job only once it is done, and detecting the scenes of a long video can take
 * longer. Waiting has no limit; the job's signal ends it. Each job has its own connection, so none is reused just as
 * the service closes it for being idle.
 */
function post(url: string, body: string, signal: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        agent: false,
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("the reply was cut off")));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

/** What broke a connection: the error's own message, its code, and what caused it, if anything did. */
function causeOf(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error && parts.length < 4; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    parts.push(typeof code === "string" && !e.message.includes(code) ? `${e.message} (${code})` : e.message);
  }
  return parts.length > 0 ? parts.join(": ") : String(error);
}

const jsonOf = (body: Buffer): unknown => JSON.parse(body.toString("utf8"));

/** What a failed reply says: the service's `{ error }` (500), its plain text (422), or its being busy (429). */
function refusalOf(response: Reply): string {
  const text = response.body.toString("utf8").trim();
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

/** What a service is started with, and so what one is shared by. */
export interface ServiceKey {
  executable: string;
  args?: readonly string[] | undefined;
  fontFile?: string | undefined;
}

/** A share of a running service: its holder calls `release()` once, when done with it. */
export interface Lease extends Omit<Service, "stop"> {
  /** Lets go of the service; the last holder to let go stops it. */
  release(): Promise<void>;
}

interface Shared {
  key: ServiceKey;
  started: Promise<Service>;
  /** The service, once it has started. */
  service?: Service;
  /** Each holder's `onExit`, one entry per lease. */
  holders: Set<{ onExit: (error: Error) => void }>;
}

/** The services running in this module, by `keyOf`: one each, however many Workers use it. */
const shared = new Map<string, Shared>();

const keyOf = ({ executable, args, fontFile }: ServiceKey) =>
  JSON.stringify([executable, args ?? [], fontFile ?? null]);

/**
 * A lease on the service started with `key`, started now unless it is running, or starting, already. `onExit` is
 * called if the process dies under the lease (each holder's, then the next acquire starts a new one); it is never
 * called after `release()`.
 */
export async function acquireService(
  key: ServiceKey & Pick<StartOptions, "startTimeoutMs">,
  onExit: (error: Error) => void = () => {},
): Promise<Lease> {
  const id = keyOf(key);
  let entry = shared.get(id);
  if (entry === undefined) {
    const holders: Shared["holders"] = new Set();
    const started = startService({
      executable: key.executable,
      args: key.args,
      fontFile: key.fontFile,
      startTimeoutMs: key.startTimeoutMs,
      onExit: (error) => {
        if (shared.get(id) === created) shared.delete(id);
        setFailure(error);
        for (const holder of [...holders]) holder.onExit(error);
      },
    });
    const created: Shared = { key, started, holders };
    entry = created;
    shared.set(id, created);
    started.then(
      (service) => {
        created.service = service;
        setFailure(undefined);
      },
      (error: Error) => {
        if (shared.get(id) === created) shared.delete(id);
        setFailure(error);
      },
    );
  }
  const { holders, started } = entry;
  const holder = { onExit };
  holders.add(holder);
  let service: Service;
  try {
    service = await started;
  } catch (error) {
    holders.delete(holder);
    throw error;
  }
  const owner = entry;
  let released = false;
  return {
    url: service.url,
    pid: service.pid,
    get jobs() {
      return service.jobs;
    },
    collage: (request, options) => service.collage(request, options),
    frames: (request, options) => service.frames(request, options),
    scenes: (request, options) => service.scenes(request, options),
    async release() {
      if (released) return;
      released = true;
      holders.delete(holder);
      if (holders.size > 0) return;
      if (shared.get(id) === owner) shared.delete(id);
      await service.stop();
    },
  };
}

/** A service of this module's, as the Plugin's status shows it. */
export interface ServiceSnapshot {
  executable: string;
  fontFile: string | undefined;
  /** `starting` until it says where it listens. */
  state: "starting" | "running";
  pid?: number;
  url?: string;
  /** How many Worker instances hold it, and how many requests are in flight. */
  holders: number;
  jobs: number;
}

/** The services started in this module and not yet stopped or dead. */
export function serviceSnapshots(): ServiceSnapshot[] {
  return [...shared.values()].map(({ key, service, holders }) => ({
    executable: key.executable,
    fontFile: key.fontFile,
    state: service === undefined ? "starting" : "running",
    ...(service === undefined ? {} : { pid: service.pid, url: service.url }),
    holders: holders.size,
    jobs: service?.jobs ?? 0,
  }));
}
