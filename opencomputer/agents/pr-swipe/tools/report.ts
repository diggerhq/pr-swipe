import { defineTool } from "@opencomputer/agent";

// The session result the swipe app reads. One tool covers all three modes:
// `prs` (open pull requests of a repo), `review` (one PR's verdict and
// findings) and `action` (what a swipe did on GitHub).
const reportOutput = {
  type: "object",
  required: ["kind"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["prs", "review", "action"] },
    prs: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        required: ["number", "title", "author"],
        additionalProperties: false,
        properties: {
          number: { type: "integer" },
          title: { type: "string", maxLength: 140 },
          author: { type: "string" },
          additions: { type: "integer" },
          deletions: { type: "integer" },
          changedFiles: { type: "integer" },
          draft: { type: "boolean" },
          updatedAt: { type: "string" },
          headRefName: { type: "string" },
          baseRefName: { type: "string" },
          headSha: { type: "string" },
        },
      },
    },
    review: {
      type: "object",
      required: ["pr", "headSha", "verdict", "confidence", "risk", "summary", "findings"],
      additionalProperties: false,
      properties: {
        pr: { type: "integer" },
        headSha: { type: "string" },
        // The card's front, so the app can show a reviewed PR before it re-lists the repo.
        meta: {
          type: "object",
          required: ["title", "author"],
          additionalProperties: false,
          properties: {
            title: { type: "string", maxLength: 140 },
            author: { type: "string" },
            additions: { type: "integer" },
            deletions: { type: "integer" },
            changedFiles: { type: "integer" },
            draft: { type: "boolean" },
            updatedAt: { type: "string" },
            headRefName: { type: "string" },
            baseRefName: { type: "string" },
          },
        },
        verdict: { type: "string", enum: ["merge", "needs_work", "close"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        tagline: { type: "string", maxLength: 120 },
        summary: { type: "string", maxLength: 1200 },
        strengths: { type: "array", maxItems: 4, items: { type: "string", maxLength: 200 } },
        findings: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            required: ["severity", "title", "detail"],
            additionalProperties: false,
            properties: {
              severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
              file: { type: "string" },
              line: { type: "integer" },
              title: { type: "string", maxLength: 160 },
              detail: { type: "string", maxLength: 700 },
              suggestion: { type: "string", maxLength: 400 },
            },
          },
        },
        checks: {
          type: "object",
          additionalProperties: false,
          properties: {
            ci: { type: "string", enum: ["passing", "failing", "pending", "none"] },
            mergeable: { type: "string", enum: ["clean", "conflicts", "blocked", "unknown"] },
            testsRun: { type: "string", maxLength: 300 },
          },
        },
      },
    },
    action: {
      type: "object",
      required: ["type", "ok", "message"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["merge", "close", "comment"] },
        ok: { type: "boolean" },
        url: { type: "string" },
        message: { type: "string", maxLength: 500 },
      },
    },
  },
} as const;

export const report = defineTool({
  name: "report",
  description:
    "Report the structured outcome of this turn to the swipe app. Call exactly once, at the end of the turn, with kind matching the mode: 'prs', 'review' or 'action'.",
  input: reportOutput,
  output: reportOutput,
  result: true,
  run({ input }) {
    const kind = input.kind;
    if (kind === "prs" && !Array.isArray(input.prs)) throw new Error("kind 'prs' needs prs[]");
    if (kind === "review" && !input.review) throw new Error("kind 'review' needs review");
    if (kind === "action" && !input.action) throw new Error("kind 'action' needs action");
    return input as Record<string, never>;
  },
});
