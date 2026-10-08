import { defineSchedule } from "@opencomputer/agent";

// Keeps a fresh review ready for every open PR, so the app opens with verdicts
// instead of spinners. Reviews are keyed by head commit, so a quiet repo costs
// one cheap listing per run.
export default defineSchedule({
  id: "sweep",
  cron: "*/15 * * * *",
  timezone: "UTC",
  enabled: ["production"],
  overlap: "skip",
  dispatch: {
    text: "Sweep open pull requests and queue reviews.",
    payload: { mode: "sweep" },
  },
});
