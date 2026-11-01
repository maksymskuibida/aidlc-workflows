// covers: subcommand:aidlc-unit:finish, subcommand:aidlc-unit:claim, subcommand:aidlc-unit:status, subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:status, function:renderTeamConstructionBoard
//
// A team Unit merged by a pull request someone built by hand, without
// `aidlc unit land`, reaches main complete but with no UNIT_MERGED receipt,
// and its claim stays open. Nothing could finish that state, and every
// command read it its own way: `next` said to claim it again with --reopen,
// `claim --reopen` counted no landed attempt and called the open claim live
// ("already claimed"), `finish` without a merge transaction only closed a
// checkout's scope, `unit status` hid the Unit, and `engine status` called it
// claimed and in progress.
//
// `aidlc unit finish <unit> --pr <owner>/<repo>#<n>` now records that landing
// after the merge: the pull request is merged, its merge commit is on main and
// its head contains the claim's published candidate (or the person accepts
// the difference with --accept-merged-drift), so the receipt is the claim's
// attempt. The receipt is committed on a branch of its own off main for the
// project to merge; once it is on main, the Unit reads as landed everywhere and
// `claim --reopen` claims the next attempt. Until then every command names that
// step.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  ORCH,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
} from "../harness/team-unit-merge.ts";
import {
  fakeGitHub,
  type FakeGitHub,
  mergePullRequest,
  type PullRequestRecord,
  WORKSPACE_GITHUB_REPO,
} from "../harness/team-unit-pr.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const WHY = "the reviewer asked for a smaller API";
const UTILITY = join(dirname(UNIT), "aidlc-utility.ts");
const PR = `${WORKSPACE_GITHUB_REPO}#1`;

// A pull request as the fake gh reports it, written straight into its record.
function recordPullRequest(gh: FakeGitHub, ref: string, fields: Partial<PullRequestRecord>): void {
  const db = JSON.parse(readFileSync(gh.db, "utf-8")) as Record<string, PullRequestRecord>;
  const opened: PullRequestRecord = {
    url: `https://github.com/${ref.replace("#", "/pull/")}`,
    state: "OPEN",
    mergedAt: null,
    mergeCommit: null,
    headRefOid: "",
    headRefName: "",
    baseRefName: "main",
    title: "",
    body: "",
    isDraft: false,
    reviewDecision: null,
    latestReviews: [],
  };
  db[ref] = { ...opened, ...db[ref], ...fields };
  writeFileSync(gh.db, JSON.stringify(db, null, 1));
}

// alpha is claimed and built in its own clone, then merged to main by a pull
// request built from that clone's branch, as a person would build it by hand:
// main has alpha complete and no landing receipt; alpha's claim is still open.
function landedByHandBuiltPr(): {
  gh: FakeGitHub;
  seed: string;
  remote: string;
  head: string;
  baseOid: string;
  mergeCommit: string;
} {
  const gh = fakeGitHub();
  const { seed, remote } = makeSeed(parallelDependencyBody());
  const baseOid = git(seed, ["rev-parse", "HEAD"]);
  const built = prepareCandidate(remote, "alpha", "alpha-team", { branch: "alpha-pr" });
  git(built.checkout, ["push", "-u", "origin", "alpha-pr"]);
  const head = git(built.checkout, ["rev-parse", "HEAD"]);
  recordPullRequest(gh, PR, { headRefOid: head, headRefName: "alpha-pr" });
  const mergeCommit = mergePullRequest(gh, remote, "alpha-pr", PR);
  git(seed, ["pull", "--ff-only"]);
  return { gh, seed, remote, head, baseOid, mergeCommit };
}

function finish(checkout: string, gh: FakeGitHub, args: string[]) {
  return runMergeTool(UNIT, ["finish", "alpha", ...args], checkout, false, gh.env);
}

function unitStatus(checkout: string): Record<string, unknown> {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return JSON.parse(status.stdout) as Record<string, unknown>;
}

// `aidlc engine status`, which shows the team board on a team main.
function engineStatus(checkout: string): string {
  const printed = runMergeTool(UTILITY, ["status"], checkout);
  expect(printed.status, printed.out).toBe(0);
  return printed.stdout;
}

describe("t-team-unit-landed-by-pr: a Unit merged without unit land gets its landing recorded", () => {
  test("every command names finish --pr; finish records the landing, and then the Unit is claimed again as the next attempt", () => {
    const { gh, seed, remote, mergeCommit } = landedByHandBuiltPr();

    // Before: each command names the one step that records the landing.
    const asked = runMergeTool(ORCH, ["next", "--stage", "code-generation", "--unit", "alpha"], seed);
    expect(asked.status, asked.out).toBe(0);
    expect(asked.stdout).toContain("aidlc unit finish alpha --pr");
    const reopenAt = asked.stdout.indexOf("unit claim alpha --reopen");
    if (reopenAt >= 0) expect(asked.stdout.indexOf("aidlc unit finish alpha --pr")).toBeLessThan(reopenAt);

    const again = clone(remote, "alpha-again");
    const refused = runMergeTool(UNIT, ["claim", "alpha", "--reopen", "--user-input", WHY], again);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("aidlc unit finish alpha --pr");
    expect(refused.out).not.toContain("already claimed");

    const before = unitStatus(seed);
    expect(before.landingNotRecorded).toEqual([{ unit: "alpha", owner: expect.any(String), generation: 1 }]);
    expect(JSON.stringify(before.claimed)).not.toContain("alpha");
    const shown = engineStatus(seed);
    expect(shown).not.toContain("in progress: claimed by alpha-team");
    expect(shown).not.toContain("**Claimed:** alpha");
    expect(shown).toContain("| alpha (complete, landing not recorded: claimed by alpha-team, attempt 1) |");
    expect(shown).toContain("aidlc unit finish alpha --pr");

    // finish --pr records the receipt on a branch of its own off main, and
    // says how it reaches main; this checkout's branch and files stay as they were.
    const recorded = finish(seed, gh, ["--pr", PR]);
    expect(recorded.status, recorded.out).toBe(0);
    const printed = JSON.parse(recorded.stdout);
    expect(printed).toMatchObject({
      recorded: true,
      unit: "alpha",
      generation: 1,
      merge_commit: mergeCommit,
      receipt_branch: "alpha-landing-record",
    });
    expect(String(printed.next_step)).toContain("git push");
    expect(git(seed, ["branch", "--show-current"])).toBe("main");
    expect(git(seed, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    const receipt = git(seed, ["show", "alpha-landing-record"]);
    expect(receipt).toContain("**Event**: UNIT_MERGED");
    expect(receipt).toContain("**Attempt Generation**: 1");
    expect(receipt).toContain(`**Merge commit OID**: ${mergeCommit}`);
    expect(receipt).toContain("https://github.com/acme/workspace/pull/1");
    expect(git(seed, ["rev-parse", "alpha-landing-record~1"])).toBe(git(seed, ["rev-parse", "origin/main"]));

    // Run again before the receipt is on main: nothing new is recorded.
    const twice = finish(seed, gh, ["--pr", PR]);
    expect(twice.status).not.toBe(0);
    expect(twice.out).toContain("alpha-landing-record");

    // The project merges the receipt; main now reads alpha as landed.
    git(seed, ["push", "origin", "alpha-landing-record:main"]);
    git(seed, ["pull", "--ff-only"]);
    const after = unitStatus(seed);
    expect(after.landingNotRecorded ?? []).toEqual([]);
    expect(JSON.stringify(after.claimed)).not.toContain("alpha");
    const landed = engineStatus(seed);
    expect(landed).not.toContain("in progress: claimed by alpha-team");
    expect(landed).not.toContain("**Claimed:** alpha");
    expect(landed).not.toContain("landing not recorded");

    // A Unit whose landing is recorded has nothing left to record.
    const done = finish(clone(remote, "late"), gh, ["--pr", PR]);
    expect(done.status).not.toBe(0);
    expect(done.out).toContain("already recorded");

    // ...and goes back to work as attempt 2, after attempt 1 that landed.
    const reopened = runMergeTool(UNIT, ["claim", "alpha", "--reopen", "--user-input", WHY], clone(remote, "alpha-3"));
    expect(reopened.status, reopened.out).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({
      claimed: true,
      unit: "alpha",
      generation: 2,
      reopen: { landed_generation: 1, reason: WHY },
    });
  });

  test("finish --pr refuses a pull request that is not merged, or whose merge commit is not on main", () => {
    const { gh, seed, head } = landedByHandBuiltPr();
    recordPullRequest(gh, `${WORKSPACE_GITHUB_REPO}#2`, { headRefOid: head });
    const open = finish(seed, gh, ["--pr", `${WORKSPACE_GITHUB_REPO}#2`]);
    expect(open.status).not.toBe(0);
    expect(open.out).toContain("is not merged");

    recordPullRequest(gh, `${WORKSPACE_GITHUB_REPO}#3`, {
      headRefOid: head,
      state: "MERGED",
      mergedAt: "2026-11-01T10:00:00Z",
      mergeCommit: { oid: head },
    });
    const elsewhere = finish(seed, gh, ["--pr", `${WORKSPACE_GITHUB_REPO}#3`]);
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.out).toContain("is not on");
    expect(git(seed, ["branch", "--list", "alpha-landing-record"])).toBe("");
  });

  test("a pull request whose head does not contain the claim's candidate is recorded only with the person's acceptance", () => {
    const { gh, seed, baseOid, mergeCommit } = landedByHandBuiltPr();
    recordPullRequest(gh, `${WORKSPACE_GITHUB_REPO}#4`, {
      headRefOid: baseOid,
      state: "MERGED",
      mergedAt: "2026-11-01T10:00:00Z",
      mergeCommit: { oid: mergeCommit },
    });
    const refused = finish(seed, gh, ["--pr", `${WORKSPACE_GITHUB_REPO}#4`]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("does not contain");
    expect(refused.out).toContain("--accept-merged-drift");
    expect(git(seed, ["branch", "--list", "alpha-landing-record"])).toBe("");

    const accepted = finish(seed, gh, [
      "--pr", `${WORKSPACE_GITHUB_REPO}#4`,
      "--accept-merged-drift", "--user-input", "I compared the branch with the claim; the rebuild only reordered commits",
    ]);
    expect(accepted.status, accepted.out).toBe(0);
    const receipt = git(seed, ["show", "alpha-landing-record"]);
    expect(receipt).toContain("**Event**: UNIT_MERGE_DRIFT_ACCEPTED");
    expect(receipt).toContain("the rebuild only reordered commits");
    expect(receipt).toContain("**Event**: UNIT_MERGED");
  });

  test("a Unit landed by unit land has its receipt already: finish --pr records nothing", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    const gh = fakeGitHub();
    prepareCandidate(remote, "alpha", "alpha-team");
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    const head = git(seed, ["rev-parse", "HEAD"]);
    recordPullRequest(gh, PR, {
      headRefOid: head,
      state: "MERGED",
      mergedAt: "2026-11-01T10:00:00Z",
      mergeCommit: { oid: head },
    });
    const elsewhere = clone(remote, "later");
    const refused = finish(elsewhere, gh, ["--pr", PR]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("already recorded");
    expect(unitStatus(elsewhere).landingNotRecorded ?? []).toEqual([]);
  });
});
