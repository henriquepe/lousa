"use strict";

/* Local entrypoint: Node process with http.createServer, disk storage. */

const http = require("http");
const { handleRequest } = require("./core");

const PORT = Number(process.env.PORT) || 4666;
const HOST = process.env.HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await handleRequest({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (error) {
      console.error(`[error] ${error.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error." }));
    }
  });
});

server.listen(PORT, HOST, () => console.log(`Lousa: http://${HOST}:${PORT}`));
