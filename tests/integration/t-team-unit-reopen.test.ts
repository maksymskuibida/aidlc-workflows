// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-orchestrate:next
//
// A failed Build and Test (or a later check, or another Unit's work) can send
// ONE landed team Unit back. There was no way to: a landed Unit could not be
// claimed again ("already complete on the integration ref"), and a jump for
// one Unit from main gave the solo answer, "reopen it for every unit".
//
// `aidlc unit claim <unit> --reopen --user-input <why>` claims a landed Unit
// again as the next attempt, with the person's reason in the claim. Nothing on
// main changes until that attempt lands: the Unit stays complete there, so the
// Units that depend on it stay claimable. Main's Build and Test waits while any
// claim's attempt has not landed. A claim again runs every stage. When it lands, the Unit's row is the new attempt's, and the stages main had
// done from Build and Test on run again.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFilename, loadStageGraphAll } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  ORCH,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const WHY = "the refund total ignores tax";

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

// alpha and beta both wait only on the skeleton; alpha lands, and main is pushed.
function alphaLanded(alphaOptions: Parameters<typeof prepareCandidate>[3] = {}): { seed: string; remote: string } {
  const { seed, remote } = makeSeed(parallelDependencyBody());
  prepareCandidate(remote, "alpha", "alpha-team", alphaOptions);
  gateAndLand(seed, "alpha");
  git(seed, ["push", "origin", "main"]);
  return { seed, remote };
}

const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
// The stage's checks are not this case's subject.
const NO_SENSORS = { AIDLC_DISABLE_SENSORS: "1" };

// A reopened per-Unit stage worked again by its own steps, reviewed, and its
// revision approved at the stage's gate.
function redoStage(checkout: string, slug: string): void {
  const stage = loadStageGraphAll().find((entry) => entry.slug === slug)!;
  const started = runMergeTool(STATE, ["unit", "start", "--stage", slug, "--unit", "alpha"], checkout, false, NO_SENSORS);
  expect(started.status, started.out).toBe(0);
  const dir = join(seededRecordDir(checkout), "construction", "alpha", slug);
  for (const name of stage.produces ?? []) appendFileSync(join(dir, artifactFilename(name)), `\n${WHY}\n`);
  if (stage.reviewer) {
    const review = ["review", "--stage", slug, "--reviewer", stage.reviewer, "--iteration", "1", "--unit", "alpha"];
    const requested = runMergeTool(LOG, review, checkout, false, NO_SENSORS);
    expect(requested.status, requested.out).toBe(0);
    appendFileSync(
      join(dir, artifactFilename(stage.review_artifact!)),
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${stage.reviewer}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
    );
    const verdict = runMergeTool(LOG, [...review, "--verdict", "READY"], checkout, false, NO_SENSORS);
    expect(verdict.status, verdict.out).toBe(0);
  }
  const completed = runMergeTool(STATE, ["unit", "complete", "--stage", slug, "--unit", "alpha"], checkout, false, NO_SENSORS);
  expect(completed.status, completed.out).toBe(0);
  for (const result of ["revised", "approved"]) {
    const reported = runMergeTool(
      ORCH,
      ["report", "--stage", slug, "--unit", "alpha", "--result", result, ...(result === "approved" ? ["--user-input", "Approve"] : [])],
      checkout,
      false,
      NO_SENSORS,
    );
    expect(reported.status, reported.out).toBe(0);
  }
}

function stageLine(checkout: string, stage: string): string {
  return readFileSync(seededStateFile(checkout), "utf-8").split("\n").find((line) => line.includes(`] ${stage} `)) ?? "";
}

describe("t-team-unit-reopen: one landed team Unit goes back to work", () => {
  test("a landed Unit is claimed again only with --reopen, as the next attempt, with the person's reason", () => {
    const { remote } = alphaLanded();
    const checkout = clone(remote, "alpha-again");
    const plain = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], checkout);
    expect(plain.status).not.toBe(0);
    expect(plain.out).toContain("--reopen");

    const reopened = runMergeTool(
      UNIT,
      ["claim", "alpha", "--team", "alpha-team", "--reopen", "--user-input", WHY],
      checkout,
    );
    expect(reopened.status, reopened.out).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({
      claimed: true,
      unit: "alpha",
      generation: 2,
      reopen: { landed_generation: 1, reason: WHY },
    });
    // The attempt runs every stage again: nothing is left out unless named.
    const first = nextDirective(checkout);
    expect(first).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    expect(first.memory_path).toContain("/construction/alpha/functional-design/");
  });

  test("--reopen needs the person's reason, and refuses a Unit that has not landed", () => {
    const { remote } = alphaLanded();
    const checkout = clone(remote, "beta-team");
    const noReason = runMergeTool(UNIT, ["claim", "alpha", "--reopen"], checkout);
    expect(noReason.status).not.toBe(0);
    expect(noReason.out).toContain("--user-input");
    const notLanded = runMergeTool(UNIT, ["claim", "beta", "--reopen", "--user-input", WHY], checkout);
    expect(notLanded.status).not.toBe(0);
    expect(notLanded.out).toContain("has not landed");
  });

  test("nothing on main changes: the Unit stays complete and the Units that depend on it stay claimable", () => {
    const { seed, remote } = alphaLanded();
    const again = clone(remote, "alpha-again");
    expect(runMergeTool(UNIT, ["claim", "alpha", "--reopen", "--user-input", WHY], again).status).toBe(0);
    git(seed, ["pull", "--ff-only"]);
    expect(cells(seed, "alpha").every((cell) => cell === "[x]")).toBe(true);
    const status = JSON.parse(runMergeTool(UNIT, ["status"], seed).stdout);
    expect(status.claimable).toContain("beta");
    expect(status.claimed).toEqual([{ unit: "alpha", owner: expect.any(String), generation: 2 }]);
  });

  test("on a team main, reopening one Unit names claim --reopen instead of the every-unit answer", () => {
    const { seed } = alphaLanded();
    const asked = runMergeTool(ORCH, ["next", "--stage", "code-generation", "--unit", "alpha"], seed);
    expect(asked.status, asked.out).toBe(0);
    expect(asked.stdout).toContain("aidlc unit claim alpha --reopen");
    expect(asked.stdout).not.toContain("every unit");
  });

  test("the reopened attempt's agent is told why and from which documents", () => {
    const { seed, remote } = alphaLanded();
    prepareCandidate(remote, "beta", "beta-team");
    gateAndLand(seed, "beta");
    git(seed, ["push", "origin", "main"]);
    const checkout = clone(remote, "alpha-again");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--reopen", "--user-input", WHY], checkout);
    expect(claimed.status, claimed.out).toBe(0);
    const path = seededStateFile(checkout);
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n"),
    );
    const step = nextDirective(checkout);
    expect(step).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    const note = String(step.attempt_note);
    expect(note).toContain("attempt 2 of unit alpha");
    expect(note).toContain(WHY);
    expect(note).toContain("Request Changes");
    expect(note).toContain("/construction/alpha/functional-design/");
  });

  test("the landed plan is revised from the reason first, though its approval is committed on the clone", () => {
    // Attempt 1's plan approval is a committed PLAN_APPROVAL_RECORDED row, which
    // a clone reads in place of a missing receipt only on the same run floor.
    // The reopen's change rows start a new floor, so the plan, still as it
    // landed, is not built as approved: it is revised from the person's reason.
    const { remote } = alphaLanded();
    const checkout = clone(remote, "alpha-again");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team", "--reopen", "--user-input", WHY], checkout);
    expect(claimed.status, claimed.out).toBe(0);
    expect(git(checkout, ["log", "-p", "--format=", "--", "aidlc"])).toContain("PLAN_APPROVAL_RECORDED");
    const path = seededStateFile(checkout);
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n"),
    );
    for (const stage of ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"]) {
      expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage, unit: "alpha" });
      redoStage(checkout, stage);
    }
    const step = nextDirective(checkout);
    expect(step).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
    expect(step.plan_approval).toMatchObject({ status: "revise" });
    expect(JSON.stringify(step.plan_approval)).toContain(WHY);
  });

  test("Build and Test waits on the open attempt; its landing takes the new attempt's stages and runs Build and Test again", () => {
    // Attempt 1 landed; Build and Test then ran and passed.
    const { seed, remote } = alphaLanded();
    prepareCandidate(remote, "beta", "beta-team");
    gateAndLand(seed, "beta");
    expect(cells(seed, "alpha")).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
    const path = seededStateFile(seed);
    writeFileSync(
      path,
      readFileSync(path, "utf-8")
        .replace("- [-] build-and-test — EXECUTE", "- [x] build-and-test — EXECUTE")
        .replace("- [ ] ci-pipeline — EXECUTE", "- [-] ci-pipeline — EXECUTE")
        .replace("- **Current Stage**: build-and-test", "- **Current Stage**: ci-pipeline"),
    );
    git(seed, ["commit", "-am", "Build and Test passed"]);
    git(seed, ["push", "origin", "main"]);

    // Attempt 2 runs every stage again.
    prepareCandidate(remote, "alpha", "alpha-team", { claimArgs: ["--reopen", "--user-input", WHY] });
    git(seed, ["fetch", "origin"]);
    const waiting = nextDirective(seed);
    expect(JSON.stringify(waiting)).toContain("alpha");
    expect(waiting).not.toMatchObject({ kind: "run-stage", stage: "ci-pipeline" });
    // What main's own step wrote is committed, as the person commits it.
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "--allow-empty", "-m", "main's board"]);

    gateAndLand(seed, "alpha");
    expect(cells(seed, "alpha")).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
    // Build and Test starts again, and what main had done after it is undone.
    expect(stageLine(seed, "build-and-test")).toContain("[-]");
    expect(stageLine(seed, "ci-pipeline")).toContain("[ ]");
    // The lead pushes main after the land, as its hand-over asks.
    git(seed, ["push", "origin", "main"]);
    expect(nextDirective(seed)).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
  });
});
