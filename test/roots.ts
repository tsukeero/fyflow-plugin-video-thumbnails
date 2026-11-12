// The Allowed roots the tests give each Task, as a Host gives them at `settings.roots`: the repository to read (its
// fixtures) and the system's temp folder, where every test makes its folders, to write.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AllowedRoot } from "fyflow-plugin-sdk";

export const ROOTS: readonly AllowedRoot[] = [
  { path: fileURLToPath(new URL("..", import.meta.url)), access: "read" },
  { path: tmpdir(), access: "write" },
];
