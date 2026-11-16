// The Plugin's status, as the Host shows it on the Plugin's card and gives Agents: whether the thumbs-collage service
// is downloading, starting or running, and with how many jobs, or why it last failed. So a Task that seems to hang at
// its start can be explained without opening it. It reads only what this module shares with the inline Workers, and
// the data directory, and never starts or downloads anything.
import { existsSync } from "node:fs";
import type { PluginStatus, PluginStatusContext } from "fyflow-plugin-sdk";
import { bytesOf, currentDownload, lastFailure } from "./activity.ts";
import { serviceDir } from "./data.ts";
import { installedExecutable, platformFolder, SERVICE_VERSION } from "./release.ts";
import { type ServiceSnapshot, serviceSnapshots } from "./service.ts";

type Detail = { label: string; value: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first line of `message`, kept short: the details show one line each. */
const firstLine = (message: string) => {
  const line = message.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** The details of one service; `prefix` tells several apart. */
const detailsOf = (service: ServiceSnapshot, prefix = ""): Detail[] => [
  { label: `${prefix}State`, value: service.state === "running" ? "Running" : "Starting" },
  ...(service.pid === undefined ? [] : [{ label: `${prefix}Process`, value: String(service.pid) }]),
  ...(service.url === undefined ? [] : [{ label: `${prefix}Address`, value: service.url }]),
  { label: `${prefix}Jobs in flight`, value: String(service.jobs) },
  { label: `${prefix}Executable`, value: service.executable },
];

export function status({ dataDir }: PluginStatusContext): PluginStatus {
  const download = currentDownload();
  const failure = lastFailure();
  const services = serviceSnapshots();
  const running = services.filter((s) => s.state === "running");
  const jobs = services.reduce((sum, s) => sum + s.jobs, 0);
  const installed = dataDir === undefined ? undefined : installedExecutable(serviceDir(dataDir));

  const details: Detail[] =
    services.length === 1
      ? detailsOf(services[0] as ServiceSnapshot)
      : services.flatMap((s, i) => detailsOf(s, `Service ${i + 1}: `));
  if (download !== undefined) details.push({ label: "Downloaded", value: bytesOf(download) });
  if (failure !== undefined)
    details.push(
      { label: "Last failure", value: firstLine(failure.message) },
      { label: "Failed at", value: failure.at.toISOString() },
    );
  if (services.length === 0 && installed !== undefined)
    details.push({ label: "Downloaded to", value: installed });

  if (download !== undefined)
    return {
      level: "info",
      summary: `Downloading thumbs-collage ${download.version} (${bytesOf(download)}): Tasks start once it is ready`,
      details,
    };
  if (running.length > 0)
    return {
      level: "ok",
      summary: `${running.length === 1 ? "thumbs-collage running" : `${running.length} thumbs-collage services running`} · ${plural(jobs, "job")} in flight`,
      details,
    };
  if (services.length > 0)
    return { level: "info", summary: "Starting thumbs-collage: Tasks start once it is ready", details };
  if (failure !== undefined)
    return {
      level: "warning",
      summary: `thumbs-collage failed: ${firstLine(failure.message)}`,
      details,
    };
  // A Profile's `executablePath` is not known here, so this is only `info`: such a Profile needs no release.
  if (platformFolder() === undefined)
    return {
      level: "info",
      summary: `thumbs-collage ${SERVICE_VERSION} has no release for ${process.platform}-${process.arch}: a Profile needs \`executablePath\` set`,
      details,
    };
  return {
    level: "ok",
    summary:
      installed === undefined
        ? "thumbs-collage not running: the next Task starts it"
        : existsSync(installed)
          ? `thumbs-collage ${SERVICE_VERSION} not running: the next Task starts it`
          : `thumbs-collage ${SERVICE_VERSION} not downloaded yet: the first Task downloads it`,
    details,
  };
}
