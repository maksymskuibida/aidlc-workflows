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
import {
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
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
    gateAndLand(seed, "alpha");
  });
});
