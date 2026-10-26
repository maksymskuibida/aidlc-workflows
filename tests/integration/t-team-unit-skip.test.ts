// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:skip, file:tools/aidlc-unit.ts
//
// A team-owned Unit's step can be skipped for that Unit while it is the step
// the Unit is working on. The skip check read only the solo walk, which team
// ownership never has, so the report fell through to a check on Current
// Stage and refused ("a step can be skipped only while it is the step in
// progress for one of your units"), and the state tool refused any one-Unit
// skip outside solo units. Once recorded, the Unit's walk goes on without a
// gate for the skipped step, and pin takes the UNIT_SKIPPED receipt in place
// of that step's documents, review and gate.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import { pullRequestMergeGateAsk } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const PERSON_ASKED = "the person asked to skip it";

// The skeleton Unit is done on main; the stance it was planned with is what
// lets the walk route the other Units.
function skeletonStanceOn(checkout: string): string {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8").replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n"),
  );
  return checkout;
}

function claimed(remote: string, unit: string, label: string): string {
  const checkout = clone(remote, label);
  const claim = runMergeTool(UNIT, ["claim", unit, "--team", label], checkout);
  expect(claim.status, claim.out).toBe(0);
  return skeletonStanceOn(checkout);
}

// Main working the team's Units itself, with no claim: the walk names the Unit.
function unclaimedMain(): string {
  const { remote } = makeSeed(parallelDependencyBody());
  const checkout = clone(remote, "main-unclaimed");
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8").replace(
      "- **Unit Gate Rhythm**: per-stage",
      "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
    ),
  );
  return checkout;
}

function cells(projectDir: string, unit: string): string[] {
  return unitProgressRow(projectDir, unit).split("|").slice(1, -1).map((cell) => cell.trim());
}

function report(checkout: string, args: string[]): Record<string, unknown> {
  const res = runMergeTool(ORCH, ["report", ...args], checkout);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

function startUnit(checkout: string, stage: string, unit: string): void {
  const started = runMergeTool(STATE, ["unit", "start", "--stage", stage, "--unit", unit], checkout);
  expect(started.status, started.out).toBe(0);
}

describe("t-team-unit-skip: a team Unit's step in progress is skipped for that Unit", () => {
  test("the Unit's first step, started, is skipped and its walk goes on to the next step", () => {
    const { remote } = makeSeed();
    const checkout = claimed(remote, "alpha", "alpha-team");
    const first = nextDirective(checkout);
    expect(first).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha", gate: false });
    startUnit(checkout, "functional-design", "alpha");

    const skipped = report(checkout, [
      "--stage", "functional-design", "--unit", "alpha", "--result", "skipped", "--reason", PERSON_ASKED,
    ]);
    expect(skipped.kind, JSON.stringify(skipped)).toBe("done");
    expect(String(skipped.reason)).toContain('Skipped "functional-design" for unit "alpha"');

    // No gate for the skipped step: the walk is on the next one.
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
  });

  test("a later step is skipped while Current Stage still reads an earlier one", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "alpha-team", {
      stages: ["functional-design", "nfr-requirements", "nfr-design"],
      keepRow: true,
      publish: false,
    });
    skeletonStanceOn(checkout);
    const step = nextDirective(checkout);
    expect(step).toMatchObject({ kind: "run-stage", stage: "infrastructure-design", unit: "alpha", gate: false });
    startUnit(checkout, "infrastructure-design", "alpha");

    const skipped = report(checkout, [
      "--stage", "infrastructure-design", "--unit", "alpha", "--result", "skipped", "--reason", PERSON_ASKED,
    ]);
    expect(skipped.kind, JSON.stringify(skipped)).toBe("done");
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
  });

  test("another step than the Unit's own is refused, naming the step in progress", () => {
    const { remote } = makeSeed();
    const checkout = claimed(remote, "alpha", "alpha-team");
    expect(nextDirective(checkout)).toMatchObject({ stage: "functional-design", unit: "alpha" });
    const refused = report(checkout, [
      "--stage", "nfr-design", "--unit", "alpha", "--result", "skipped", "--reason", PERSON_ASKED,
    ]);
    expect(refused.kind).toBe("error");
    expect(String(refused.message)).toContain('the step in progress for that unit is "functional-design"');
  });

  test("pin and land take a step skipped for the Unit in place of its documents, review and gate", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { skipStages: ["infrastructure-design"] });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    // The merge gate names the skipped step instead of calling every stage approved.
    const ask = pullRequestMergeGateAsk(seed, "alpha");
    expect(ask?.context).toContain("4 of 5 stages are approved and infrastructure-design is skipped for this Unit");
    expect(ask?.context).not.toContain("all 5 stages are approved");
    gateAndLand(seed, "alpha");
  });

  test("on main working its own Units, a skip without --unit covers the active Unit only and shows [S]", () => {
    const checkout = unclaimedMain();
    const first = nextDirective(checkout);
    expect(first).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    const unit = first.unit as string;
    const other = unit === "alpha" ? "beta" : "alpha";
    startUnit(checkout, "functional-design", unit);

    const skipped = report(checkout, [
      "--stage", "functional-design", "--result", "skipped", "--reason", PERSON_ASKED,
    ]);
    expect(skipped.kind, JSON.stringify(skipped)).toBe("done");
    expect(String(skipped.reason)).toContain(`for unit "${unit}" only`);
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit });
    // Main's Unit Progress shows the step skipped for that Unit, still owed by the other.
    expect(cells(checkout, unit)[2]).toBe("[S]");
    expect(cells(checkout, other)[2]).toBe("[ ]");
  });

  test("on main with no active Unit, a skip without --unit is refused and says to name the Unit", () => {
    const checkout = unclaimedMain();
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    const refused = report(checkout, [
      "--stage", "functional-design", "--result", "skipped", "--reason", PERSON_ASKED,
    ]);
    expect(refused.kind).toBe("error");
    expect(String(refused.message)).toContain("--unit <unit>");
    expect(String(refused.message)).toContain("next --skip");
  });

  test("under the unit-end rhythm with Code Generation skipped, pin and land take the Unit's approval", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { unitEnd: true, skipStages: ["code-generation"] });
    gateAndLand(seed, "alpha");
  });

});
