// A stand-in for thumbs-collage, run with Node: says where it listens as the service does, and exits when its stdin
// closes. It answers 404 to every request (as a service older than 0.1.0 does to `/frames` and `/scenes`), unless the
// request's `fake` says otherwise:
// - `{ fake: "slow", ms }` answers `{}` after `ms` milliseconds, sending nothing before;
// - `{ fake: "drop" }` closes the connection without an answer;
// - `{ fake: "die" }` closes the connection, then exits with code 3.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    let fake: { fake?: string; ms?: number } = {};
    try {
      fake = JSON.parse(body) as typeof fake;
    } catch {
      // Not JSON: the default answer.
    }
    if (fake.fake === "slow") {
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end("{}");
      }, fake.ms ?? 0);
    } else if (fake.fake === "drop") {
      request.socket.destroy();
    } else if (fake.fake === "die") {
      request.socket.destroy();
      setTimeout(() => process.exit(3), 50);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
