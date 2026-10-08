// Local server: static UI plus the /api routes in handler.mjs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// A project-local .env (git-ignored) may hold OPENCOMPUTER_API_KEY for a
// different account than the global `opencomputer login`.
try {
  process.loadEnvFile(join(root, ".env"));
} catch {}
const { handleApi, agentInfo } = await import("./handler.mjs");

const PORT = Number(process.env.PORT ?? 8791);
const HOST = process.env.HOST ?? "127.0.0.1";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const PAGES = { "/": "index.html", "/app": "app.html" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleApi(req, res, url)) return;
  const file = PAGES[url.pathname] ?? url.pathname.slice(1);
  const content = file.includes("..") ? null : await readFile(join(root, "web/public", file)).catch(() => null);
  if (!content) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(content);
}).listen(PORT, HOST, () => {
  console.log(`PR Swipe on http://${HOST}:${PORT}  (agent ${agentInfo.agent}, project ${agentInfo.project ?? "none"}, live ${agentInfo.live})`);
});
