// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A team Unit claimed with the unit-end rhythm and stages left out
// (`unit claim --rhythm unit-end --skip-stages ...`) reached its one gate after
// Code Generation, and the gate refused: it checked every per-Unit stage of the
// plan for its artifacts, the skipped ones too, so `next` stopped at a
// guard-recovery question for NFR Requirements whose only way out was Request
// Changes. The unit-end gate covers the stages the Unit ran; a stage skipped for
// the Unit is left out of it, as a construction checkpoint's gate leaves out a
// stage skipped for every Unit.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readAllAuditShards, unitGateStatus } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  makeSeed,
  nextDirective,
  ORCH,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const LEFT_OUT = ["nfr-requirements", "nfr-design", "infrastructure-design"];

// The harness's review records are shaped for pin, not for the walk's own
// review check, so reviews are off; the skeleton stance lets the walk route.
function routable(checkout: string): void {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8")
      .replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n")
      .replace("- **Review Override**: adversarial", "- **Review Override**: none\n- **Plan Approval**: off (set by you)"),
  );
}

function report(checkout: string, args: string[]): Record<string, unknown> {
  const res = runMergeTool(ORCH, ["report", "--stage", "code-generation", "--unit", "alpha", ...args], checkout);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

// alpha claimed unit-end with three stages left out, Functional Design and Code
// Generation done, its one gate not yet asked.
function builtUnitEnd(): string {
  const { remote } = makeSeed();
  const { checkout } = prepareCandidate(remote, "alpha", "alpha-team", {
    keepRow: true,
    publish: false,
    unitEnd: true,
    claimSkipStages: LEFT_OUT,
    ungated: ["code-generation"],
  });
  routable(checkout);
  return checkout;
}

describe("t-team-unit-end-skipped-gate: a unit-end gate leaves out the stages skipped for the Unit", () => {
  test("the gate opens, takes Approve, and records only the stages the Unit ran", () => {
    const checkout = builtUnitEnd();
    const step = nextDirective(checkout);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("guard-recovery");

    const opened = report(checkout, ["--result", "awaiting-approval"]);
    expect(opened.kind, JSON.stringify(opened)).toBe("print");
    expect(unitGateStatus(checkout, "code-generation", "alpha", "unit-end")).toBe("awaiting-approval");

    const approved = report(checkout, ["--result", "approved", "--user-input", "Approve"]);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    expect(unitGateStatus(checkout, "code-generation", "alpha", "unit-end")).toBe("approved");

    const approval = readAllAuditShards(checkout)
      .split("\n## ")
      .filter((block) => block.includes("**Event**: GATE_APPROVED") && block.includes("**Gate Scope**: unit-end"))
      .at(-1) ?? "";
    const gated = approval.match(/\*\*Gate Stages\*\*: (.+)/)?.[1]?.split(",").map((slug) => slug.trim());
    expect(gated).toEqual(["functional-design", "code-generation"]);
  });

  test("its approval, the skipped stages left out, lands: pin, gate and land fold the row with them [S]", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { unitEnd: true, claimSkipStages: LEFT_OUT });
    gateAndLand(seed, "alpha");
    const row = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(row.slice(2, 7)).toEqual(["[x]", "[S]", "[S]", "[S]", "[x]"]);
  });
});
