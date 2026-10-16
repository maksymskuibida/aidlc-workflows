// covers: file:tools/aidlc-unit.ts, file:tools/aidlc-state.ts, file:tools/aidlc-bolt.ts
//
// Team-owned Units land through pull requests, across repositories (strategy
// `pr`): a Unit's code merges through its code repository's pull request, the
// Unit is pinned, gated and landed in the checkout that built it, its record
// rides one workspace pull request, and `finish` closes that checkout once the
// pull request merged. `aidlc unit pr` opens the pull requests from the
// repository's own template; `gate` reads the code pull requests it recorded.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  readAllAuditShards,
  readUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
  STATE,
  UNIT,
  cleanupTempDirs,
  clone,
  dispatchMerge,
  git,
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
  pullRequest,
  pushCodeChange,
  type FakeGitHub,
} from "../harness/team-unit-pr.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const windows = process.platform === "win32";

type Tool = (tool: string, args: string[], cwd: string) => ReturnType<typeof runMergeTool>;

function toolWith(gh: FakeGitHub): Tool {
  return (tool, args, cwd) => runMergeTool(tool, args, cwd, false, gh.env);
}

function nameWorkspaceForGitHub(checkout: string): void {
  git(checkout, ["config", "fakegh.repo", WORKSPACE_GITHUB_REPO]);
}

// pin and the dispatch bracket it prints (strategy pr), gate from the recorded code pull
// requests, land: all in the Unit's own checkout, on the Unit's branch.
function pinGateLand(run: Tool, checkout: string, unit: string, branch: string): void {
  const pin = run(UNIT, ["pin", unit], checkout);
  expect(pin.status, pin.out).toBe(0);
  const pinned = JSON.parse(pin.stdout);
  // Pin prints the dispatch bracket with its values filled in: the Unit's own
  // checkout lands through pull requests on its branch.
  const pinValues = `--slug ${unit} --pinned-oid ${pinned.pinned_oid} --attempt-generation ${pinned.generation} --pin-id ${pinned.pin_id}`;
  expect(pinned.dispatch.strategy).toBe("pr");
  expect(pinned.dispatch.invoked).toBe(
    `aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED ${pinValues} --practices-excerpt '<the team practice on landing>'`,
  );
  expect(pinned.dispatch.returned).toBe(
    `aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED ${pinValues} --strategy pr --target ${branch} --confidence <0-1> --notes '<one line>'`,
  );
  const returned = dispatchMerge(checkout, unit, pinned.pinned_oid, pinned.generation, { strategy: "pr", target: branch });
  // The merge gate is the person's question about the workspace pull request,
  // worded by the engine: approving lands the Unit on its branch and opens it.
  expect(returned.merge_gate).toMatchObject({
    question: `Open the workspace pull request that lands ${unit}?`,
    options: [{ label: "Approve" }, { label: "Reject" }],
  });
  expect((returned.merge_gate as { context: string }).context).toMatch(new RegExp(`^${unit} is ready to land: all \\d+ stages are approved`));
  expect((returned.merge_gate as { options: Array<{ description: string }> }).options[0].description)
    .toContain("Nothing reaches main until you merge it.");
  const gate = run(UNIT, ["gate", unit, "--decision", "approve", "--user-input", "Approve the merge"], checkout);
  expect(gate.status, gate.out).toBe(0);
  const land = run(UNIT, ["land", unit], checkout);
  expect(land.status, land.out).toBe(0);
  expect(JSON.parse(land.stdout)).toMatchObject({ landed: true, status: "complete" });
  // The workspace pull request carries main's state with the fold, none of the
  // Unit's own walk: the branch's Current Stage and revision count are main's.
  git(checkout, ["fetch", "-q", "origin"]);
  const statePath = relative(checkout, seededStateFile(checkout)).replaceAll("\\", "/");
  const walkFields = (text: string): string[] =>
    text.split("\n").filter((line) => /^- \*\*(Current Stage|Revision Count|Status)\*\*:/.test(line));
  const landed = walkFields(readFileSync(seededStateFile(checkout), "utf-8"));
  expect(landed).toHaveLength(3);
  expect(landed).toEqual(walkFields(git(checkout, ["show", `origin/main:${statePath}`])));
}

// The Unit's own walk on its branch, as the stages leave it in the state file.
function walkUnitState(checkout: string): void {
  const state = readFileSync(seededStateFile(checkout), "utf-8");
  const walked = state
    .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
    .replace("- **Revision Count**: 0", "- **Revision Count**: 9");
  expect(walked).not.toBe(state);
  writeFileSync(seededStateFile(checkout), walked);
}

describe.skipIf(windows)("t329 team-owned Units land through pull requests", () => {
  test("team ownership is allowed for an intent that records repositories", () => {
    const { seed } = makePrSeed();
    writeFileSync(
      seededStateFile(seed),
      readFileSync(seededStateFile(seed), "utf-8").replace(
        "- **Unit Ownership**: team",
        "- **Unit Ownership**: solo",
      ),
    );
    const set = runMergeTool(STATE, ["set-unit-ownership", "team"], seed);
    expect(set.status, set.out).toBe(0);
    expect(readFileSync(seededStateFile(seed), "utf-8")).toContain("- **Unit Ownership**: team");
  });

  test("a Unit lands through its code and workspace pull requests, and finish closes the main checkout", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote, unit } = makePrSeed({ unit: "DEMO-7-alpha" });
    const branch = "DEMO-7/alpha";
    const label = "alpha-team";
    const checkout = clone(remote, label);
    nameWorkspaceForGitHub(checkout);
    const record = seededRecordDir(checkout);
    let codeDir = "";

    // Build: claim, the Unit's branch, the code change and its pull request
    // (reviewed and merged first), then the record and the candidate.
    const candidate = prepareCandidate(remote, unit, label, {
      checkout,
      branch,
      keepRow: true,
      afterClaim: (dir) => {
        walkUnitState(dir);
        codeDir = checkoutCodeRepo(dir, codeRemote, label, branch);
        // A pull request before the branch is pushed is refused.
        const unpushed = run(UNIT, ["pr", unit, "--repo", CODE_REPO], dir);
        expect(unpushed.status).not.toBe(0);
        expect(unpushed.out).toContain("not pushed");
        const codeHead = pushCodeChange(codeDir, unit);
        const opened = run(UNIT, ["pr", unit, "--repo", CODE_REPO], dir);
        expect(opened.status, opened.out).toBe(0);
        expect(JSON.parse(opened.stdout)).toMatchObject({
          opened: true,
          ref: `${CODE_GITHUB_REPO}#1`,
          repo: CODE_REPO,
          branch,
          head: codeHead,
          title: "[DEMO-7] Alpha service",
        });
        const pr = pullRequest(gh, `${CODE_GITHUB_REPO}#1`);
        expect(pr.title).toBe("[DEMO-7] Alpha service");
        expect(pr.baseRefName).toBe("main");
        expect(pr.headRefName).toBe(branch);
        // The repository's own template, its ticket line filled, its headings kept.
        expect(pr.body.startsWith("Ticket: DEMO-7\n")).toBe(true);
        expect(pr.body).toContain("## Tests");
        expect(pr.body).toContain("## AI-DLC Unit");
        expect(pr.body).toContain(`\`${unit}\``);
        // Opening it again recovers the record instead of a second pull request.
        const again = run(UNIT, ["pr", unit, "--repo", CODE_REPO], dir);
        expect(JSON.parse(again.stdout)).toMatchObject({ opened: true, recovered: true, ref: `${CODE_GITHUB_REPO}#1` });
        // The workspace pull request waits for land.
        const early = run(UNIT, ["pr", unit], dir);
        expect(early.status).not.toBe(0);
        expect(early.out).toContain("has not landed");
        mergePullRequest(gh, codeRemote, branch, `${CODE_GITHUB_REPO}#1`, "reviewer");
      },
    });
    expect(candidate.checkout).toBe(checkout);

    // Close: pin, bracket, gate (the code pull request from the record), land.
    pinGateLand(run, checkout, unit, branch);
    const journal = readUnitMergeTransaction(checkout, unit);
    expect(journal).toMatchObject({ status: "complete", strategy: "pr", target_branch: branch });
    expect(journal?.landed_head_oid).toBe(git(checkout, ["rev-parse", "HEAD"]));
    expect(journal?.pull_requests?.map((pr) => [pr.ref, pr.approvers])).toEqual([[`${CODE_GITHUB_REPO}#1`, ["reviewer"]]]);
    const audit = readAllAuditShards(checkout);
    expect(audit).toContain(`**Pull requests**: https://github.com/${CODE_GITHUB_REPO}/pull/1`);
    expect(audit).toContain("**Approved by**: reviewer");
    expect(audit).toContain("**Event**: UNIT_MERGED");
    expect(unitProgressRow(checkout, unit)).toBe(`| ${unit} | ${label} | [x] | [x] | [x] | [x] | [x] | [x] | [x] |`);
    expect(git(checkout, ["branch", "--show-current"])).toBe(branch);
    expect(git(checkout, ["log", "-1", "--format=%s"])).toBe(`Finalize Unit ${unit} merge metadata`);

    // One workspace pull request carries the record and the fold.
    git(checkout, ["push", "-u", "origin", branch]);
    const opened = run(UNIT, ["pr", unit], checkout);
    expect(opened.status, opened.out).toBe(0);
    expect(JSON.parse(opened.stdout)).toMatchObject({ opened: true, ref: `${WORKSPACE_GITHUB_REPO}#1`, title: "[DEMO-7] Alpha service" });
    const workspacePr = pullRequest(gh, `${WORKSPACE_GITHUB_REPO}#1`);
    expect(workspacePr.body.startsWith("Ticket: DEMO-7\n")).toBe(true);
    expect(workspacePr.body).toContain("## Context updates");
    expect(workspacePr.body).toContain(`https://github.com/${CODE_GITHUB_REPO}/pull/1`);

    // Until it merges: the checkout is still alpha's, and finish waits.
    const earlyClaim = run(UNIT, ["claim", "beta", "--team", label], checkout);
    expect(earlyClaim.status).not.toBe(0);
    expect(earlyClaim.out).toContain("already scoped to Unit");
    const earlyFinish = run(UNIT, ["finish", unit], checkout);
    expect(earlyFinish.status).not.toBe(0);
    expect(earlyFinish.out).toContain("is not merged");

    const mergeCommit = mergePullRequest(gh, remote, branch, `${WORKSPACE_GITHUB_REPO}#1`, "reviewer");

    // Merged: a claim says what to do; finish verifies and closes the checkout.
    const lateClaim = run(UNIT, ["claim", "beta", "--team", label], checkout);
    expect(lateClaim.status).not.toBe(0);
    expect(lateClaim.out).toContain(`run \`aidlc unit finish ${unit}\``);
    const finish = run(UNIT, ["finish", unit], checkout);
    expect(finish.status, finish.out).toBe(0);
    const finished = JSON.parse(finish.stdout);
    expect(finished).toMatchObject({
      finished: true,
      verified: true,
      checkout: "main",
      merge_commit: mergeCommit,
      drift: [],
      follow_up: null,
      notes: [],
    });
    expect(finished.updated).toEqual([
      expect.stringMatching(/^workspace on main at /),
      expect.stringMatching(/^svc on main at /),
    ]);
    // The claim ref is gone from the remote; the merged pull request is the record.
    expect(finished.claim_ref_deleted).toBe(true);
    expect(git(checkout, ["ls-remote", "--heads", "origin", `refs/heads/claim/*/${unit}`])).toBe("");
    expect(existsSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"))).toBe(false);
    expect(readUnitMergeTransaction(checkout, unit)).toMatchObject({ status: "finished", merge_commit_oid: mergeCommit });
    expect(git(checkout, ["branch", "--show-current"])).toBe("main");
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(mergeCommit);
    expect(git(codeDir, ["branch", "--show-current"])).toBe("main");
    expect(git(codeDir, ["rev-parse", "HEAD"])).toBe(git(codeDir, ["rev-parse", "origin/main"]));
    expect(unitProgressRow(checkout, unit)).toBe(`| ${unit} | ${label} | [x] | [x] | [x] | [x] | [x] | [x] | [x] |`);
    // A repeat is the same answer; the board no longer waits for the Unit.
    expect(JSON.parse(run(UNIT, ["finish", unit], checkout).stdout)).toMatchObject({ finished: true, verified: true });
    const board = run(ORCH, ["team-board", "--snapshot"], checkout);
    expect(board.status, board.out).toBe(0);
    expect(board.stdout).not.toContain(`| ${unit} | finished |`);
    expect(board.stdout).not.toContain(`| ${unit} | complete |`);

    // The same checkout claims the next Unit.
    const beta = run(UNIT, ["claim", "beta", "--team", label], checkout);
    expect(beta.status, beta.out).toBe(0);

    // Its claim released from elsewhere: finish ends the scope without
    // anything to verify.
    const other = clone(remote, "lead");
    const released = run(UNIT, ["release", "beta"], other);
    expect(released.status, released.out).toBe(0);
    const unverified = run(UNIT, ["finish", "beta"], checkout);
    expect(unverified.status, unverified.out).toBe(0);
    expect(JSON.parse(unverified.stdout)).toMatchObject({ finished: true, verified: false, checkout: "main" });
    expect(JSON.parse(unverified.stdout).reason).toContain("released or superseded");
    // Nothing of someone else's is touched: the released claim ref stays.
    expect(git(checkout, ["ls-remote", "--heads", "origin", "refs/heads/claim/*/beta"])).not.toBe("");
    expect(existsSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"))).toBe(false);
    expect(run(UNIT, ["finish", "beta"], checkout).out).toContain("nothing to finish");
    expect(existsSync(join(record, "construction", unit))).toBe(true);
  });

  test("an unreviewed code pull request gates unless the project requires approval", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote, unit } = makePrSeed();
    const label = "solo-team";
    const branch = "alpha";
    const checkout = clone(remote, label);
    nameWorkspaceForGitHub(checkout);
    prepareCandidate(remote, unit, label, {
      checkout,
      branch,
      keepRow: true,
      afterClaim: (dir) => {
        const codeDir = checkoutCodeRepo(dir, codeRemote, label, branch);
        pushCodeChange(codeDir, unit);
        expect(run(UNIT, ["pr", unit, "--repo", CODE_REPO], dir).status).toBe(0);
        // Merged by its author through a bypass: nobody approved it.
        mergePullRequest(gh, codeRemote, branch, `${CODE_GITHUB_REPO}#1`);
      },
    });
    const pin = run(UNIT, ["pin", unit], checkout);
    expect(pin.status, pin.out).toBe(0);
    const pinned = JSON.parse(pin.stdout);
    dispatchMerge(checkout, unit, pinned.pinned_oid, pinned.generation, { strategy: "pr", target: branch });
    // The project asks for approvals: refused, and the row says where that is set.
    const strict = runMergeTool(
      UNIT,
      ["gate", unit, "--decision", "approve", "--user-input", "Approve the merge"],
      checkout,
      false,
      { ...gh.env, AIDLC_PR_REQUIRE_APPROVAL: "1" },
    );
    expect(strict.status).not.toBe(0);
    expect(strict.out).toContain("is not approved");
    expect(strict.out).toContain("--pull-request-approval");
    // By default a merged pull request is enough; the gate row records no approver.
    const gate = run(UNIT, ["gate", unit, "--decision", "approve", "--user-input", "Approve the merge"], checkout);
    expect(gate.status, gate.out).toBe(0);
    expect(readAllAuditShards(checkout)).toContain("**Approved by**: none");
    expect(readUnitMergeTransaction(checkout, unit)?.pull_requests?.[0]?.approvers).toEqual([]);
  });

  test("pull requests come from the repository's own template or not at all", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote, unit } = makePrSeed({ codeTemplate: false });
    const checkout = clone(remote, "plain-team");
    nameWorkspaceForGitHub(checkout);
    const claim = run(UNIT, ["claim", unit, "--team", "plain-team"], checkout);
    expect(claim.status, claim.out).toBe(0);
    git(checkout, ["switch", "-c", "alpha"]);
    const codeDir = checkoutCodeRepo(checkout, codeRemote, "plain-team", "alpha");
    pushCodeChange(codeDir, unit);
    const refused = run(UNIT, ["pr", unit, "--repo", CODE_REPO], checkout);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("no pull request template");
    expect(Object.keys(JSON.parse(readFileSync(gh.db, "utf-8")))).toEqual([]);
    // A Unit without a ticket key gets no prefix; the title is the plan's name.
    mkdirSync(join(codeDir, ".github"));
    writeFileSync(join(codeDir, ".github", "pull_request_template.md"), "## What\n");
    git(codeDir, ["add", "-A"]);
    git(codeDir, ["commit", "-m", "template"]);
    git(codeDir, ["push"]);
    const opened = run(UNIT, ["pr", unit, "--repo", CODE_REPO], checkout);
    expect(opened.status, opened.out).toBe(0);
    expect(JSON.parse(opened.stdout).title).toBe("Alpha service");
    expect(pullRequest(gh, `${CODE_GITHUB_REPO}#1`).body.startsWith("## What\n")).toBe(true);
  });

  test("content merged after land is refused until a person accepts it; a worktree is handed its cleanup", () => {
    const gh = fakeGitHub();
    const run = toolWith(gh);
    const { remote, codeRemote, unit } = makePrSeed();
    const label = "wt-team";
    const branch = "alpha";
    const main = clone(remote, label);
    nameWorkspaceForGitHub(main);
    const mainCode = checkoutCodeRepo(main, codeRemote, label);
    const worktree = `${main}-wt`;
    git(main, ["worktree", "add", worktree, "-b", branch, "origin/main"]);
    git(mainCode, ["worktree", "add", join(worktree, CODE_REPO), "-b", branch, "origin/main"]);
    const codeDir = join(worktree, CODE_REPO);

    prepareCandidate(remote, unit, label, {
      checkout: worktree,
      keepRow: true,
      afterClaim: (dir) => {
        pushCodeChange(codeDir, unit);
        const opened = run(UNIT, ["pr", unit, "--repo", CODE_REPO], dir);
        expect(opened.status, opened.out).toBe(0);
        mergePullRequest(gh, codeRemote, branch, `${CODE_GITHUB_REPO}#1`, "reviewer");
      },
    });
    pinGateLand(run, worktree, unit, branch);
    const landedHead = git(worktree, ["rev-parse", "HEAD"]);
    git(worktree, ["push", "-u", "origin", branch]);
    const opened = run(UNIT, ["pr", unit], worktree);
    expect(opened.status, opened.out).toBe(0);

    // A review fix pushed after land: the pull request merges content land
    // never saw.
    const plan = join(seededRecordDir(worktree), "construction", unit, "code-generation", "code-generation-plan.md");
    writeFileSync(plan, `${readFileSync(plan, "utf-8")}\n- [ ] Review fix.\n`);
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "review fix"]);
    git(worktree, ["push"]);
    const mergeCommit = mergePullRequest(gh, remote, branch, `${WORKSPACE_GITHUB_REPO}#1`, "reviewer");
    const planPath = plan.slice(worktree.length + 1);

    const refused = run(UNIT, ["finish", unit], worktree);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("merged content that was not landed");
    expect(refused.out).toContain(planPath);
    expect(refused.out).toContain(`git diff ${landedHead} ${mergeCommit}`);
    expect(existsSync(join(worktree, "aidlc", ".aidlc-unit-scope.json"))).toBe(true);
    const noInput = run(UNIT, ["finish", unit, "--accept-merged-drift"], worktree);
    expect(noInput.status).not.toBe(0);
    expect(noInput.out).toContain("requires --user-input");

    const accepted = run(
      UNIT,
      ["finish", unit, "--accept-merged-drift", "--user-input", "I compared the review fix with the landed head and accept it"],
      worktree,
    );
    expect(accepted.status, accepted.out).toBe(0);
    const result = JSON.parse(accepted.stdout);
    expect(result).toMatchObject({
      finished: true,
      verified: true,
      checkout: "worktree",
      drift: [planPath],
      follow_up: `https://github.com/${WORKSPACE_GITHUB_REPO}/pull/2`,
      claim_ref_deleted: true,
    });
    expect(git(worktree, ["ls-remote", "--heads", "origin", `refs/heads/claim/*/${unit}`])).toBe("");
    // The acknowledgment is an audit row on a record-only follow-up pull
    // request, cut from the integration tip.
    const followUp = pullRequest(gh, `${WORKSPACE_GITHUB_REPO}#2`);
    expect(followUp.headRefName).toBe(`${branch}-merge-drift`);
    expect(followUp.title).toBe("Alpha service: merge drift acknowledgment");
    expect(followUp.body).toContain("Record-only");
    expect(git(worktree, ["branch", "--show-current"])).toBe(`${branch}-merge-drift`);
    expect(git(worktree, ["rev-parse", "HEAD^"])).toBe(mergeCommit);
    expect(git(worktree, ["diff", "--name-only", "HEAD^", "HEAD"]).split("\n")).toEqual([
      expect.stringMatching(/\/audit\/[^/]+\.md$/),
    ]);
    const row = readAllAuditShards(worktree);
    expect(row).toContain("**Event**: UNIT_MERGE_DRIFT_ACCEPTED");
    expect(row).toContain(`**Paths**: ${planPath}`);
    expect(row).toContain(`**Landed head OID**: ${landedHead}`);
    expect(readUnitMergeTransaction(worktree, unit)).toMatchObject({ status: "finished", merge_drift: [planPath] });
    expect(existsSync(join(worktree, "aidlc", ".aidlc-unit-scope.json"))).toBe(false);
    // Nothing moved: a worktree cannot delete the branches it has checked out.
    expect(git(main, ["branch", "--show-current"])).toBe("main");
    const cleanup = result.cleanup_command as string;
    const steps = cleanup.split(" && ");
    const [realMain, realCode, realWorktree, realCodeWorktree] = [main, mainCode, worktree, codeDir].map((dir) => realpathSync(dir));
    expect(steps).toEqual([
      `git -C ${realCode} worktree remove --force ${realCodeWorktree}`,
      `git -C ${realCode} branch -D ${branch}`,
      `git -C ${realMain} worktree remove --force ${realWorktree}`,
      `git -C ${realMain} branch -D ${branch}`,
      `git -C ${realMain} branch -D ${branch}-merge-drift`,
    ]);
    // A repeat finish is the same answer, then the command does what it says.
    expect(JSON.parse(run(UNIT, ["finish", unit], worktree).stdout)).toMatchObject({ finished: true, checkout: "worktree" });
    const ran = Bun.spawnSync(["sh", "-c", cleanup], { stdout: "pipe", stderr: "pipe" });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(git(main, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(git(mainCode, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(git(main, ["branch", "--list", branch, `${branch}-merge-drift`])).toBe("");
  });
});
