// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-orchestrate:next
//
// A team intent changes its Unit plan in the middle of Construction (back to
// Units Generation on main, a Unit added to the DAG, Units Generation and
// Delivery Planning approved again), and a Unit that had already landed turns
// out to be broken by the new one. Going back to Units Generation put the
// landed Units back to work and Build and Test never ran again. This file
// checks that `claim <unit> --reopen --user-input <why>` works around the
// change: the landed Unit goes back to work as the next attempt and stays
// complete on main meanwhile, an attempt published before the plan added a
// Unit lands as it is, main's Build and Test waits for the attempt and the new
// Unit and runs again once both have landed, and a Build and Test that had
// started or finished before the plan changed does not stay done.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  currentStage,
  makeReplanSeed,
  PLAN_WITH_GAMMA,
  replan,
  stageLine,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const WHY = "gamma shows that alpha's refund total ignores tax";

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

function push(main: string): void {
  git(main, ["push", "origin", "main"]);
}

/** Main's state, edited as Build and Test's own steps leave it, committed and pushed. */
function setMainStage(main: string, from: Array<[string, string]>): void {
  const path = seededStateFile(main);
  let state = readFileSync(path, "utf-8");
  for (const [was, now] of from) {
    expect(state, `${was} is in main's state`).toContain(was);
    state = state.replace(was, now);
  }
  writeFileSync(path, state);
  git(main, ["commit", "-am", "Build and Test progress"]);
  push(main);
}

/** alpha and beta landed (so Build and Test is next on main), pushed. */
function alphaAndBetaLanded(): { seed: string; remote: string } {
  const made = makeReplanSeed(parallelDependencyBody());
  prepareCandidate(made.remote, "alpha", "alpha-team");
  gateAndLand(made.seed, "alpha");
  prepareCandidate(made.remote, "beta", "beta-team");
  gateAndLand(made.seed, "beta");
  push(made.seed);
  return made;
}

function directiveWords(directive: Record<string, unknown>): string {
  return JSON.stringify({ kind: directive.kind, stage: directive.stage });
}

const BUILD_AND_TEST_RUN = JSON.stringify({ kind: "run-stage", stage: "build-and-test" });

describe("t-team-unit-replan-reopen-landed: a landed Unit goes back to work around a plan change", () => {
  test("after the replan, alpha reopens next to gamma's work: generation 2, alpha stays complete, gamma lands, Build and Test waits", () => {
    const { seed, remote } = alphaAndBetaLanded();
    replan(seed, PLAN_WITH_GAMMA);

    prepareCandidate(remote, "gamma", "gamma-team");
    // Claimed after the replan: its base already holds the new DAG.
    const again = prepareCandidate(remote, "alpha", "alpha-again", {
      claimArgs: ["--reopen", "--user-input", WHY],
    });
    expect(again.generation).toBe(2);

    git(seed, ["pull", "--ff-only"]);
    expect(cells(seed, "alpha").every((cell) => cell === "[x]")).toBe(true);
    const status = runMergeTool(UNIT, ["status"], seed);
    expect(status.status, status.out).toBe(0);
    expect(JSON.parse(status.stdout).claimed).toEqual(
      expect.arrayContaining([{ unit: "alpha", owner: expect.any(String), generation: 2 }]),
    );

    gateAndLand(seed, "gamma");
    push(seed);
    expect(cells(seed, "gamma").every((cell) => cell === "[x]")).toBe(true);
    // Every Unit is complete on main, but alpha's new attempt has not landed.
    const waiting = nextDirective(seed);
    expect(waiting, JSON.stringify(waiting)).not.toMatchObject({ kind: "run-stage", stage: "build-and-test" });
    expect(JSON.stringify(waiting)).toContain("alpha");
  });

  test("Build and Test starts once gamma and alpha's reopened attempt have landed", () => {
    const { seed, remote } = alphaAndBetaLanded();
    replan(seed, PLAN_WITH_GAMMA);
    prepareCandidate(remote, "gamma", "gamma-team");
    prepareCandidate(remote, "alpha", "alpha-again", { claimArgs: ["--reopen", "--user-input", WHY] });
    gateAndLand(seed, "gamma");
    push(seed);
    gateAndLand(seed, "alpha");
    expect(cells(seed, "alpha").every((cell) => cell === "[x]")).toBe(true);
    const next = nextDirective(seed);
    expect(directiveWords(next), JSON.stringify(next)).toBe(BUILD_AND_TEST_RUN);
  });

  test("Units Generation reopens after Build and Test started: Build and Test is reset, not left running from before the plan changed", () => {
    const { seed } = alphaAndBetaLanded();
    expect(currentStage(seed)).toBe("build-and-test");
    expect(stageLine(seed, "build-and-test")).toContain("[-]");
    replan(seed, PLAN_WITH_GAMMA);
    expect(currentStage(seed)).toBe("functional-design");
    expect(stageLine(seed, "build-and-test")).toContain("[ ]");
    expect(stageLine(seed, "units-generation")).toContain("[x]");
  });

  test("Units Generation reopens after Build and Test finished: Build and Test and what followed it are reset, not left done", () => {
    const { seed } = alphaAndBetaLanded();
    setMainStage(seed, [
      ["- [-] build-and-test — EXECUTE", "- [x] build-and-test — EXECUTE"],
      ["- [ ] ci-pipeline — EXECUTE", "- [-] ci-pipeline — EXECUTE"],
      ["- **Current Stage**: build-and-test", "- **Current Stage**: ci-pipeline"],
    ]);
    replan(seed, PLAN_WITH_GAMMA);
    expect(currentStage(seed)).toBe("functional-design");
    expect(stageLine(seed, "build-and-test")).toContain("[ ]");
    expect(stageLine(seed, "ci-pipeline")).toContain("[ ]");
  });

  test("Build and Test runs again once gamma lands, though it had finished before the plan changed", () => {
    const { seed, remote } = alphaAndBetaLanded();
    setMainStage(seed, [
      ["- [-] build-and-test — EXECUTE", "- [x] build-and-test — EXECUTE"],
      ["- [ ] ci-pipeline — EXECUTE", "- [-] ci-pipeline — EXECUTE"],
      ["- **Current Stage**: build-and-test", "- **Current Stage**: ci-pipeline"],
    ]);
    replan(seed, PLAN_WITH_GAMMA);
    prepareCandidate(remote, "gamma", "gamma-team");
    gateAndLand(seed, "gamma");
    push(seed);
    const next = nextDirective(seed);
    expect(directiveWords(next), JSON.stringify(next)).toBe(BUILD_AND_TEST_RUN);
    expect(stageLine(seed, "ci-pipeline")).toContain("[ ]");
  });

  test("alpha's reopened attempt is open when the plan adds gamma after alpha: alpha stays complete on main, so gamma stays claimable", () => {
    const { seed, remote } = alphaAndBetaLanded();
    // Attempt 2 is claimed and published before the plan changes.
    prepareCandidate(remote, "alpha", "alpha-again", { claimArgs: ["--reopen", "--user-input", WHY] });
    replan(seed, PLAN_WITH_GAMMA);
    const status = runMergeTool(UNIT, ["status"], seed);
    expect(status.status, status.out).toBe(0);
    const listed = JSON.parse(status.stdout);
    expect(listed.claimed).toEqual([{ unit: "alpha", owner: expect.any(String), generation: 2 }]);
    expect(listed.claimable, status.out).toContain("gamma");
    expect(cells(seed, "alpha").every((cell) => cell === "[x]")).toBe(true);
  });

  test("alpha's attempt 2, published before the plan added gamma, lands as it is: its own entry is unchanged", () => {
    const { seed, remote } = alphaAndBetaLanded();
    prepareCandidate(remote, "alpha", "alpha-again", { claimArgs: ["--reopen", "--user-input", WHY] });
    replan(seed, PLAN_WITH_GAMMA);

    gateAndLand(seed, "alpha");
    expect(cells(seed, "alpha").every((cell) => cell === "[x]")).toBe(true);
    expect(cells(seed, "gamma"), "gamma is still to do").not.toContain("[x]");
  });

  test("alpha's reopened attempt, claimed after the plan added gamma, lands while gamma is unlanded", () => {
    const { seed, remote } = alphaAndBetaLanded();
    replan(seed, PLAN_WITH_GAMMA);
    prepareCandidate(remote, "alpha", "alpha-again", { claimArgs: ["--reopen", "--user-input", WHY] });
    gateAndLand(seed, "alpha");
    expect(cells(seed, "alpha").every((cell) => cell === "[x]")).toBe(true);
    expect(cells(seed, "gamma"), "gamma is still to do").not.toContain("[x]");
  });
});
