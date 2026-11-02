// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-unit:finish, subcommand:aidlc-unit:pr, subcommand:aidlc-unit:status, subcommand:aidlc-orchestrate:next
//
// The Unit plan changes in the middle of Construction on a team main whose
// Units land through pull requests (strategy `pr`): main goes back to Units
// Generation, a Unit is added to the Unit DAG, and Units Generation and
// Delivery Planning are approved again. Going back put landed Units back to
// work and made an open claim unable to land. This file checks that (1) a
// Unit landed through its pull requests and closed with `unit finish` stays
// landed after main's first step, (2) a Unit a pull request merged without
// `unit land` stays "landing not recorded" and `unit finish --pr` records it,
// before and after main continues, (3) a claim that was built and published
// before the plan added a Unit lands as it is, with no rebase, and (4) a claim
// whose own Unit entry the plan changes is still sent to rebase first.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { dirname, join } from "node:path";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
  UNIT,
  cleanupTempDirs,
  clone,
  dispatchMerge,
  git,
  nextDirective,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  CODE_GITHUB_REPO,
  CODE_REPO,
  WORKSPACE_GITHUB_REPO,
  checkoutCodeRepo,
  fakeGitHub,
  makePrSeed,
  mergePullRequest,
  pushCodeChange,
  type FakeGitHub,
  type PullRequestRecord,
} from "../harness/team-unit-pr.ts";
import {
  addDoneInception,
  currentStage,
  type PlannedUnit,
  replan,
  stageLine,
  writeUnitPlan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS * 2);
afterEach(cleanupTempDirs);

const windows = process.platform === "win32";
const UTILITY = join(dirname(UNIT), "aidlc-utility.ts");

type Tool = (tool: string, args: string[], cwd: string) => ReturnType<typeof runMergeTool>;

function toolWith(gh: FakeGitHub): Tool {
  return (tool, args, cwd) => runMergeTool(tool, args, cwd, false, gh.env);
}

// The Unit DAG serial alpha -> beta that makePrSeed starts with, and the plan
// that adds gamma after alpha.
const PLAN_WITH_GAMMA: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: [] },
  { name: "beta", depends_on: ["alpha"] },
  { name: "gamma", depends_on: ["alpha"] },
];

const PLAN_BEFORE: PlannedUnit[] = PLAN_WITH_GAMMA.filter((unit) => unit.name !== "gamma");

// The next pull request number the fake gh hands out for a repository.
function nextRef(gh: FakeGitHub, repo: string): string {
  const db = JSON.parse(readFileSync(gh.db, "utf-8")) as Record<string, unknown>;
  return `${repo}#${1 + Object.keys(db).filter((key) => key.startsWith(`${repo}#`)).length}`;
}

// The fixture commits the engine's runtime files (a real project ignores them),
// so a command that rewrites them leaves the checkout dirty for `land`.
function restoreEngineFiles(checkout: string): void {
  for (const path of git(checkout, ["diff", "--name-only"]).split("\n")) {
    if (path.includes("/.aidlc-engine/")) git(checkout, ["checkout", "HEAD", "--", path]);
  }
}

// Main's first step after the plan is approved: `next` runs, and the project
// commits what it wrote and pushes.
function continueOnMain(main: string): void {
  nextDirective(main);
  if (git(main, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    git(main, ["add", "-A"]);
    git(main, ["commit", "-m", "Unit Progress after the revised plan"]);
  }
  git(main, ["push", "origin", "main"]);
}

// A main whose first Bolt was classified (a Skeleton Stance), as Construction
// leaves it: without one `next` asks for that classification before it walks Units.
function seedMain(): ReturnType<typeof makePrSeed> {
  const made = makePrSeed();
  writeUnitPlan(made.seed, PLAN_BEFORE);
  const path = seededStateFile(made.seed);
  writeFileSync(path, readFileSync(path, "utf-8").replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: off\n"));
  addDoneInception(made.seed);
  return made;
}

// The `merged` cell of a Unit's row in the Unit Progress table.
function mergedCell(checkout: string, unit: string): string {
  const cells = unitProgressRow(checkout, unit).split("|").map((cell) => cell.trim());
  return cells[cells.length - 2] ?? "";
}

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

// alpha claimed and built in its own clone, then merged to main by a pull
// request a person built by hand from that clone's branch: main has alpha
// complete, no landing receipt, and alpha's claim still open.
function mergedWithoutLand(gh: FakeGitHub, remote: string): { pr: string; mergeCommit: string; head: string } {
  const pr = `${WORKSPACE_GITHUB_REPO}#1`;
  const built = prepareCandidate(remote, "alpha", "alpha-team", { branch: "alpha-pr" });
  git(built.checkout, ["push", "-u", "origin", "alpha-pr"]);
  const head = git(built.checkout, ["rev-parse", "HEAD"]);
  recordPullRequest(gh, pr, { headRefOid: head, headRefName: "alpha-pr" });
  const mergeCommit = mergePullRequest(gh, remote, "alpha-pr", pr);
  return { pr, mergeCommit, head };
}

// An open claim built and published before the plan changed, as far as the
// pull requests: the code pull request merged, the workspace pull request not opened.
function publishedClaim(run: Tool, gh: FakeGitHub, remote: string, codeRemote: string) {
  const label = "alpha-team";
  const branch = "team/alpha";
  const checkout = clone(remote, label);
  git(checkout, ["config", "fakegh.repo", WORKSPACE_GITHUB_REPO]);
  prepareCandidate(remote, "alpha", label, {
    checkout,
    branch,
    keepRow: true,
    afterClaim: (dir) => mergeCodePullRequest(run, gh, codeRemote, dir, "alpha", branch, label),
  });
  return { checkout, branch };
}

function rebaseOntoMain(checkout: string): void {
  git(checkout, ["fetch", "-q", "origin"]);
  const rebased = Bun.spawnSync(["git", "rebase", "origin/main"], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  expect(rebased.exitCode, rebased.stdout.toString() + rebased.stderr.toString()).toBe(0);
  restoreEngineFiles(checkout);
}

function unitStatus(checkout: string): Record<string, unknown> {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return JSON.parse(status.stdout) as Record<string, unknown>;
}

// pin, the dispatch bracket, the gate and land, in the Unit's own checkout.
function pinGateLand(run: Tool, checkout: string, unit: string, branch: string): void {
  const pin = run(UNIT, ["pin", unit], checkout);
  expect(pin.status, pin.out).toBe(0);
  const pinned = JSON.parse(pin.stdout);
  expect(pinned.dispatch.strategy).toBe("pr");
  dispatchMerge(checkout, unit, pinned.pinned_oid, pinned.generation, { strategy: "pr", target: branch });
  const gate = run(UNIT, ["gate", unit, "--decision", "approve", "--user-input", "Approve the merge"], checkout);
  expect(gate.status, gate.out).toBe(0);
  restoreEngineFiles(checkout);
  const land = run(UNIT, ["land", unit], checkout);
  expect(land.status, land.out).toBe(0);
  expect(JSON.parse(land.stdout)).toMatchObject({ landed: true, status: "complete" });
}

// The code repository's pull request for a Unit, opened and merged first.
function mergeCodePullRequest(
  run: Tool,
  gh: FakeGitHub,
  codeRemote: string,
  checkout: string,
  unit: string,
  branch: string,
  label: string,
): void {
  const codeDir = checkoutCodeRepo(checkout, codeRemote, label, branch);
  pushCodeChange(codeDir, unit);
  const ref = nextRef(gh, CODE_GITHUB_REPO);
  const opened = run(UNIT, ["pr", unit, "--repo", CODE_REPO], checkout);
  expect(opened.status, opened.out).toBe(0);
  mergePullRequest(gh, codeRemote, branch, ref, "reviewer");
}

// A Unit built in a clone of its own, landed on its branch, the workspace pull
// request opened and merged. `finish` is left to the caller.
function landThroughPullRequests(
  run: Tool,
  gh: FakeGitHub,
  remote: string,
  codeRemote: string,
  unit: string,
  label: string,
): { checkout: string; branch: string; workspaceRef: string } {
  // Not the bare Unit name: `git ls-remote <name>` also matches claim/<id>/<name>.
  const branch = `team/${unit}`;
  const checkout = clone(remote, label);
  git(checkout, ["config", "fakegh.repo", WORKSPACE_GITHUB_REPO]);
  prepareCandidate(remote, unit, label, {
    checkout,
    branch,
    keepRow: true,
    afterClaim: (dir) => {
      mergeCodePullRequest(run, gh, codeRemote, dir, unit, branch, label);
    },
  });
  pinGateLand(run, checkout, unit, branch);
  git(checkout, ["push", "-u", "origin", branch]);
  const workspaceRef = nextRef(gh, WORKSPACE_GITHUB_REPO);
  const opened = run(UNIT, ["pr", unit], checkout);
  expect(opened.status, opened.out).toBe(0);
  mergePullRequest(gh, remote, branch, workspaceRef, "reviewer");
  return { checkout, branch, workspaceRef };
}

describe.skipIf(windows)("t-team-unit-replan-pr-strategy: the Unit plan changes on a main whose Units land through pull requests", () => {
  test("a Unit landed through pull requests stays landed after main's first step, and the Units that depend on it stay open", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote } = seedMain();
    const alpha = landThroughPullRequests(run, gh, remote, codeRemote, "alpha", "alpha-team");
    const finished = run(UNIT, ["finish", "alpha"], alpha.checkout);
    expect(finished.status, finished.out).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({ finished: true, verified: true, claim_ref_deleted: true });

    const lead = clone(remote, "lead");
    replan(lead, PLAN_WITH_GAMMA);
    expect(currentStage(lead)).toBe("functional-design");
    expect(stageLine(lead, "units-generation")).toContain("[x]");
    continueOnMain(lead);

    // Landed means landed: the receipt, the merged cell and the status say so.
    const fresh = clone(remote, "after-replan");
    expect(readAllAuditShards(fresh)).toContain("**Event**: UNIT_MERGED");
    expect(mergedCell(fresh, "alpha")).toBe("[x]");
    const status = unitStatus(fresh);
    const open = (list: unknown): string[] =>
      (list as Array<string | { unit: string }>).map((entry) => (typeof entry === "string" ? entry : entry.unit))
        .filter((unit) => unit !== "skeleton");
    expect(open(status.claimable), JSON.stringify(status)).toEqual(["beta", "gamma"]);
    expect(open(status.waiting), JSON.stringify(status)).toEqual([]);
    const again = run(UNIT, ["claim", "alpha", "--team", "second"], fresh);
    expect(again.status, again.out).not.toBe(0);
    expect(again.out).toContain("--reopen");
  });

  test("a Unit added after a landed Unit is claimed, built and landed through pull requests; an untouched Unit still claims", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote } = seedMain();
    const alpha = landThroughPullRequests(run, gh, remote, codeRemote, "alpha", "alpha-team");
    expect(run(UNIT, ["finish", "alpha"], alpha.checkout).status).toBe(0);

    // The revised plan is pushed; the Unit Progress table gets gamma's row from
    // the checkout that works on it, which is where `next` runs for a claimed Unit.
    replan(clone(remote, "lead"), PLAN_WITH_GAMMA);
    const fresh = clone(remote, "after-replan");
    expect(mergedCell(fresh, "alpha")).toBe("[x]");
    expect(JSON.stringify(unitStatus(fresh).claimable)).toContain("gamma");

    const beta = run(UNIT, ["claim", "beta", "--team", "beta-team"], fresh);
    expect(beta.status, beta.out).toBe(0);
    expect(JSON.parse(beta.stdout)).toMatchObject({ claimed: true, unit: "beta" });
    expect(JSON.stringify(unitStatus(clone(remote, "watcher")).claimed)).toContain("beta");

    const gamma = landThroughPullRequests(run, gh, remote, codeRemote, "gamma", "gamma-team");
    const closed = run(UNIT, ["finish", "gamma"], gamma.checkout);
    expect(closed.status, closed.out).toBe(0);
    expect(JSON.parse(closed.stdout)).toMatchObject({ finished: true, verified: true, claim_ref_deleted: true });
    expect(git(gamma.checkout, ["branch", "--show-current"])).toBe("main");
    expect(mergedCell(gamma.checkout, "gamma")).toBe("[x]");
    expect(mergedCell(gamma.checkout, "alpha")).toBe("[x]");
    const audit = readAllAuditShards(gamma.checkout);
    expect(audit.match(/\*\*Event\*\*: UNIT_MERGED/g)?.length).toBe(2); // alpha and gamma; the skeleton was built on main
    const after = unitStatus(gamma.checkout);
    expect(JSON.stringify(after.claimable ?? [])).not.toContain("gamma");
    expect(JSON.stringify(after.claimed)).toContain("beta");
  });

  test("a Unit merged by a pull request without unit land stays \"landing not recorded\" on the board and the status after main's first step", () => {
    const gh = fakeGitHub();
    const { remote } = seedMain();
    mergedWithoutLand(gh, remote);
    const lead = clone(remote, "lead");
    replan(lead, PLAN_WITH_GAMMA);
    expect(currentStage(lead)).toBe("functional-design");

    // main stays usable...
    continueOnMain(lead);
    // ...and still says the one step that records alpha's landing.
    const status = unitStatus(lead);
    expect(status.landingNotRecorded, JSON.stringify(status)).toEqual([{ unit: "alpha", owner: expect.any(String), generation: 1 }]);
    expect(JSON.stringify(status.claimed), JSON.stringify(status)).not.toContain("alpha");
    const board = runMergeTool(ORCH, ["team-board", "--snapshot"], lead);
    expect(board.status, board.out).toBe(0);
    expect(board.stdout, board.out).toContain("aidlc unit finish alpha --pr");
    const shown = runMergeTool(UTILITY, ["status"], lead);
    expect(shown.stdout, shown.out).toContain("aidlc unit finish alpha --pr");
    expect(shown.stdout, shown.out).not.toContain("in progress: claimed by alpha-team");
  });

  for (const continued of [false, true]) {
    test(`finish --pr records the landing of a Unit merged without unit land ${continued ? "after" : "before"} main continues, and the Unit the new plan adds becomes claimable`, () => {
      const gh = fakeGitHub();
      const run = toolWith(gh);
      const { remote } = seedMain();
      const { pr, mergeCommit } = mergedWithoutLand(gh, remote);
      const lead = clone(remote, "lead");
      replan(lead, PLAN_WITH_GAMMA);
      if (continued) continueOnMain(lead);

      const recorded = run(UNIT, ["finish", "alpha", "--pr", pr], lead);
      expect(recorded.status, recorded.out).toBe(0);
      expect(JSON.parse(recorded.stdout)).toMatchObject({
        recorded: true,
        unit: "alpha",
        generation: 1,
        merge_commit: mergeCommit,
        receipt_branch: "alpha-landing-record",
      });
      expect(git(lead, ["branch", "--show-current"])).toBe("main");
      const receipt = git(lead, ["show", "alpha-landing-record"]);
      expect(receipt).toContain("**Event**: UNIT_MERGED");
      expect(receipt).toContain(`**Merge commit OID**: ${mergeCommit}`);
      // The receipt branch is cut from main as it is now, the replan commit included.
      expect(git(lead, ["rev-parse", "alpha-landing-record~1"])).toBe(git(lead, ["rev-parse", "origin/main"]));

      // The project merges the receipt: alpha reads as landed, gamma can be claimed.
      git(lead, ["push", "origin", "alpha-landing-record:main"]);
      git(lead, ["pull", "--ff-only"]);
      const landed = unitStatus(lead);
      expect(landed.landingNotRecorded ?? [], JSON.stringify(landed)).toEqual([]);
      expect(JSON.stringify(landed.claimed)).not.toContain("alpha");
      expect(JSON.stringify(landed.claimable), JSON.stringify(landed)).toContain("gamma");
      const gamma = run(UNIT, ["claim", "gamma", "--team", "gamma-team"], clone(remote, "gamma-claim"));
      expect(gamma.status, gamma.out).toBe(0);
      const shown = runMergeTool(UTILITY, ["status"], lead);
      expect(shown.status, shown.out).toBe(0);
      expect(shown.stdout).not.toContain("landing not recorded");
    });
  }

  test("a claim open when a Unit is added lands through its pull requests: pin finds it current, only the branch catches up with main", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote } = seedMain();
    const { checkout, branch } = publishedClaim(run, gh, remote, codeRemote);

    const lead = clone(remote, "lead");
    replan(lead, PLAN_WITH_GAMMA);
    continueOnMain(lead);

    // gamma is another Unit's entry: alpha's work is not stale, and its receipts
    // and documents stay as they are. Landing through a pull request still wants
    // the branch to contain main, so it catches up and publishes the new tip.
    rebaseOntoMain(checkout);
    const republished = run(UNIT, ["publish", "alpha"], checkout);
    expect(republished.status, republished.out).toBe(0);
    pinGateLand(run, checkout, "alpha", branch);
    git(checkout, ["push", "-u", "origin", branch]);
    const workspaceRef = nextRef(gh, WORKSPACE_GITHUB_REPO);
    const opened = run(UNIT, ["pr", "alpha"], checkout);
    expect(opened.status, opened.out).toBe(0);
    mergePullRequest(gh, remote, branch, workspaceRef, "reviewer");
    const finished = run(UNIT, ["finish", "alpha"], checkout);
    expect(finished.status, finished.out).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({ finished: true, verified: true, claim_ref_deleted: true });
    expect(mergedCell(checkout, "alpha")).toBe("[x]");
    expect(mergedCell(checkout, "gamma")).not.toBe("[x]");
    expect(JSON.stringify(unitStatus(checkout).claimable)).toContain("gamma");
  });

  test("a claim whose own entry the plan changes is refused as stale by pin until it rebases onto main and publishes again", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote } = seedMain();
    const { checkout, branch } = publishedClaim(run, gh, remote, codeRemote);

    const lead = clone(remote, "lead");
    replan(lead, PLAN_WITH_GAMMA.map((unit) => (unit.name === "alpha" ? { ...unit, depends_on: ["skeleton"] } : unit)));
    continueOnMain(lead);

    const stale = run(UNIT, ["pin", "alpha"], checkout);
    expect(stale.status, stale.out).not.toBe(0);
    expect(stale.out).toContain("stale Construction contract");
    expect(stale.out).toContain("rebase onto the current integration branch and publish again");

    rebaseOntoMain(checkout);
    const republished = run(UNIT, ["publish", "alpha"], checkout);
    expect(republished.status, republished.out).toBe(0);
    pinGateLand(run, checkout, "alpha", branch);
  });
});
