import { demoApi } from "./demo.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const EMBED = params.has("embed");
const DEPLOY_URL = "https://app.opencomputer.dev/new?repository-url=" + encodeURIComponent("https://github.com/diggerhq/pr-swipe");
const UNDO_MS = 5000;
const MAX_PARALLEL_REVIEWS = 3;

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- API ----------
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
const liveApi = {
  githubStatus: () => call("GET", "/api/github/status"),
  githubConnect: () => call("POST", "/api/github/connect"),
  repos: () => call("GET", "/api/repos"),
  listPrs: (repo) => call("POST", "/api/prs", { repo }),
  reviews: (repo) => call("GET", `/api/reviews?repo=${encodeURIComponent(repo)}`),
  startReview: (repo, pr, sha, force) => call("POST", "/api/reviews", { repo, pr, sha, force }),
  act: (body) => call("POST", "/api/actions", body),
  job: (id, after) => call("GET", `/api/jobs/${id}?after=${after}`),
};
const api = DEMO ? demoApi : liveApi;

// ---------- State ----------
const state = {
  repo: null,
  queue: [], // PR objects still to decide on, front = top card
  reviews: {}, // pr number -> { jobId, cursor, status: running|done|failed, result, log[] }
  pending: null, // swipe waiting out its undo window
  decided: new Set(), // PRs merged or closed this visit
  listing: false,
};

// ---------- Screens ----------
function show(name) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== `screen-${name}`;
  $("#repo-button").hidden = name !== "deck";
}

// ---------- GitHub connection ----------
let installation = null;
async function boot() {
  if (DEMO) $("#demo-banner").hidden = false;
  if (EMBED) document.body.classList.add("embed");
  for (const a of [$("#setup-deploy"), $("#foot-deploy")]) a.href = DEPLOY_URL;
  if (EMBED && DEMO) return openRepo("acme/payments-api");

  if (!DEMO) {
    let cfg;
    try {
      cfg = await call("GET", "/api/config");
    } catch (err) {
      cfg = { live: false, reason: err.message };
    }
    if (!cfg.live) {
      setPill("Demo deployment", "");
      $("#setup-reason").textContent = cfg.reason ?? "";
      return show("setup");
    }
    if (cfg.needsLogin && !cfg.authed) {
      setPill("Locked", "bad");
      return show("login");
    }
  }
  const method = $("#merge-method");
  method.value = store.get("pr-swipe:method", "squash");
  method.onchange = () => store.set("pr-swipe:method", method.value);

  let status;
  try {
    status = await api.githubStatus();
  } catch (err) {
    setPill("Server error", "bad");
    show("connect");
    $("#connect-status").textContent = err.message;
    return;
  }
  if (status.state !== "active") {
    setPill("GitHub not connected", "bad");
    show("connect");
    return;
  }
  installation = status.installation;
  setPill(`@${installation?.accountLogin ?? "github"}`, "ok");
  const last = store.get(`pr-swipe:repo${DEMO ? ":demo" : ""}`, "");
  if (last && new URLSearchParams(location.search).get("repo") !== "") return openRepo(last);
  return showRepos();
}

function setPill(text, cls) {
  const pill = $("#gh-pill");
  pill.textContent = text;
  pill.className = `pill ${cls ?? ""}`;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-status").textContent = "";
  try {
    await call("POST", "/api/login", { password: $("#login-password").value });
    boot();
  } catch (err) {
    $("#login-status").textContent = err.message;
  }
});

$("#connect-button").onclick = async () => {
  const btn = $("#connect-button");
  btn.disabled = true;
  $("#connect-status").textContent = "Starting the GitHub flow…";
  try {
    const r = await api.githubConnect();
    if (r.installUrl) {
      window.open(r.installUrl, "_blank", "noopener");
      $("#connect-status").textContent = "Finish installing the OpenComputer app on GitHub, choose the repos to review, then come back. Waiting…";
    }
    for (let i = 0; i < 200; i++) {
      const s = await api.githubStatus();
      if (s.state === "active") return boot();
      await sleep(3000);
    }
    $("#connect-status").textContent = "Still not connected. Reload after finishing on GitHub.";
  } catch (err) {
    $("#connect-status").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ---------- Repo picker ----------
let allRepos = [];
async function showRepos() {
  show("repos");
  const manage = $("#manage-repos");
  if (installation?.githubInstallationId) {
    manage.href = installation.accountType === "Organization"
      ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.githubInstallationId}`
      : `https://github.com/settings/installations/${installation.githubInstallationId}`;
  } else manage.hidden = true;
  $("#repos-status").textContent = "Loading repositories…";
  try {
    allRepos = (await api.repos()).repos;
    $("#repos-status").textContent = allRepos.length ? "" : "The installation can't see any repositories yet. Add some on GitHub.";
    renderRepos();
  } catch (err) {
    $("#repos-status").textContent = err.message;
  }
}
function renderRepos() {
  const q = $("#repo-filter").value.trim().toLowerCase();
  $("#repo-list").innerHTML = allRepos
    .filter((r) => r.fullName.toLowerCase().includes(q))
    .map((r) => {
      const owner = r.fullName.split("/")[0];
      return `<li><button data-repo="${esc(r.fullName)}">
        <img src="https://github.com/${esc(owner)}.png?size=72" alt="" loading="lazy">
        <span><span class="repo-name">${esc(r.fullName)}</span><br>
        <span class="repo-meta">${r.private ? "🔒 private" : "public"} · ${esc(r.defaultBranch)}</span></span>
        <span class="go">→</span></button></li>`;
    })
    .join("");
}
$("#repo-filter").oninput = renderRepos;
$("#repo-list").onclick = (e) => {
  const b = e.target.closest("button[data-repo]");
  if (b) openRepo(b.dataset.repo);
};
$("#repo-button").onclick = () => showRepos();

// ---------- Deck ----------
async function openRepo(repo) {
  state.repo = repo;
  state.queue = [];
  state.reviews = {};
  state.decided = new Set();
  store.set(`pr-swipe:repo${DEMO ? ":demo" : ""}`, repo);
  $("#repo-button").textContent = `${repo} ▾`;
  show("deck");
  renderDeck({ loading: "Loading reviews…", log: [] });

  // 1. Reviews the background sweep already finished: show them right away.
  let listJob;
  const listing = api.listPrs(repo); // starts now; awaited after the cached deck is up
  listing.catch(() => {});
  try {
    const existing = await api.reviews(repo);
    if (state.repo !== repo) return;
    const cached = [];
    for (const [pr, r] of Object.entries(existing.reviews)) {
      state.reviews[pr] = { jobId: r.jobId, cursor: 0, status: r.state === "done" ? "done" : "running", result: r.result, sha: r.sha, log: [] };
      const review = r.result?.review;
      if (review?.meta) cached.push({ number: Number(pr), ...review.meta, headSha: review.headSha });
    }
    if (cached.length) {
      state.queue = cached.sort((a, b) => b.number - a.number);
      setListing(true);
      renderDeck();
    }
    listJob = (await listing).jobId;
  } catch (err) {
    return renderDeck({ error: err.message });
  }

  // 2. The live list: drop merged/closed PRs, add new ones, re-review new commits.
  const log = [];
  let cursor = 0;
  for (;;) {
    let job;
    try {
      job = await api.job(listJob, cursor);
    } catch (err) {
      if (!state.queue.length) return renderDeck({ error: err.message });
      return setListing(false);
    }
    if (state.repo !== repo) return;
    cursor = job.cursor;
    log.push(...job.events);
    if (job.result?.kind === "prs") {
      reconcile(job.result.prs);
      break;
    }
    if (job.turnStatus === "failed" || job.turnStatus === "cancelled" || (job.turnStatus === "completed" && !job.result)) {
      const last = log.filter((l) => l.kind === "error").pop();
      if (!state.queue.length) return renderDeck({ error: `Couldn't list pull requests. ${last?.text ?? ""}` });
      break;
    }
    if (!state.queue.length) renderDeck({ loading: "Finding open pull requests…", log });
    await sleep(1500);
  }
  setListing(false);
  renderDeck();
  pump();
}

function reconcile(prs) {
  const open = prs.filter((pr) => !state.decided.has(pr.number));
  // Keep the card the person is looking at on top if it is still open.
  const top = state.queue[0];
  const ordered = top && open.some((p) => p.number === top.number)
    ? [open.find((p) => p.number === top.number), ...open.filter((p) => p.number !== top.number)]
    : open;
  state.queue = ordered;
  for (const pr of open) {
    const rv = state.reviews[pr.number];
    if (!rv || !pr.headSha) continue;
    const reviewedSha = rv.result?.review?.headSha ?? rv.sha;
    if (reviewedSha && !pr.headSha.startsWith(reviewedSha) && !reviewedSha.startsWith(pr.headSha)) {
      delete state.reviews[pr.number]; // new commits since that review
    }
  }
}

function setListing(on) {
  state.listing = on;
  $("#deck-status").textContent = on ? "Checking GitHub for new pull requests and commits…" : "";
}

function renderDeck(status) {
  const deck = $("#deck");
  const controls = document.querySelectorAll(".ctl");
  if (status) {
    for (const c of controls) c.disabled = true;
    deck.innerHTML = status.error
      ? `<div class="empty"><div><div class="big">💔</div><h3>Something went wrong</h3><p class="muted">${esc(status.error)}</p><button class="primary" id="retry-list">Try again</button></div></div>`
      : `<div class="empty"><div class="reviewing"><div class="radar"></div><h4>${esc(status.loading)}</h4>${logHtml(status.log)}</div></div>`;
    $("#retry-list")?.addEventListener("click", () => openRepo(state.repo));
    return;
  }
  const visible = state.queue.slice(0, 3);
  for (const c of controls) c.disabled = visible.length === 0;
  if (!visible.length) {
    if (state.listing) return renderDeck({ loading: "Finding open pull requests…", log: [] });
    deck.innerHTML = `<div class="empty"><div><div class="big">🌅</div><h3>You've seen every open PR</h3>
      <p class="muted">No more pull requests in ${esc(state.repo)}. Check back later, or pick another repo.</p>
      <button class="primary" id="pick-another">Pick another repo</button></div></div>`;
    $("#pick-another").onclick = showRepos;
    return;
  }
  // Keep existing card nodes so drag state and scroll position survive re-renders.
  const keep = new Map([...deck.querySelectorAll(".card")].map((el) => [Number(el.dataset.pr), el]));
  deck.querySelector(".empty")?.remove();
  visible.forEach((pr, i) => {
    let el = keep.get(pr.number);
    keep.delete(pr.number);
    const html = cardInner(pr);
    if (!el) {
      el = document.createElement("article");
      el.className = "card";
      el.dataset.pr = pr.number;
      el.innerHTML = html;
      el._html = html;
      attachDrag(el);
    } else if (el._html !== html) {
      // While reviewing, patch only the log so the radar animation keeps running.
      const rv = state.reviews[pr.number];
      const reviewing = rv && rv.status === "running";
      const oldLog = el.querySelector(".reviewing .log");
      if (reviewing && el._reviewing && oldLog) {
        oldLog.outerHTML = logHtml(rv.log) || "<ul class=\"log\"></ul>";
        el._html = html;
        el._reviewing = true;
        return place(el, i);
      }
      const scroll = el.querySelector(".body")?.scrollTop ?? 0;
      el.innerHTML = html;
      el._html = html;
      const body = el.querySelector(".body");
      if (body) body.scrollTop = scroll;
    }
    el._reviewing = state.reviews[pr.number]?.status === "running";
    place(el, i);
  });
  function place(el, i) {
    el.classList.toggle("behind-1", i === 1);
    el.classList.toggle("behind-2", i === 2);
    el.style.zIndex = String(10 - i);
    if (i === 0 && !el.classList.contains("dragging")) el.style.transform = "";
    deck.append(el);
  }
  for (const el of keep.values()) if (!el.classList.contains("leaving")) el.remove();
  // DOM order: top card last so it paints above the others.
  [...deck.querySelectorAll(".card:not(.leaving)")].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex)).forEach((el) => deck.append(el));
}

function hue(n) {
  const h = (n * 47) % 360;
  return [`hsl(${h} 70% 42%)`, `hsl(${(h + 50) % 360} 75% 30%)`];
}

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function cardInner(pr) {
  const [h1, h2] = hue(pr.number);
  const rv = state.reviews[pr.number];
  return `
    <div class="stamp like">MERGE</div><div class="stamp nope">CLOSE</div>
    <header class="hero" style="--h1:${h1};--h2:${h2}">
      <div class="hero-top">
        <img class="avatar" src="https://github.com/${esc(pr.author)}.png?size=112" alt="" draggable="false">
        <div class="who">
          <div class="num">${esc(state.repo)} #${pr.number}</div>
          <div class="author">@${esc(pr.author)}</div>
          <div class="age">updated ${ago(pr.updatedAt)}</div>
        </div>
      </div>
      <h3>${esc(pr.title)}</h3>
      <div class="tags">
        ${pr.draft ? `<span class="tag draft">Draft</span>` : ""}
        <span class="tag add">+${pr.additions ?? 0}</span><span class="tag del">−${pr.deletions ?? 0}</span>
        <span class="tag">${pr.changedFiles ?? "?"} files</span>
        ${pr.headRefName ? `<span class="tag mono">${esc(pr.headRefName)} → ${esc(pr.baseRefName)}</span>` : ""}
      </div>
    </header>
    <div class="body">${reviewHtml(pr, rv)}</div>`;
}

const VERDICT = {
  merge: { icon: "💚", text: "Swipe right" },
  needs_work: { icon: "🛠️", text: "Needs work first" },
  close: { icon: "💔", text: "Swipe left" },
};
const tone = {
  risk: { low: "good", medium: "warn", high: "bad" },
  confidence: { high: "good", medium: "warn", low: "bad" },
  ci: { passing: "good", pending: "warn", failing: "bad", none: "" },
  mergeable: { clean: "good", blocked: "warn", conflicts: "bad", unknown: "" },
};

function reviewHtml(pr, rv) {
  const prUrl = `https://github.com/${state.repo}/pull/${pr.number}`;
  const foot = (extra = "") => `<div class="card-foot"><a class="link" href="${prUrl}" target="_blank" rel="noopener">Open on GitHub ↗</a>${extra}</div>`;
  if (!rv) {
    return `<div class="reviewing"><div class="radar"></div><h4>Queued for review</h4><p class="sub">The agent picks this up as soon as a slot frees.</p></div>${foot()}`;
  }
  if (rv.status === "failed") {
    return `<div class="errorbox"><b>The review failed.</b><br><span class="small">${esc(rv.error ?? "The agent could not complete this request.")}</span><br>
      <button class="ghost" data-rereview="${pr.number}">Retry review</button></div>${foot()}`;
  }
  if (rv.status !== "done" || !rv.result) {
    return `<div class="reviewing"><div class="radar"></div><h4>Agent is reviewing…</h4>
      <p class="sub">Cloning, reading the diff in context, checking CI and running tests.</p>${logHtml(rv.log) || `<ul class="log"></ul>`}</div>${foot()}`;
  }
  const r = rv.result.review;
  const v = VERDICT[r.verdict] ?? VERDICT.needs_work;
  const checks = r.checks ?? {};
  const fact = (k, val, t) => `<div class="fact"><div class="k">${k}</div><div class="v ${t ?? ""}">${esc(val ?? "—").replace("_", " ")}</div></div>`;
  const findings = (r.findings ?? []).map((f) => {
    const loc = f.file
      ? `<a class="loc" href="https://github.com/${state.repo}/blob/${esc(r.headSha)}/${esc(f.file)}${f.line ? `#L${f.line}` : ""}" target="_blank" rel="noopener">${esc(f.file)}${f.line ? `:${f.line}` : ""}</a>`
      : "";
    return `<li class="finding" style="--sev:var(--${esc(f.severity)})">
      <div class="row"><span class="sev">${esc(f.severity)}</span><span class="t">${esc(f.title)}</span></div>
      ${loc}<p>${esc(f.detail)}</p>${f.suggestion ? `<p class="fix"><b>Fix:</b> ${esc(f.suggestion)}</p>` : ""}</li>`;
  }).join("");
  return `
    <div class="verdict ${esc(r.verdict)}"><span class="icon">${v.icon}</span>
      <div><div class="label">Agent says</div><div class="value">${v.text}</div></div></div>
    ${r.tagline ? `<p class="tagline">“${esc(r.tagline)}”</p>` : ""}
    <p class="summary">${esc(r.summary)}</p>
    <div class="facts">
      ${fact("Risk", r.risk, tone.risk[r.risk])}
      ${fact("Confidence", r.confidence, tone.confidence[r.confidence])}
      ${fact("CI", checks.ci, tone.ci[checks.ci])}
      ${fact("Merge", checks.mergeable, tone.mergeable[checks.mergeable])}
    </div>
    ${r.strengths?.length ? `<div class="section-title">Green flags</div><ul class="flags green">${r.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
    <div class="section-title">${r.findings?.length ? `Red flags (${r.findings.length})` : "Red flags"}</div>
    ${r.findings?.length ? `<ul class="flags">${findings}</ul>` : `<p class="muted small">None found. The agent checked and came up clean.</p>`}
    ${checks.testsRun ? `<p class="tests">🧪 ${esc(checks.testsRun)}</p>` : ""}
    ${foot(`<button data-rereview="${pr.number}">↻ Re-review</button>`)}`;
}

function logHtml(log = []) {
  const lines = log.filter((l) => l.kind !== "done").slice(-8);
  if (!lines.length) return "";
  return `<ul class="log">${lines.map((l) => `<li class="${l.kind}">${esc(l.text)}</li>`).join("")}</ul>`;
}

$("#deck").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rereview]");
  if (!b) return;
  const pr = Number(b.dataset.rereview);
  delete state.reviews[pr];
  startReview(pr, true);
});

// ---------- Review scheduling ----------
function running() {
  return Object.values(state.reviews).filter((r) => r.status === "running").length;
}
async function startReview(pr, force = false) {
  if (state.reviews[pr] && !force) return;
  const repo = state.repo;
  const sha = state.queue.find((p) => p.number === pr)?.headSha;
  state.reviews[pr] = { jobId: null, cursor: 0, status: "running", result: null, log: [{ kind: "step", text: "Starting a review session" }] };
  renderDeck();
  try {
    const { jobId } = await api.startReview(repo, pr, sha, force);
    if (state.repo !== repo) return;
    state.reviews[pr].jobId = jobId;
  } catch (err) {
    state.reviews[pr] = { status: "failed", error: err.message, log: [] };
    renderDeck();
  }
}
function pump() {
  // Review every card in deck order, a few at a time.
  if (state.listing) return; // wait for the live list so reviews target current commits
  for (const pr of state.queue) {
    if (running() >= MAX_PARALLEL_REVIEWS) break;
    if (!state.reviews[pr.number]) startReview(pr.number);
  }
}

let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  for (;;) {
    const repo = state.repo;
    const active = Object.entries(state.reviews).filter(([, r]) => r.status === "running" && r.jobId);
    await Promise.all(active.map(async ([pr, r]) => {
      try {
        const job = await api.job(r.jobId, r.cursor);
        if (state.repo !== repo || state.reviews[pr] !== r) return;
        r.cursor = job.cursor;
        r.log.push(...job.events);
        if (job.result?.kind === "review") {
          r.status = "done";
          r.result = job.result;
        } else if (["failed", "cancelled"].includes(job.turnStatus) || (job.turnStatus === "completed" && !job.result)) {
          r.status = "failed";
          r.error = r.log.filter((l) => l.kind === "error").pop()?.text ?? "The agent finished without reporting a review.";
        }
      } catch {}
    }));
    if (state.repo) {
      if (active.length) renderDeck();
      pump();
    }
    await sleep(2000);
  }
}

// ---------- Swiping ----------
function attachDrag(el) {
  let start = null;
  const like = () => el.querySelector(".stamp.like");
  const nope = () => el.querySelector(".stamp.nope");
  el.addEventListener("pointerdown", (e) => {
    if (el !== topCard() || e.button !== 0) return;
    if (e.target.closest("a, button, .log, .finding")) return;
    // In the scrollable body only mouse drags swipe; touch scrolls.
    if (e.target.closest(".body") && e.pointerType !== "mouse") return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  });
  el.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      start.moved = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      window.getSelection()?.removeAllRanges();
    }
    el.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 18}deg)`;
    like().style.opacity = String(Math.max(0, Math.min(1, dx / 110)));
    nope().style.opacity = String(Math.max(0, Math.min(1, -dx / 110)));
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const moved = start.moved;
    start = null;
    el.classList.remove("dragging");
    if (!moved) return;
    if (dx > 120) return decide("merge");
    if (dx < -120) return decide("close");
    el.style.transform = "";
    like().style.opacity = "0";
    nope().style.opacity = "0";
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function topCard() {
  const pr = state.queue[0];
  return pr ? $(`#deck .card[data-pr="${pr.number}"]`) : null;
}

function flyOut(el, dir) {
  if (!el) return;
  el.classList.add("leaving");
  el.style.zIndex = "20";
  const x = dir === "merge" ? 1.4 : dir === "close" ? -1.4 : 0;
  el.style.transform = dir === "skip"
    ? "translateY(-120%) rotate(-4deg)"
    : `translate(${x * window.innerWidth}px, 40px) rotate(${x * 22}deg)`;
  el.style.opacity = "0";
  if (dir !== "skip") el.querySelector(dir === "merge" ? ".stamp.like" : ".stamp.nope").style.opacity = "1";
  setTimeout(() => el.remove(), 400);
}

function decide(dir) {
  const pr = state.queue[0];
  if (!pr) return;
  flushPending(); // a new swipe commits the previous one immediately
  flyOut(topCard(), dir);
  state.queue.shift();
  if (dir !== "skip") state.decided.add(pr.number);
  if (dir === "skip") {
    state.queue.push(pr);
    renderDeck();
    return;
  }
  renderDeck();
  pump();

  const review = state.reviews[pr.number]?.result?.review;
  const serious = (review?.findings ?? []).filter((f) => f.severity === "blocker" || f.severity === "major").length;
  let note = "";
  if (dir === "merge" && !review) note = "Not reviewed yet.";
  else if (dir === "merge" && serious) note = `Agent flagged ${serious} blocker/major issue${serious > 1 ? "s" : ""}.`;
  else if (dir === "close" && review?.verdict === "merge") note = "The agent liked this one.";

  const verb = dir === "merge" ? "Merging" : "Closing";
  const toast = addToast(`${dir === "merge" ? "💚" : "💔"} ${verb} #${pr.number} in 5s`, note, { undo: true, duration: UNDO_MS });
  const pending = {
    pr, dir, toast,
    timer: setTimeout(() => commit(pending), UNDO_MS),
  };
  toast.onUndo = () => {
    clearTimeout(pending.timer);
    state.pending = null;
    toast.remove();
    state.decided.delete(pr.number);
    state.queue.unshift(pr);
    renderDeck();
  };
  state.pending = pending;
}

function flushPending() {
  const p = state.pending;
  if (!p) return;
  clearTimeout(p.timer);
  commit(p);
}

async function commit(p) {
  if (state.pending === p) state.pending = null;
  const { pr, dir } = p;
  const repo = state.repo;
  p.toast.update(`${dir === "merge" ? "Merging" : "Closing"} #${pr.number}…`, "The agent is running it on GitHub.", { spinner: true });
  const outcome = await runAction({ repo, pr: pr.number, action: dir, method: $("#merge-method").value });
  if (outcome.ok) {
    state.decided.add(pr.number);
    p.toast.update(dir === "merge" ? `💚 Merged #${pr.number}` : `💔 Closed #${pr.number}`, outcome.message, { kind: "ok", link: outcome.url, ttl: 6000 });
    if (dir === "merge") showMatch(pr);
  } else {
    p.toast.update(`Couldn't ${dir} #${pr.number}`, outcome.message, {
      kind: "err",
      link: `https://github.com/${repo}/pull/${pr.number}`,
      action: state.repo === repo ? { label: "Put back", run: () => { state.decided.delete(pr.number); state.queue.unshift(pr); renderDeck(); } } : null,
    });
  }
}

async function runAction(body) {
  try {
    const { jobId } = await api.act({ ...body, clientId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    let cursor = 0;
    const log = [];
    for (let i = 0; i < 400; i++) {
      const job = await api.job(jobId, cursor);
      cursor = job.cursor;
      log.push(...job.events);
      if (job.result?.kind === "action") return job.result.action;
      if (["failed", "cancelled"].includes(job.turnStatus) || (job.turnStatus === "completed" && !job.result)) {
        return { ok: false, message: log.filter((l) => l.kind === "error").pop()?.text ?? "The agent did not report a result." };
      }
      await sleep(1500);
    }
    return { ok: false, message: "Timed out waiting for the agent." };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ---------- Comment ----------
let commentPr = null;
function openComment() {
  const pr = state.queue[0];
  if (!pr) return;
  commentPr = pr;
  $("#comment-title").textContent = `Comment on #${pr.number}`;
  const body = $("#comment-body");
  body.value = "";
  const review = state.reviews[pr.number]?.result?.review;
  const chips = $("#comment-chips");
  chips.innerHTML = "";
  if (review) {
    const add = (label, text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = label;
      b.onclick = () => {
        body.value = (body.value.trim() ? body.value.trim() + "\n\n" : "") + text;
        body.focus();
      };
      chips.append(b);
    };
    if (review.findings?.length) add("＋ All findings", formatReview(review));
    for (const f of review.findings ?? []) add(`＋ ${f.title}`, formatFinding(f));
  }
  $("#comment-dialog").showModal();
  body.focus();
}
function formatFinding(f) {
  const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : "";
  return `**${f.severity}: ${f.title}**${loc}\n${f.detail}${f.suggestion ? `\n\nSuggested fix: ${f.suggestion}` : ""}`;
}
function formatReview(r) {
  return `${r.summary}\n\n${r.findings.map((f, i) => `${i + 1}. ${formatFinding(f)}`).join("\n\n")}`;
}
$("#comment-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "send") return;
  const text = $("#comment-body").value.trim();
  if (!text) {
    e.preventDefault();
    return;
  }
  const pr = commentPr;
  const toast = addToast(`💬 Commenting on #${pr.number}…`, "The agent is posting it.", { spinner: true });
  const outcome = await runAction({ repo: state.repo, pr: pr.number, action: "comment", body: text });
  toast.update(outcome.ok ? `💬 Commented on #${pr.number}` : `Couldn't comment on #${pr.number}`, outcome.message, {
    kind: outcome.ok ? "ok" : "err",
    link: outcome.url ?? `https://github.com/${state.repo}/pull/${pr.number}`,
    ttl: outcome.ok ? 6000 : undefined,
  });
});

// ---------- Toasts ----------
function addToast(title, sub, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  const t = {
    el,
    onUndo: null,
    remove() { el.remove(); },
    update(title, sub, o = {}) {
      el.className = `toast ${o.kind ?? ""}`;
      el.innerHTML = `${o.spinner ? `<span class="spinner"></span>` : ""}<div class="msg">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
      if (o.link) el.insertAdjacentHTML("beforeend", `<a href="${esc(o.link)}" target="_blank" rel="noopener">View ↗</a>`);
      if (o.action) {
        const b = document.createElement("button");
        b.textContent = o.action.label;
        b.onclick = () => { o.action.run(); el.remove(); };
        el.append(b);
      }
      if (o.undo) {
        const b = document.createElement("button");
        b.textContent = "Undo";
        b.onclick = () => t.onUndo?.();
        el.append(b);
      }
      if (o.duration) el.insertAdjacentHTML("beforeend", `<div class="bar" style="animation-duration:${o.duration}ms"></div>`);
      if (!o.spinner && !o.undo) {
        clearTimeout(t.ttl);
        t.ttl = setTimeout(() => el.remove(), o.ttl ?? 12000);
      }
    },
  };
  t.update(title, sub, opts);
  $("#toasts").append(el);
  return t;
}

// ---------- Match ----------
function showMatch(pr) {
  $("#match-sub").textContent = `#${pr.number} “${pr.title}” is merged into ${pr.baseRefName ?? "the base branch"}.`;
  $("#match").hidden = false;
  $("#match-close").focus();
}
$("#match-close").onclick = () => ($("#match").hidden = true);
$("#match").onclick = (e) => { if (e.target.id === "match") $("#match").hidden = true; };

// ---------- Controls ----------
document.querySelector(".controls").onclick = (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  if (b.dataset.act === "comment") openComment();
  else decide(b.dataset.act);
};
document.addEventListener("keydown", (e) => {
  if ($("#comment-dialog").open || $("#screen-deck").hidden || e.metaKey || e.ctrlKey) return;
  if (e.target.matches("input, textarea, select")) return;
  if (!$("#match").hidden) {
    if (e.key === "Escape" || e.key === "Enter") $("#match").hidden = true;
    return;
  }
  if (!state.queue.length) return;
  if (e.key === "ArrowRight") decide("merge");
  else if (e.key === "ArrowLeft") decide("close");
  else if (e.key === "ArrowUp") decide("skip");
  else if (e.key.toLowerCase() === "c") { e.preventDefault(); openComment(); }
});
window.addEventListener("beforeunload", (e) => {
  if (state.pending) e.preventDefault();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

boot();
pollLoop();
