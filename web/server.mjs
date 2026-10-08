// PR Swipe web app: serves the swipe UI and proxies the OpenComputer
// management API. The API key stays on this server; the browser only talks
// to the /api routes below.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// A project-local .env (git-ignored) may hold OPENCOMPUTER_API_KEY for a
// different account than the global `opencomputer login`.
try {
  process.loadEnvFile(join(root, ".env"));
} catch {}
const PORT = Number(process.env.PORT ?? 8791);
const HOST = process.env.HOST ?? "127.0.0.1";
const API = (process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev") + "/api/managed-agents";

const binding = JSON.parse(await readFile(join(root, ".opencomputer/project.json"), "utf8"));
const API_KEY =
  process.env.OPENCOMPUTER_API_KEY ??
  JSON.parse(await readFile(join(homedir(), ".opencomputer/config.json"), "utf8")).apiKey;
const PROJECT = process.env.OPENCOMPUTER_PROJECT ?? binding.projectId;
const ENVIRONMENT = process.env.OPENCOMPUTER_ENVIRONMENT ?? "default";
const AGENT = `${binding.agentId}@${ENVIRONMENT}`;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function oc(path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { "x-api-key": API_KEY, "user-agent": "pr-swipe/0.1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { code: "bad_response", message: text.slice(0, 300) } };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? data?.error ?? `OpenComputer ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

// One session per job; the agent's report tool fills session.result.
async function startJob({ kind, repo, pr, payload, text, key, extraLabels }) {
  const labels = { app: "pr-swipe", kind, repo, ...extraLabels };
  if (pr) labels.pr = String(pr);
  const created = await oc("/sessions", {
    method: "POST",
    idempotencyKey: key,
    body: { agentId: AGENT, labels, externalReference: `${kind}:${repo}${pr ? `#${pr}` : ""}` },
  });
  const id = created.session.id;
  await oc(`/sessions/${id}/turns`, {
    method: "POST",
    idempotencyKey: `${key}/start`,
    body: { input: text, payload },
  });
  return id;
}

function summarizeEvent(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "tool.started": {
      if (d.tool === "shell") {
        const cmd = String(d.input?.command ?? "").split("\n")[0].slice(0, 160);
        return { seq: e.seq, kind: "cmd", text: cmd };
      }
      if (d.tool === "report") return { seq: e.seq, kind: "step", text: "Reporting back" };
      return { seq: e.seq, kind: "step", text: d.title ?? d.tool };
    }
    case "tool.failed":
      return { seq: e.seq, kind: "warn", text: String(d.message ?? "tool failed").slice(0, 200) };
    case "turn.started":
      return { seq: e.seq, kind: "step", text: "Agent started" };
    case "runtime.connected":
      return { seq: e.seq, kind: "step", text: "Sandbox attached" };
    case "turn.failed":
      return { seq: e.seq, kind: "error", text: `${d.code ?? "failed"}: ${d.message ?? ""}`.slice(0, 300) };
    case "turn.completed":
      return { seq: e.seq, kind: "done", text: "Done" };
    default:
      return null;
  }
}

async function jobState(id, after) {
  const { session: s } = await oc(`/sessions/${id}`).then((r) => (r.session ? r : { session: r }));
  const last = s.turns?.[s.turns.length - 1];
  const fresh = s.result && last && s.result.turnId === last.id;
  const events = [];
  let cursor = after;
  for (let page = 0; page < 6; page++) {
    const { events: batch } = await oc(`/sessions/${id}/events?after=${cursor}`);
    for (const e of batch) {
      const sum = summarizeEvent(e);
      if (sum) events.push(sum);
      cursor = e.seq;
    }
    if (batch.length < 500) break;
  }
  return {
    id,
    status: s.status,
    turnStatus: last?.status ?? "queued",
    result: fresh ? s.result.data : null,
    cursor,
    events,
  };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.length > 64_000) throw Object.assign(new Error("Body too large"), { status: 413 });
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const routes = [
  ["GET", /^\/api\/config$/, async () => ({ project: PROJECT, agent: AGENT, environment: ENVIRONMENT })],

  ["GET", /^\/api\/github\/status$/, async () => {
    const status = await oc(`/projects/${PROJECT}/github`);
    const env = status.environments.find((e) => e.environment === ENVIRONMENT);
    return { state: env?.state ?? "not_connected", installation: env?.installation ?? null, connections: status.connections };
  }],

  ["POST", /^\/api\/github\/connect$/, async () => {
    const status = await oc(`/projects/${PROJECT}/github`);
    const active = status.connections.filter((c) => c.state === "active");
    // Reuse an existing installation, as `opencomputer github connect` does.
    if (active.length === 1) {
      await oc(`/projects/${PROJECT}/github/attach`, {
        method: "POST",
        body: { environment: ENVIRONMENT, connectionId: active[0].id },
      });
      return { attached: true };
    }
    const r = await oc(`/projects/${PROJECT}/github/connect`, {
      method: "POST",
      body: { environments: [ENVIRONMENT] },
    });
    return { installUrl: r.installUrl };
  }],

  ["GET", /^\/api\/repos$/, async () => {
    const repos = [];
    let cursor = "";
    for (let i = 0; i < 10; i++) {
      const r = await oc(`/projects/${PROJECT}/github/repositories?environment=${ENVIRONMENT}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      repos.push(...r.repositories.filter((x) => !x.archived));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return { repos };
  }],

  // Start listing a repo's open PRs.
  ["POST", /^\/api\/prs$/, async (req) => {
    const { repo } = await readJson(req);
    if (!REPO.test(repo ?? "")) throw Object.assign(new Error("Invalid repo"), { status: 400 });
    const id = await startJob({
      kind: "list",
      repo,
      payload: { mode: "list", repo },
      text: `List open pull requests in ${repo}`,
      key: `pr-swipe:list:${repo}:${Math.floor(Date.now() / 60_000)}`,
    });
    return { jobId: id };
  }],

  // The newest usable review per PR, so the deck opens on reviews the
  // background sweep (or an earlier visit) already finished.
  ["GET", /^\/api\/reviews$/, async (req, url) => {
    const repo = url.searchParams.get("repo") ?? "";
    if (!REPO.test(repo)) throw Object.assign(new Error("Invalid repo"), { status: 400 });
    const byPr = {};
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ project: PROJECT, "label.kind": "review", "label.repo": repo, limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const { sessions, nextCursor } = await oc(`/sessions?${q}`);
      for (const s of sessions) {
        const pr = s.labels?.pr;
        if (!pr || byPr[pr]?.state === "done") continue;
        const settled = s.activity?.lastSettledTurn;
        const review = s.result?.data?.kind === "review" ? s.result.data : null;
        const busy = Boolean(s.activity?.activeTurnId) || (s.activity?.queued ?? 0) > 0;
        if (!review && !busy && settled) continue; // failed or finished without a review
        const state = review && !busy ? "done" : "running";
        // Prefer the newest finished review; the client re-reviews when its commit is stale.
        if (byPr[pr] && state === "running") continue;
        byPr[pr] = { jobId: s.id, sha: s.labels.sha ?? null, state, result: review, createdAt: s.createdAt };
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return { reviews: byPr };
  }],

  // Keyed by head commit like the sweep's queue_reviews, so a commit is
  // reviewed once whoever asks first. `force` starts a fresh review.
  ["POST", /^\/api\/reviews$/, async (req) => {
    const { repo, pr, sha, force } = await readJson(req);
    if (!REPO.test(repo ?? "") || !Number.isInteger(pr)) throw Object.assign(new Error("Invalid repo or pr"), { status: 400 });
    const hasSha = typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha);
    const key = `pr-swipe:review:${repo}#${pr}@${hasSha ? sha : "unknown"}${force || !hasSha ? `:${Date.now()}` : ""}`;
    const id = await startJob({
      kind: "review",
      repo,
      pr,
      payload: { mode: "review", repo, pr },
      text: `Review ${repo}#${pr}`,
      key,
      extraLabels: hasSha ? { sha } : {},
    });
    return { jobId: id };
  }],

  ["POST", /^\/api\/actions$/, async (req) => {
    const { repo, pr, action, method, body, clientId } = await readJson(req);
    if (!REPO.test(repo ?? "") || !Number.isInteger(pr)) throw Object.assign(new Error("Invalid repo or pr"), { status: 400 });
    if (!["merge", "close", "comment"].includes(action)) throw Object.assign(new Error("Invalid action"), { status: 400 });
    if (action === "comment" && !String(body ?? "").trim()) throw Object.assign(new Error("Empty comment"), { status: 400 });
    const id = await startJob({
      kind: "action",
      repo,
      pr,
      payload: { mode: "act", repo, pr, action, method: method ?? "squash", body: String(body ?? "").slice(0, 8000) },
      text: `${action} ${repo}#${pr}`,
      key: `pr-swipe:act:${repo}#${pr}:${action}:${clientId ?? Date.now()}`,
    });
    return { jobId: id };
  }],

  ["GET", /^\/api\/jobs\/([A-Za-z0-9_-]+)$/, async (req, url, m) =>
    jobState(m[1], Number(url.searchParams.get("after") ?? 0))],
];

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) return send(res, 200, await handler(req, url, m));
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return send(res, 400, { error: "Bad path" });
    const content = await readFile(join(root, "web/public", file)).catch(() => null);
    if (!content) return send(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch (err) {
    console.error(req.method, url.pathname, err.message);
    send(res, err.status && err.status < 600 ? err.status : 500, { error: err.message, code: err.code });
  }
}).listen(PORT, HOST, () => {
  console.log(`PR Swipe on http://${HOST}:${PORT}  (agent ${AGENT}, project ${PROJECT})`);
});
