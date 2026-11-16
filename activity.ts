// What the service is doing beyond any one Task: a download in progress, and the last time it failed to download,
// start or keep running. The Plugin's status reads it (./status.ts), and so do Tasks waiting for the service to be
// ready (./service-worker.ts). The pools are inline, so the Workers and the Plugin's entry share this module.

export interface Download {
  version: string;
  /** Bytes received so far, and the archive's size when the server says it. */
  received: number;
  total: number | undefined;
}

export interface Failure {
  message: string;
  at: Date;
}

let download: Download | undefined;
let failure: Failure | undefined;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of [...listeners]) listener();
};

/** The download in progress, if one is. */
export const currentDownload = (): Download | undefined => download;

/** Sets the download in progress, or clears it once it ends. */
export function setDownload(value: Download | undefined): void {
  download = value;
  notify();
}

/** The last failure to download, start or keep the service running; cleared once one starts. */
export const lastFailure = (): Failure | undefined => failure;

export function setFailure(error: Error | undefined): void {
  failure = error === undefined ? undefined : { message: error.message, at: new Date() };
}

/** Calls `listener` whenever the download moves on or ends; returns the call to stop. */
export function onActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "12.3 of 40.1 MB", or "12.3 MB" when the size is not known. */
export function bytesOf({ received, total }: Download): string {
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  return total === undefined ? `${mb(received)} MB` : `${mb(received)} of ${mb(total)} MB`;
}
