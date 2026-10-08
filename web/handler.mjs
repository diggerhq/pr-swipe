// PR Swipe API: proxies the OpenComputer management API for the swipe UI.
// The API key stays on the server; the browser only talks to /api routes.
// Shared by the local server (web/server.mjs) and the Vercel function (api/index.js).
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJsonFile = (path) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
};

const API = (process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev") + "/api/managed-agents";
const binding = readJsonFile(join(root, ".opencomputer/project.json")) ?? {};
// Locally, fall back to the CLI login. Hosted deployments must set the env var.
const API_KEY = process.env.OPENCOMPUTER_API_KEY ?? (process.env.VERCEL ? undefined : readJsonFile(join(homedir(), ".opencomputer/config.json"))?.apiKey);
const PROJECT = process.env.OPENCOMPUTER_PROJECT ?? binding.projectId;
const ENVIRONMENT = process.env.OPENCOMPUTER_ENVIRONMENT ?? "default";
const AGENT = `${process.env.PR_SWIPE_AGENT ?? binding.agentId ?? "pr-swipe"}@${ENVIRONMENT}`;
const PASSWORD = process.env.APP_PASSWORD ?? "";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const TEMPLATE_REPO = "https://github.com/diggerhq/pr-swipe";
export const TEMPLATE_DEPLOY_URL = `https://app.opencomputer.dev/new?repository-url=${encodeURIComponent(TEMPLATE_REPO)}`;

// Live mode can merge and close PRs, so a hosted deployment needs a password.
const live = Boolean(API_KEY && PROJECT) && !(process.env.VERCEL && !PASSWORD);
const liveReason = !API_KEY
  ? "No OpenComputer API key is configured on this deployment."
  : !PROJECT
    ? "No OpenComputer project is configured on this deployment."
    : !live
      ? "Set APP_PASSWORD to enable live mode on a hosted deployment."
      : null;

const token = PASSWORD ? createHash("sha256").update(`pr-swipe:${PASSWORD}`).digest("hex") : "";
function authed(req) {
  if (!PASSWORD) return true;
  const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith("prswipe="))?.slice(8) ?? "";
  return cookie.length === token.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
}


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
  if (req.body !== undefined && typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
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


const open = [
  ["GET", /^\/api\/config$/, async (req) => ({
    live,
    reason: liveReason,
    needsLogin: live && Boolean(PASSWORD),
    authed: authed(req),
    templateRepo: TEMPLATE_REPO,
    deployUrl: TEMPLATE_DEPLOY_URL,
  })],
  ["POST", /^\/api\/login$/, async (req, url, m, res) => {
    const { password } = await readJson(req);
    const given = createHash("sha256").update(`pr-swipe:${String(password ?? "")}`).digest("hex");
    if (!PASSWORD || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) throw Object.assign(new Error("Wrong password"), { status: 401 });
    res.setHeader("set-cookie", `prswipe=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.VERCEL ? "; Secure" : ""}`);
    return { ok: true };
  }],
];

// Returns true when the request was an /api route.
export async function handleApi(req, res, url) {
  if (!url.pathname.startsWith("/api/")) return false;
  try {
    for (const [method, pattern, handler] of open) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) return send(res, 200, await handler(req, url, m, res)), true;
    }
    if (!live) return send(res, 503, { error: liveReason, code: "not_configured" }), true;
    if (!authed(req)) return send(res, 401, { error: "Log in first", code: "login_required" }), true;
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) return send(res, 200, await handler(req, url, m)), true;
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(req.method, url.pathname, err.message);
    send(res, err.status && err.status < 600 ? err.status : 500, { error: err.message, code: err.code });
  }
  return true;
}

export const agentInfo = { project: PROJECT, agent: AGENT, live };
