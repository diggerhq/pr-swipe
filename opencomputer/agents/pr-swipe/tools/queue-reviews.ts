import { defineConnection, defineTool, secretHeader, useSecret } from "@opencomputer/agent";

// The management API, so the background sweep can start one review session
// per pull request. The key stays at OpenComputer's outbound edge.
export const managedAgents = defineConnection({
  id: "opencomputer-api",
  origin: "https://app.opencomputer.dev",
  methods: ["POST"],
  pathPrefix: "/api/managed-agents/sessions",
  headers: {
    "x-api-key": secretHeader(useSecret("OC_API_KEY")),
  },
});

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;
const MAX_PER_CALL = 5;

// Same key the web app uses, so a commit is reviewed once whoever asks first.
export const reviewKey = (repo: string, pr: number, sha: string) => `pr-swipe:review:${repo}#${pr}@${sha}`;

export const queueReviews = defineTool({
  name: "queue_reviews",
  description:
    "Start background review sessions for open pull requests of one repository. Pass each PR's number and head commit SHA. A PR already reviewed at that SHA is skipped. At most 5 new reviews start per call; the result says which were started, skipped or deferred.",
  input: {
    type: "object",
    required: ["repo", "prs"],
    additionalProperties: false,
    properties: {
      repo: { type: "string", description: "owner/name" },
      prs: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          required: ["number", "headSha"],
          additionalProperties: false,
          properties: {
            number: { type: "integer" },
            headSha: { type: "string" },
          },
        },
      },
    },
  },
  async run({ input, agentId, signal }) {
    const repo = String(input.repo);
    if (!REPO.test(repo)) throw new Error("repo must be owner/name");
    const prs = (input.prs as Array<{ number: number; headSha: string }>).filter(
      (p) => Number.isInteger(p.number) && p.number > 0 && SHA.test(String(p.headSha)),
    );
    const started: number[] = [];
    const skipped: number[] = [];
    const deferred: number[] = [];
    for (const pr of prs) {
      if (started.length >= MAX_PER_CALL) {
        deferred.push(pr.number);
        continue;
      }
      const key = reviewKey(repo, pr.number, pr.headSha);
      const created = await managedAgents.fetch("/api/managed-agents/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          agentId: `${agentId.split("@")[0]}@default`,
          labels: { app: "pr-swipe", kind: "review", repo, pr: String(pr.number), sha: pr.headSha, by: "sweep" },
          externalReference: `review:${repo}#${pr.number}`,
        }),
        signal,
      });
      if (!created.ok) throw new Error(`create session for #${pr.number}: ${created.status} ${await created.text()}`);
      if (created.status === 200) {
        skipped.push(pr.number); // this commit already has a review session
        continue;
      }
      const { session } = (await created.json()) as { session: { id: string } };
      const turn = await managedAgents.fetch(`/api/managed-agents/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${key}/start` },
        body: JSON.stringify({ input: `Review ${repo}#${pr.number}`, payload: { mode: "review", repo, pr: pr.number } }),
        signal,
      });
      if (!turn.ok) throw new Error(`start review for #${pr.number}: ${turn.status} ${await turn.text()}`);
      started.push(pr.number);
    }
    return { repo, started, skipped, deferred };
  },
});
