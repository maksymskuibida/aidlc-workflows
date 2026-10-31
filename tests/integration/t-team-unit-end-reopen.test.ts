// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A landed team Unit claimed again (`claim --reopen`) with another gate rhythm
// than the attempt that landed was shown with the landed attempt's rhythm.
// Unit Progress took each Unit's rhythm from its latest gate row of any
// attempt, and a reopened attempt has none of its own until its first gate. So
// an attempt claimed unit-end after a per-stage one showed each finished stage
// awaiting a per-stage approval it never asks: Functional Design and the gate
// column stayed `[?]` while the walk went on to NFR Requirements, and the
// agent's attempt to clear it was refused ("Unit-end gate ... must be reported
// against \"code-generation\""). The rhythm now comes from the attempt the
// checkout reads, so a finished stage is `[x]`, the gate column says the
// attempt is a change (`[R]`) until its one gate opens after Code Generation,
// and that gate takes the attempt's Request Changes the normal way.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { unitGateStatus } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  ORCH,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const WHY = "the refund total ignores tax";
const REOPEN = ["--reopen", "--user-input", WHY];

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

// The harness's review records are shaped for pin, not for the walk's own
// review check, so reviews are off; the skeleton stance lets the walk route.
function routable(checkout: string): string {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8")
      .replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n")
      .replace("- **Review Override**: adversarial", "- **Review Override**: none\n- **Plan Approval**: off (set by you)"),
  );
  return checkout;
}

// alpha's first attempt landed with the given rhythm; it is claimed again in a
// fresh clone with the other one, its listed stages done and none approved.
function reopenedWithOtherRhythm(
  first: { unitEnd?: boolean },
  again: { unitEnd?: boolean; perStage?: boolean; stages?: string[] },
): string {
  const { seed, remote } = makeSeed(parallelDependencyBody());
  prepareCandidate(remote, "alpha", "alpha-team", first);
  gateAndLand(seed, "alpha");
  git(seed, ["push", "origin", "main"]);
  const stages = again.stages ?? ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
  const { checkout } = prepareCandidate(remote, "alpha", "alpha-again", {
    ...again,
    stages,
    ungated: stages,
    claimArgs: REOPEN,
    keepRow: true,
    publish: false,
  });
  return routable(checkout);
}

function report(checkout: string, args: string[]): { status: number | null; json: Record<string, unknown> } {
  const res = runMergeTool(ORCH, ["report", "--unit", "alpha", ...args], checkout);
  return { status: res.status, json: JSON.parse(res.stdout || res.out) as Record<string, unknown> };
}

describe("t-team-unit-end-reopen: a reopened attempt is shown with its own gate rhythm", () => {
  test("unit-end after a per-stage attempt: a finished design stage is [x], not awaiting a per-stage gate", () => {
    const checkout = reopenedWithOtherRhythm({}, { unitEnd: true, stages: ["functional-design"] });
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
    // Was `[?] | [ ] | [ ] | [ ] | [ ] | [?]`.
    expect(cells(checkout, "alpha")).toEqual(["[x]", "[ ]", "[ ]", "[ ]", "[ ]", "[R]"]);
    // There is no Functional Design gate to answer: the Unit's one gate is after Code Generation.
    const refused = report(checkout, ["--stage", "functional-design", "--result", "rejected"]);
    expect(String(refused.json.message)).toContain('must be reported against "code-generation", not "functional-design"');
  });

  test("its one gate after Code Generation takes the attempt's change the normal way", () => {
    const checkout = reopenedWithOtherRhythm({}, { unitEnd: true });
    const step = nextDirective(checkout);
    expect(String(step.message)).toContain("--result revised");
    // Was `[?]` in every cell before the gate opened.
    expect(cells(checkout, "alpha")).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[R]"]);

    const revised = report(checkout, ["--stage", "code-generation", "--result", "revised"]);
    expect(revised.status, JSON.stringify(revised.json)).toBe(0);
    expect(unitGateStatus(checkout, "code-generation", "alpha", "unit-end")).toBe("awaiting-approval");
    nextDirective(checkout);
    expect(cells(checkout, "alpha")).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[?]"]);

    const approved = report(checkout, ["--stage", "code-generation", "--result", "approved", "--user-input", "Approve"]);
    expect(approved.json.kind, JSON.stringify(approved.json)).toBe("done");
    nextDirective(checkout);
    expect(cells(checkout, "alpha")).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
  });

  test("per-stage after a unit-end attempt: a finished stage is the change its own gate answers", () => {
    const checkout = reopenedWithOtherRhythm({ unitEnd: true }, { perStage: true, stages: ["functional-design"] });
    expect(String(nextDirective(checkout).message)).toContain("--stage functional-design --unit alpha --result revised");
    // Each stage the attempt works is reopened as the change its own gate
    // answers. Was `[x]` for Functional Design: read as unit-end, with no gate
    // of its own to ask.
    expect(cells(checkout, "alpha")).toEqual(["[R]", "[R]", "[R]", "[R]", "[R]", "[R]"]);
  });
});
