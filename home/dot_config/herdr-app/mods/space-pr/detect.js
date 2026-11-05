// Finding the active space's folder and summarizing GitHub checks, shared by the PR panel and the tab bar.

import { spaces, panes, focused, exec } from "herdr";

/**
 * Branch names treated as a repo's main line even when origin/HEAD says otherwise. A PR
 * lookup on these resolves stale PRs that once used them as a head branch.
 */
export const MAIN_BRANCHES = new Set(["main", "master", "dev", "stage", "develop", "development", "trunk"]);

/**
 * Whether a location is on its repo's main line: a conventional main branch name or origin's default branch.
 * Asks git for the branch when the terminal didn't report one.
 * @param loc A `location()` result
 * @returns True when the branch's own pull request shouldn't be looked up
 */
export async function onMainBranch(loc) {
  const opts = { cwd: loc.cwd, on: loc.on };
  const branch = loc.branch ?? (await exec("git", ["branch", "--show-current"], opts)).stdout?.trim();
  if (!branch) return false;
  if (MAIN_BRANCHES.has(branch)) return true;
  const r = await exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], opts);
  return r.code === 0 && r.stdout.trim().replace(/^origin\//, "") === branch;
}

/**
 * Where the active space is now: the focused terminal's folder, else its first terminal's.
 * @returns `{ space, name, on, cwd, branch, key }`, or null when the space has no folder
 */
export function location() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const own = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  const f = focused();
  const pane = own.find((p) => p.pane === f?.pane) ?? own.find((p) => p.tab === f?.tab) ?? own[0];
  const cwd = pane?.cwd ?? space.folder;
  if (!cwd) return null;
  const branch = pane?.branch ?? space.branch;
  return { space: space.id, name: space.name, on: space.machine, cwd, branch, key: `${space.machine}|${cwd}|${branch}` };
}

/**
 * Collapses a GitHub check run or commit status into one shape.
 * @param c An entry of `statusCheckRollup` (CheckRun or StatusContext)
 * @returns `{ name, url, result }` where result is "pass" | "fail" | "pending"
 */
export function check(c) {
  if (c.__typename === "StatusContext") {
    const result = c.state === "SUCCESS" ? "pass" : c.state === "FAILURE" || c.state === "ERROR" ? "fail" : "pending";
    return { name: c.context, url: c.targetUrl, result };
  }
  const done = c.status === "COMPLETED";
  const ok = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion);
  return { name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.name, url: c.detailsUrl, result: !done ? "pending" : ok ? "pass" : "fail" };
}

/**
 * The overall result of a PR's checks: any failure wins, then anything still running.
 * @param rollup A PR's `statusCheckRollup`
 * @returns "fail" | "pending" | "pass", or null when no checks reported
 */
export function overall(rollup) {
  const results = (rollup ?? []).map((c) => check(c).result);
  if (!results.length) return null;
  return results.includes("fail") ? "fail" : results.includes("pending") ? "pending" : "pass";
}

/**
 * Whether a PR can be merged now: open, not a draft, approved, every check passed, and GitHub reports no conflicts or block.
 * @param pr A PR with state, isDraft, reviewDecision, mergeStateStatus and statusCheckRollup
 * @returns True when it's ready to merge
 */
export function readyToMerge(pr) {
  return pr.state === "OPEN" && !pr.isDraft && pr.reviewDecision === "APPROVED"
    && overall(pr.statusCheckRollup) === "pass" && !["DIRTY", "BLOCKED"].includes(pr.mergeStateStatus);
}
