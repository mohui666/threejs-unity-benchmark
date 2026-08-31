import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const port = Number(process.argv[2] ?? 4328);
const routes = new Map([
  ["/", { path: resolve(root, "fixtures/web/index.html"), type: "text/html; charset=utf-8" }],
  ["/three.module.js", { path: resolve(root, "node_modules/three/build/three.module.js"), type: "text/javascript; charset=utf-8" }],
  ["/three.core.js", { path: resolve(root, "node_modules/three/build/three.core.js"), type: "text/javascript; charset=utf-8" }],
]);

const server = createServer(async (request, response) => {
  const route = routes.get(request.url ?? "/");
  if (request.url === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (!route) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": route.type, "cache-control": "no-store" });
  response.end(await readFile(route.path));
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`fixture-ready:${port}\n`));
process.on("SIGTERM", () => server.close());
