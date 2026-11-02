// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-unit:status
//
// The plan of a team-owned intent changes in the middle of Construction (merge
// strategy: back to Units Generation, gamma added, both stages approved again)
// while a Unit claimed in a special shape is still open: alpha claimed with the
// unit-end rhythm, alpha claimed with `--skip-stages nfr-design`. A Unit
// claimed that way was sent back to rebase when the plan only added another
// Unit. This file checks that the shape survives the change: a Unit whose own
// entry the plan leaves alone lands as it is, and one whose own entry changes
// is refused as stale, rebases, republishes and lands; either way its row is
// folded in the shape it was claimed with (one approval at the end; [S] for the
// left-out step). A Unit that is claimable for the new plan stays claimable
// whether the walking skeleton's stance is on or off.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import { makeReplanSeed, type PlannedUnit, replan } from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

// gamma waits only on the skeleton, so it can land while alpha's claim is open.
const PLAN_WITH_FREE_GAMMA: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["skeleton"] },
  { name: "gamma", depends_on: ["skeleton"] },
];

// alpha's own entry changes: it now waits on gamma too.
const PLAN_WHERE_ALPHA_WAITS_ON_GAMMA: PlannedUnit[] = PLAN_WITH_FREE_GAMMA.map((unit) =>
  unit.name === "alpha" ? { ...unit, depends_on: ["skeleton", "gamma"] } : unit
);

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

function status(checkout: string): { claimable: string[]; claimed: Array<{ unit: string; owner: string; generation: number }> } {
  const result = runMergeTool(UNIT, ["status"], checkout);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout);
}

/** The Unit's work rebased onto main, as its owner does it when a pin says the base is stale. */
function rebaseOntoMain(checkout: string): void {
  git(checkout, ["fetch", "origin", "main"]);
  const rebased = spawnSync("git", ["rebase", "origin/main"], { cwd: checkout, encoding: "utf-8" });
  if (rebased.status === 0) return;
  // Main's copy of the state file is taken: the candidate's state is engine
  // metadata that landing discards and re-derives from the Unit's receipts.
  const conflicts = git(checkout, ["diff", "--name-only", "--diff-filter=U"]).split(/\r?\n/).filter(Boolean);
  const state = seededStateFile(checkout).slice(checkout.length + 1).replaceAll("\\", "/");
  expect(conflicts, `${rebased.stdout}${rebased.stderr}`).toEqual([state]);
  git(checkout, ["checkout", "origin/main", "--", state]);
  git(checkout, ["add", state]);
  const continued = spawnSync("git", ["rebase", "--continue"], {
    cwd: checkout,
    encoding: "utf-8",
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  expect(continued.status, `${continued.stdout}${continued.stderr}`).toBe(0);
}

/** gamma claimed after the plan change, worked and published. */
function workGammaAfterReplan(remote: string): void {
  prepareCandidate(remote, "gamma", "gamma-team");
}

function mainAuditBlocks(main: string, event: string, unit: string): string[] {
  const dir = seededAuditDir(main);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => readFileSync(join(dir, name), "utf-8").replace(/\r\n/g, "\n").split("\n---\n"))
    .filter((block) => block.includes(`**Event**: ${event}`) && block.includes(`**Unit**: ${unit}`));
}

// Claims alpha in the given shape and publishes it, then changes the plan.
function alphaOpenWhenPlanChanges(options: Parameters<typeof prepareCandidate>[3], plan = PLAN_WITH_FREE_GAMMA) {
  const { seed, remote } = makeReplanSeed(parallelDependencyBody());
  const alpha = prepareCandidate(remote, "alpha", "alpha-team", options);
  replan(seed, plan);
  return { seed, remote, alpha };
}

// What a Unit's owner does after pin says the plan changed under the candidate.
function expectStaleThenRebased(seed: string, alpha: { checkout: string }): void {
  const stale = runMergeTool(UNIT, ["pin", "alpha"], seed);
  expect(stale.status, stale.out).not.toBe(0);
  expect(stale.out).toContain("stale Construction contract");
  expect(stale.out).toContain("rebase");
  rebaseOntoMain(alpha.checkout);
  const published = runMergeTool(UNIT, ["publish", "alpha"], alpha.checkout);
  expect(published.status, published.out).toBe(0);
}

describe("t-team-unit-replan-claim-shapes: a Unit claimed in a special shape keeps it when the plan changes", () => {
  test("a unit-end Unit open at the change stays claimed and gamma stays claimable", () => {
    const { seed } = alphaOpenWhenPlanChanges({ unitEnd: true });
    const listed = status(seed);
    expect(listed.claimed).toEqual([{ unit: "alpha", owner: expect.any(String), generation: 1 }]);
    expect(listed.claimable).toContain("gamma");
    expect(listed.claimable).toContain("beta");
  });

  test("a unit-end Unit lands as it is after gamma is added, with its one approval", () => {
    const { seed, remote } = alphaOpenWhenPlanChanges({ unitEnd: true });
    // gamma lands first, so the landing of alpha is not about gamma's missing row.
    workGammaAfterReplan(remote);
    gateAndLand(seed, "gamma");
    git(seed, ["push", "origin", "main"]);

    gateAndLand(seed, "alpha");
    expect(cells(seed, "alpha")).toEqual(Array(7).fill("[x]"));
    // The one approval it was claimed with, not an approval for each step.
    const gates = mainAuditBlocks(seed, "GATE_APPROVED", "alpha").filter((block) => !block.includes("unit-merge"));
    expect(gates.length, gates.join("\n---\n")).toBeGreaterThan(0);
    expect(gates.every((block) => block.includes("**Gate Scope**: unit-end"))).toBe(true);
  });

  test("a unit-end Unit whose own entry the plan changes is refused as stale, rebases, republishes and lands with its one approval", () => {
    const { seed, remote, alpha } = alphaOpenWhenPlanChanges({ unitEnd: true }, PLAN_WHERE_ALPHA_WAITS_ON_GAMMA);
    workGammaAfterReplan(remote);
    gateAndLand(seed, "gamma");
    git(seed, ["push", "origin", "main"]);

    expectStaleThenRebased(seed, alpha);
    gateAndLand(seed, "alpha");
    expect(cells(seed, "alpha")).toEqual(Array(7).fill("[x]"));
    const gates = mainAuditBlocks(seed, "GATE_APPROVED", "alpha").filter((block) => !block.includes("unit-merge"));
    expect(gates.length, gates.join("\n---\n")).toBeGreaterThan(0);
    expect(gates.every((block) => block.includes("**Gate Scope**: unit-end"))).toBe(true);
  });

  test("a Unit claimed with --skip-stages nfr-design keeps its [S] through the change and lands as it is with the step still left out", () => {
    const { seed, remote } = alphaOpenWhenPlanChanges({ claimSkipStages: ["nfr-design"] });
    workGammaAfterReplan(remote);
    gateAndLand(seed, "gamma");
    git(seed, ["push", "origin", "main"]);

    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    expect(cells(seed, "alpha")).toEqual(["[x]", "[x]", "[S]", "[x]", "[x]", "[x]", "[x]"]);
    // Counts as complete: Units that wait on alpha stay claimable.
    expect(status(seed).claimable).not.toContain("alpha");
  });

  for (const stance of ["on", "off"] as const) {
    test(`with the walking skeleton ${stance}, the Unit the plan adds is claimable, worked and landed`, () => {
      const { seed, remote } = makeReplanSeed(parallelDependencyBody(), stance);
      replan(seed, PLAN_WITH_FREE_GAMMA);

      expect(status(seed).claimable).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
      workGammaAfterReplan(remote);
      gateAndLand(seed, "gamma");
      expect(cells(seed, "gamma")).toEqual(Array(7).fill("[x]"));
    });
  }
});
