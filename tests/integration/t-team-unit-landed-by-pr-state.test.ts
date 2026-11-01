// covers: subcommand:aidlc-unit:finish, subcommand:aidlc-unit:land, function:mainStateCarriedBy
//
// A team Unit's branch carries the Unit's own walk in the state file: its
// Current Stage, Status, stage markers, Last Updated. `aidlc unit land` keeps
// main's state file and folds only the Unit's row, but a pull request built by
// hand from the branch brings the whole file to main, so main read the Unit's
// `Current Stage: code-generation`. `finish --pr` recorded the landing and left
// that as it was, and the guards refuse a hand edit of the state file, so
// nothing could put main's back.
//
// `finish --pr` now puts main's part of the state file back as the merge's
// first parent had it (keeping what main changed there since, and the Unit
// Progress table as main has it), in the same commit as the receipt; run again
// once the receipt is on main without it, it commits the repair alone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
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

const PR = `${WORKSPACE_GITHUB_REPO}#1`;

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

// The Unit's walk as its checkout's state file holds it at Code Generation.
function walkTheUnit(checkout: string): void {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation")
      .replace(/^- \*\*Last Updated\*\*: .*$/m, "- **Last Updated**: 2026-09-02T10:00:00Z")
      .replace(/^- \[ \] code-generation — EXECUTE$/m, "- [-] code-generation — EXECUTE")
      .replace(/^## Current Status$/m, "\n\n\n## Current Status"),
  );
}

function statePath(checkout: string): string {
  return relative(checkout, seededStateFile(checkout)).split("\\").join("/");
}

function unitProgress(state: string): string {
  return /^## Unit Progress$[\s\S]*?(?=^## )/m.exec(state)?.[0] ?? "";
}

// Main's state file as `unit land` leaves it: main's own, with the Unit
// Progress table main has now.
function asLandLeavesIt(before: string, now: string): string {
  return before.replace(unitProgress(before), unitProgress(now));
}

// alpha is built in its own clone on a branch whose state file carries its
// walk, and merged to main by a pull request built from that branch by hand.
function landedByHandBuiltPr(): { gh: FakeGitHub; seed: string; remote: string; mergeCommit: string } {
  const gh = fakeGitHub();
  const { seed, remote } = makeSeed(parallelDependencyBody());
  const built = prepareCandidate(remote, "alpha", "alpha-team", { branch: "alpha-pr" });
  walkTheUnit(built.checkout);
  git(built.checkout, ["commit", "-qam", "alpha: Code Generation"]);
  git(built.checkout, ["push", "-u", "origin", "alpha-pr"]);
  recordPullRequest(gh, PR, { headRefOid: git(built.checkout, ["rev-parse", "HEAD"]), headRefName: "alpha-pr" });
  const mergeCommit = mergePullRequest(gh, remote, "alpha-pr", PR);
  git(seed, ["pull", "--ff-only"]);
  return { gh, seed, remote, mergeCommit };
}

function finish(checkout: string, gh: FakeGitHub) {
  return runMergeTool(UNIT, ["finish", "alpha", "--pr", PR], checkout, false, gh.env);
}

describe("t-team-unit-landed-by-pr-state: finish --pr puts main's state back", () => {
  test("the receipt's commit puts main's part of the state file back, keeping the Unit's row", () => {
    const { gh, seed, mergeCommit } = landedByHandBuiltPr();
    const path = statePath(seed);
    const carried = git(seed, ["show", `origin/main:${path}`]);
    expect(carried).toContain("- **Current Stage**: code-generation");

    const recorded = finish(seed, gh);
    expect(recorded.status, recorded.out).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ recorded: true, state_restored: true });
    const repaired = git(seed, ["show", `alpha-landing-record:${path}`]);
    expect(repaired).toBe(asLandLeavesIt(git(seed, ["show", `${mergeCommit}^1:${path}`]), carried));
    expect(repaired).toContain("- **Current Stage**: functional-design");
    expect(repaired).toContain("- **Last Updated**: 2026-08-20T00:00:00Z");
    expect(unitProgress(repaired)).toContain("| alpha | alpha-team |");
    const changed = git(seed, ["show", "alpha-landing-record", "--format=", "--name-only"]).split("\n");
    expect(changed).toHaveLength(2);
    expect(changed).toContain(path);
    expect(changed.some((file) => file.includes("/audit/"))).toBe(true);

    git(seed, ["push", "origin", "alpha-landing-record:main"]);
    git(seed, ["pull", "--ff-only"]);
    const again = finish(seed, gh);
    expect(again.status).not.toBe(0);
    expect(again.out).toContain("already recorded");
  });

  test("a receipt already on main without main's state: finish --pr commits the repair alone, also with the Unit reopened", () => {
    const { gh, seed, remote } = landedByHandBuiltPr();
    const path = statePath(seed);
    const carried = git(seed, ["show", `origin/main:${path}`]);
    expect(finish(seed, gh).status).toBe(0);
    // Main takes the receipt and nothing else, as an earlier finish --pr wrote it.
    const shard = git(seed, ["show", "alpha-landing-record", "--format=", "--name-only"])
      .split("\n").find((file) => file.includes("/audit/"))!;
    git(seed, ["checkout", "alpha-landing-record", "--", shard]);
    git(seed, ["commit", "-qm", "Record alpha's landing"]);
    git(seed, ["push", "origin", "main"]);
    git(seed, ["branch", "-D", "alpha-landing-record"]);
    // The Unit went back to work as attempt 2 since, in a checkout of its own.
    const reopened = clone(remote, "alpha-2");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--reopen", "--user-input", "the review asked for more"], reopened);
    expect(claimed.status, claimed.out).toBe(0);

    // Run in the reopened attempt's checkout, the repair leaves its scope as it is.
    const fromAttempt = finish(reopened, gh);
    expect(fromAttempt.status, fromAttempt.out).toBe(0);
    expect(JSON.parse(fromAttempt.stdout)).toMatchObject({ state_restored: true, generation: 1 });
    expect(existsSync(join(reopened, "aidlc", ".aidlc-unit-scope.json"))).toBe(true);

    const repaired = finish(seed, gh);
    expect(repaired.status, repaired.out).toBe(0);
    const printed = JSON.parse(repaired.stdout);
    expect(printed).toMatchObject({ state_restored: true, unit: "alpha", state_branch: "alpha-state-repair" });
    expect(String(printed.next_step)).toContain("git push");
    expect(git(seed, ["show", "alpha-state-repair", "--format=", "--name-only"])).toBe(path);
    const state = git(seed, ["show", `alpha-state-repair:${path}`]);
    expect(state).toContain("- **Current Stage**: functional-design");
    expect(unitProgress(state)).toBe(unitProgress(carried));

    git(seed, ["push", "origin", "alpha-state-repair:main"]);
    git(seed, ["pull", "--ff-only"]);
    const done = finish(seed, gh);
    expect(done.status).not.toBe(0);
    expect(done.out).toContain("already recorded");
  });

  test("what main changed in its state after the merge is kept", () => {
    const { gh, seed } = landedByHandBuiltPr();
    const path = seededStateFile(seed);
    writeFileSync(path, readFileSync(path, "utf-8").replace("- **Review Override**: adversarial", "- **Review Override**: standard"));
    git(seed, ["commit", "-qam", "main changes a setting"]);
    git(seed, ["push", "origin", "main"]);

    const recorded = finish(seed, gh);
    expect(recorded.status, recorded.out).toBe(0);
    const state = git(seed, ["show", `alpha-landing-record:${statePath(seed)}`]);
    expect(state).toContain("- **Review Override**: standard");
    expect(state).toContain("- **Current Stage**: functional-design");
    expect(state).not.toContain("[-] code-generation");
  });

  test("unit land keeps main's state where the Unit's branch walked its own", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-team", { afterClaim: walkTheUnit });
    gateAndLand(seed, "alpha");
    const state = readFileSync(seededStateFile(seed), "utf-8");
    expect(state).toContain("- **Current Stage**: functional-design");
    expect(state).not.toContain("2026-09-02T10:00:00Z");
    expect(state).not.toContain("\n\n\n\n## Current Status");
  });
});
