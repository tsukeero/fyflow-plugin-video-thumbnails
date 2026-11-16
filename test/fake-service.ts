// A stand-in for thumbs-collage, run with Node: says where it listens as the service does, answers 404 to every
// request (as a service older than 0.1.0 does to `/frames` and `/scenes`), and exits when its stdin closes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const server = createServer((_request, response) => {
  response.statusCode = 404;
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
