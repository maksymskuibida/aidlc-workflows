// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:claim
//
// A checkout that ran the earlier phases has its own audit shard on main, so a
// Unit claimed there keeps its rows in a team shard of its attempt
// (`<clone shard>-<unit>-g<N>.md`). The checkout's rows outside that shard
// still reach the branch: the landed attempt's session goes on after its
// candidate (its pull request's head), into that attempt's team shard; while
// no Unit is claimed, the checkout writes its own shard. Both shards are on
// main, and a published Unit may add only its own. Reopened as the next
// attempt, the Unit's publish refused with "cannot move its audit rows: ...
// already exists on this branch": it moved only the clone shard's rows, and
// only into a team shard that did not exist yet.
//
// Publish now moves every row the branch added to this clone's shard and to
// this Unit's earlier attempts' team shards into the attempt's team shard, in
// the order the audit reader reads them, and puts each of those shards back as
// main has them, in one commit. The moved rows are not this attempt's (no Unit,
// or an earlier attempt), so pin counts none of them. Rows the branch added to
// a shard main holds for another clone or Unit are not this Unit's to carry:
// publish refuses and says how to put that shard back.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { auditShardName } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir, seededRecordDir } from "../harness/fixtures.ts";
import {
  auditBlock,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
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

const AUDIT = join(dirname(UNIT), "aidlc-audit.ts");
const WHY = "the reviewer asked for a smaller API";
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

// A row the engine writes in whichever shard the checkout writes now, as a
// guard writes it (the audit CLI takes a guard's row only with the test switch).
function logRow(checkout: string, reason: string): void {
  const logged = runMergeTool(
    AUDIT, ["append", "GUARD_STOOD_ASIDE", "--field", `Reason=${reason}`], checkout, false,
    { AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" },
  );
  expect(logged.status, logged.out).toBe(0);
}

const now = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// A row as a hook writes it, which the public audit CLI does not take.
function hookRow(checkout: string, shard: string, event: string, fields = ""): void {
  appendFileSync(
    join(seededAuditDir(checkout), shard),
    `\n## ${event}\n**Timestamp**: ${now()}\n**Event**: ${event}\n${fields}\n---\n`,
  );
}

function shardText(checkout: string, oid: string, shard: string): string {
  const path = `${seededRecordDir(checkout).slice(checkout.length + 1).replaceAll("\\", "/")}/audit/${shard}`;
  return git(checkout, ["show", `${oid}:${path}`]);
}

function blocks(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(/\n---\n/).filter((block) => /\*\*Timestamp\*\*:/.test(block));
}

// A row's text, whichever shard holds it and wherever in it (`git` trims the
// last separator off a shown file).
const rowText = (block: string): string => block.replace(/^# AI-DLC Audit Log\n/, "").replace(/\n*---\s*$/, "").trim();

const stamp = (block: string): string => /\*\*Timestamp\*\*: (\S+)/.exec(block)?.[1] ?? "";

// The order the audit reader reads rows across shards: time, then shard name,
// then position in the shard.
function readerOrder(shards: Array<[string, string]>): string[] {
  return shards
    .flatMap(([name, text]) => blocks(text).map((block, pos) => ({ name, block, pos })))
    .sort((a, b) =>
      stamp(a.block) !== stamp(b.block) ? (stamp(a.block) < stamp(b.block) ? -1 : 1)
        : a.name !== b.name ? (a.name < b.name ? -1 : 1)
        : a.pos - b.pos
    )
    .map((row) => rowText(row.block));
}

// alpha is built in the checkout that ran the earlier phases, merged by a pull
// request built by hand, and its landing recorded. Its session goes on into
// attempt 1's shard after the pull request's head; then the checkout leaves the
// Unit and writes its own shard; main is brought into the branch, and what the
// checkout wrote is committed. Then alpha is reopened there as attempt 2.
function reopenedInTheSameCheckout(options: { ungated?: string[]; tail?: (checkout: string, g1: string, own: string) => void } = {}) {
  const gh = fakeGitHub();
  const { seed, remote } = makeSeed(parallelDependencyBody());
  const checkout = clone(remote, "alpha-team");
  logRow(checkout, "the earlier phases ran here");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", "the earlier phases' record"]);
  git(checkout, ["push", "origin", "main"]);
  const own = auditShardName(checkout);

  const first = prepareCandidate(remote, "alpha", "alpha-team", { checkout, branch: "alpha-pr" });
  const g1 = first.auditShard;
  expect(g1).toBe(own.replace(/\.md$/, "-alpha-g1.md"));
  git(checkout, ["push", "-u", "origin", "alpha-pr"]);
  recordPullRequest(gh, PR, { headRefOid: git(checkout, ["rev-parse", "HEAD"]), headRefName: "alpha-pr" });
  logRow(checkout, "after the pull request's head");
  hookRow(checkout, g1, "HUMAN_TURN", "**Origin**: person\n**Source**: typed\n");
  mergePullRequest(gh, remote, "alpha-pr", PR);
  git(seed, ["pull", "--ff-only"]);
  const recorded = runMergeTool(UNIT, ["finish", "alpha", "--pr", PR], seed, false, gh.env);
  expect(recorded.status, recorded.out).toBe(0);
  git(seed, ["push", "origin", "alpha-landing-record:main"]);
  git(seed, ["pull", "--ff-only"]);

  // The checkout leaves the Unit; its rows go to its own shard again.
  rmSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"));
  logRow(checkout, "no Unit is claimed here");
  hookRow(checkout, own, "HUMAN_TURN", "**Origin**: person\n**Source**: typed\n");
  options.tail?.(checkout, g1, own);
  git(checkout, ["fetch", "origin"]);
  git(checkout, ["merge", "--no-edit", "origin/main"]);
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", "audit shard"]);

  const second = prepareCandidate(remote, "alpha", "alpha-team", {
    checkout,
    claimArgs: ["--reopen", "--user-input", WHY],
    publish: false,
    ungated: options.ungated,
  });
  expect(second.generation).toBe(2);
  const g2 = second.auditShard;
  expect(g2).toBe(own.replace(/\.md$/, "-alpha-g2.md"));
  return { seed, remote, checkout, own, g1, g2 };
}

describe("t-team-unit-reopen-audit-rows: a reopened Unit's publish carries the checkout's rows in its team shard", () => {
  test("rows added to the clone's shard and to the landed attempt's shard move to the new attempt's, and pin takes it", () => {
    const { seed, checkout, own, g1, g2 } = reopenedInTheSameCheckout();
    const before = git(checkout, ["rev-parse", "HEAD"]);
    const appended = (shard: string): string =>
      shardText(checkout, before, shard).slice(shardText(checkout, "origin/main", shard).length);
    const expected = readerOrder([[g1, appended(g1)], [g2, shardText(checkout, before, g2)], [own, appended(own)]]);

    const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(published.status, published.out).toBe(0);
    const head = git(checkout, ["rev-parse", "HEAD"]);
    expect(git(checkout, ["rev-parse", "HEAD~1"])).toBe(before);
    // Both shards are as main has them; the new attempt's holds every row,
    // in the order the reader read them across the three.
    for (const shard of [own, g1]) {
      expect(shardText(checkout, head, shard)).toBe(shardText(checkout, "origin/main", shard));
    }
    const moved = shardText(checkout, head, g2);
    expect(blocks(moved).map(rowText)).toEqual(expected);
    expect(moved).toContain("after the pull request's head");
    expect(moved).toContain("no Unit is claimed here");
    expect(moved.startsWith("# AI-DLC Audit Log\n")).toBe(true);
    // The candidate leaves them out: none is this attempt's evidence.
    expect(JSON.parse(published.stdout).local_rows_withheld).toBeGreaterThanOrEqual(4);
    // Publishing again moves nothing more.
    const again = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(again.status, again.out).toBe(0);
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(head);

    git(seed, ["fetch", "origin"]);
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toContain("alpha-team");
    expect(existsSync(join(seededAuditDir(seed), g2))).toBe(true);
  });

  test("an earlier attempt's gate and a gate row with no Unit, moved with the rest, approve nothing for this attempt", () => {
    const { seed, checkout, g2 } = reopenedInTheSameCheckout({
      ungated: ["code-generation"],
      tail: (checkout, g1, own) => {
        appendFileSync(
          join(seededAuditDir(checkout), g1),
          `\n${auditBlock("GATE_APPROVED", "alpha", 1, "code-generation", "**Gate Scope**: per-stage\n**Gate Stages**: code-generation\n**User Input**: Approve in attempt 1\n", "unstarted#0", now())}`,
        );
        hookRow(checkout, own, "GATE_APPROVED",
          "**Stage**: code-generation\n**Gate Scope**: per-stage\n**Gate Stages**: code-generation\n**User Input**: Approve with no Unit\n");
      },
    });
    const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(published.status, published.out).toBe(0);
    const moved = shardText(checkout, "HEAD", g2);
    expect(moved).toContain("Approve in attempt 1");
    expect(moved).toContain("Approve with no Unit");
    git(seed, ["fetch", "origin"]);
    const pinned = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pinned.status).not.toBe(0);
    expect(pinned.out).toContain("team gate approvals");
  });

  test("rows the branch added to another clone's shard on main are refused, with the way to put it back", () => {
    const { checkout, remote } = reopenedInTheSameCheckout();
    // Another clone's shard on main, which this branch added a row to.
    const other = clone(remote, "other");
    logRow(other, "another clone's row");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-m", "another clone's record"]);
    git(other, ["push", "origin", "main"]);
    const theirs = auditShardName(other);
    git(checkout, ["fetch", "origin"]);
    git(checkout, ["merge", "--no-edit", "origin/main"]);
    hookRow(checkout, theirs, "HUMAN_TURN", "**Origin**: person\n");
    git(checkout, ["commit", "-am", "a row in another clone's shard"]);
    const before = git(checkout, ["rev-parse", "HEAD"]);
    const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(published.status).not.toBe(0);
    expect(published.out).toContain(theirs);
    expect(published.out).toContain("git checkout");
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(before);
  });
});
