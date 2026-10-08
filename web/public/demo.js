// Demo mode (?demo): canned PRs and reviews so the swipe UX can be tried
// without GitHub or a model. Nothing here talks to the network.

const REPO = "acme/payments-api";
const now = Date.now();
const iso = (h) => new Date(now - h * 3600_000).toISOString();

const PRS = [
  { number: 482, title: "Retry webhook deliveries with exponential backoff", author: "octocat", additions: 214, deletions: 38, changedFiles: 6, draft: false, updatedAt: iso(3), headRefName: "webhook-retries", baseRefName: "main" },
  { number: 479, title: "Add idempotency keys to POST /charges", author: "monalisa", additions: 131, deletions: 12, changedFiles: 4, draft: false, updatedAt: iso(20), headRefName: "charge-idempotency", baseRefName: "main" },
  { number: 476, title: "Bump lodash to 4.17.21", author: "hubot", additions: 3, deletions: 3, changedFiles: 2, draft: false, updatedAt: iso(50), headRefName: "deps/lodash", baseRefName: "main" },
  { number: 470, title: "WIP: rewrite ledger in a weekend", author: "ghost", additions: 4120, deletions: 3877, changedFiles: 61, draft: true, updatedAt: iso(400), headRefName: "ledger-v2", baseRefName: "main" },
];

const REVIEWS = {
  482: {
    pr: 482, headSha: "9f1c2ab", verdict: "needs_work", confidence: "high", risk: "medium",
    tagline: "Persistent, never gives up on you… maybe a little too persistent.",
    summary: "Adds a retry queue for failed webhook deliveries with exponential backoff and jitter. The approach is sound and well tested, but retries are scheduled without a cap on total attempts, so a permanently failing endpoint is retried forever and the queue grows without bound.",
    strengths: ["Jitter avoids thundering-herd retries", "New tests cover 5xx and timeout paths", "Delivery attempts are logged with the event id"],
    findings: [
      { severity: "major", file: "src/webhooks/retry.ts", line: 41, title: "No maximum attempt count", detail: "scheduleRetry() re-enqueues on every failure. An endpoint returning 410 forever is retried indefinitely, and each attempt adds a row to webhook_attempts.", suggestion: "Stop after N attempts (e.g. 12) and mark the delivery as failed; treat 410 as permanent." },
      { severity: "minor", file: "src/webhooks/retry.ts", line: 58, title: "Backoff overflows after ~30 attempts", detail: "2 ** attempt * 1000 exceeds setTimeout's 2^31-1 ms limit, which Node clamps to 1 ms, so late retries fire immediately.", suggestion: "Clamp the delay to a maximum (e.g. 6 hours)." },
      { severity: "nit", file: "test/retry.test.ts", line: 12, title: "Test name says 'three' but asserts four attempts", detail: "Minor mismatch that will confuse the next reader." },
    ],
    checks: { ci: "passing", mergeable: "clean", testsRun: "npm test -- webhooks: 38 passed" },
  },
  479: {
    pr: 479, headSha: "b77e0d1", verdict: "merge", confidence: "high", risk: "low",
    tagline: "Says the same thing twice and means it once. Total keeper.",
    summary: "Accepts an Idempotency-Key header on POST /charges and replays the stored response for repeated keys within 24 hours. Keys are scoped per account, stored with a unique index, and the race between two concurrent first requests is handled by the insert conflict.",
    strengths: ["Unique (account_id, key) index closes the race", "Replays return the original status code", "Migration is additive and reversible"],
    findings: [
      { severity: "nit", file: "src/routes/charges.ts", line: 77, title: "Magic number for key TTL", detail: "86400 appears inline; a named constant would document intent.", suggestion: "const IDEMPOTENCY_TTL_SECONDS = 86400" },
    ],
    checks: { ci: "passing", mergeable: "clean", testsRun: "npm test -- charges idempotency: 21 passed" },
  },
  476: {
    pr: 476, headSha: "c0ffee1", verdict: "merge", confidence: "high", risk: "low",
    tagline: "Low maintenance, no drama, patches a prototype-pollution CVE.",
    summary: "Updates lodash from 4.17.20 to 4.17.21, which fixes CVE-2021-23337 (command injection in template). Only the lockfile and package.json change; no code uses lodash.template.",
    strengths: ["Security fix", "Lockfile-only change"],
    findings: [],
    checks: { ci: "passing", mergeable: "clean", testsRun: "Full suite: 412 passed" },
  },
  470: {
    pr: 470, headSha: "dead123", verdict: "close", confidence: "medium", risk: "high",
    tagline: "Big dreams, 61 files, hasn't texted back in 17 days.",
    summary: "A draft rewrite of the ledger that replaces double-entry postings with a single balance column. It drops the audit trail the reconciliation job depends on, has no migration for existing data and has been idle for over two weeks.",
    strengths: ["Simpler read path for balances"],
    findings: [
      { severity: "blocker", file: "src/ledger/balance.ts", line: 15, title: "Removes double-entry postings", detail: "Balances become a mutable column; reconcile.ts reads ledger_postings, which this PR drops, so nightly reconciliation fails.", suggestion: "Keep postings as the source of truth and derive balances." },
      { severity: "blocker", file: "migrations/0042_ledger_v2.sql", line: 1, title: "Destructive migration with no backfill", detail: "DROP TABLE ledger_postings runs before any data is copied." },
      { severity: "major", title: "CI failing", detail: "41 tests fail in ledger and reconciliation suites." },
    ],
    checks: { ci: "failing", mergeable: "conflicts", testsRun: "Did not run: CI already shows 41 failures in the touched suites" },
  },
};

const SCRIPT = [
  { kind: "step", text: "Sandbox attached" },
  { kind: "cmd", text: "gh pr view --json number,title,body,files,statusCheckRollup…" },
  { kind: "cmd", text: "gh pr diff > /workspace/pr.diff" },
  { kind: "cmd", text: "gh repo clone acme/payments-api /workspace/repo -- --filter=blob:none" },
  { kind: "cmd", text: "cd /workspace/repo && gh pr checkout" },
  { kind: "cmd", text: "cat AGENTS.md CONTRIBUTING.md" },
  { kind: "cmd", text: "rg -n 'scheduleRetry|deliverWebhook' src test" },
  { kind: "cmd", text: "npm ci && npm test -- webhooks" },
  { kind: "step", text: "Writing up the verdict" },
];

const jobs = new Map();
let seq = 0;
function newJob(kind, data) {
  const id = `demo-${++seq}`;
  jobs.set(id, { kind, data, started: Date.now() });
  return id;
}

export const demoApi = {
  async githubStatus() {
    return { state: "active", installation: { accountLogin: "acme", accountType: "Organization", githubInstallationId: 0 }, connections: [] };
  },
  async githubConnect() { return { attached: true }; },
  async repos() {
    return { repos: [{ fullName: REPO, private: true, defaultBranch: "main", archived: false }, { fullName: "acme/web", private: false, defaultBranch: "main", archived: false }] };
  },
  async listPrs(repo) { return { jobId: newJob("list", { repo }) }; },
  async reviews() { return { reviews: {} }; },
  async startReview(repo, pr) { return { jobId: newJob("review", { repo, pr }) }; },
  async act(body) { return { jobId: newJob("action", body) }; },
  async job(id, after) {
    const j = jobs.get(id);
    const t = Date.now() - j.started;
    if (j.kind === "list") {
      const done = t > 1200;
      return { turnStatus: done ? "completed" : "running", cursor: 0, events: [], result: done ? { kind: "prs", prs: j.data.repo === REPO ? PRS : [] } : null };
    }
    if (j.kind === "review") {
      const per = 700 + (j.data.pr % 5) * 150;
      const upto = Math.min(SCRIPT.length, Math.floor(t / per));
      const events = SCRIPT.slice(after, upto).map((e, i) => ({ ...e, seq: after + i + 1 }));
      const done = upto >= SCRIPT.length;
      const review = REVIEWS[j.data.pr];
      return { turnStatus: done ? "completed" : "running", cursor: upto, events, result: done && review ? { kind: "review", review } : null };
    }
    const done = t > 2200;
    if (!done) return { turnStatus: "running", cursor: 0, events: [], result: null };
    const { action, pr } = j.data;
    // Show the failure path once: branch protection blocks merging #482.
    const blocked = action === "merge" && pr === 482;
    return {
      turnStatus: "completed", cursor: 0, events: [],
      result: { kind: "action", action: {
        type: action, ok: !blocked,
        url: `https://github.com/${REPO}/pull/${pr}`,
        message: blocked
          ? "gh: Pull request acme/payments-api#482 is not mergeable: the base branch policy prohibits the merge (1 approving review required)."
          : `Demo: would have run gh pr ${action} ${pr}.`,
      } },
    };
  },
};
