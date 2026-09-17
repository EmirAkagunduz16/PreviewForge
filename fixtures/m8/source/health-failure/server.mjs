import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"status":"unhealthy"}\n');
    return;
  }

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("PreviewForge M8 health-failure fixture\n");
});

server.listen(8080, "0.0.0.0");
