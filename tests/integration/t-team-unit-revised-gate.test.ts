// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-jump:reopen
//
// A team Unit's approved Code Generation reopened for a change leaves that
// Unit's gate revising. Once the Unit's work was settled again, the team walk
// showed the gate as an open one (gate_only, "show its approval question
// again"), so the person's Request Changes was refused: only a pending or
// awaiting gate can be rejected. A revising gate re-enters approval through
// `report --result revised`, as a solo stage's does after its revision; the
// walk now asks for that report first, and the gate it opens takes the
// person's answer.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  GUARD_RECOVERY_ASK_TYPE,
  readStateFile,
  stateDigest,
  unitGateStatus,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTempDirs,
  makeSeed,
  nextDirective,
  ORCH,
  prepareCandidate,
  runMergeTool,
  STATE,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

// The skeleton Unit is done on main; the stance it was planned with is what
// lets the walk route the other Units. The harness's review records are
// shaped for pin, not for the walk's own review check, so reviews are off,
// and nobody is asked about the plan, so the rebuilt plan needs no answer.
function routable(checkout: string): void {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8")
      .replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n")
      .replace("- **Review Override**: adversarial", "- **Review Override**: none\n- **Plan Approval**: off (set by you)"),
  );
}

function run(tool: string, checkout: string, args: string[]): string {
  const res = runMergeTool(tool, args, checkout);
  expect(res.status, res.out).toBe(0);
  return res.stdout;
}

function report(checkout: string, args: string[]): Record<string, unknown> {
  return JSON.parse(run(ORCH, checkout, ["report", "--stage", "code-generation", "--unit", "alpha", ...args])) as
    Record<string, unknown>;
}

// alpha's approved Code Generation, reopened for a change and built again.
function reopenedAndRebuilt(): string {
  const { remote } = makeSeed();
  const { checkout } = prepareCandidate(remote, "alpha", "alpha-team", { keepRow: true, publish: false });
  routable(checkout);
  run(JUMP, checkout, [
    "reopen", "--target", "code-generation", "--stages", "code-generation", "--units", "alpha",
    "--scope", "feature", "--via", "change",
  ]);
  expect(unitGateStatus(checkout, "code-generation", "alpha", "per-stage")).toBe("revising");
  expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha", gate: false });

  run(STATE, checkout, ["unit", "start", "--stage", "code-generation", "--unit", "alpha"]);
  const plan = join(seededRecordDir(checkout), "construction", "alpha", "code-generation", "code-generation-plan.md");
  writeFileSync(plan, `${readFileSync(plan, "utf-8")}- [ ] Apply the change.\n`);
  expect(nextDirective(checkout)).toMatchObject({ stage: "code-generation", unit: "alpha", plan_approval: { status: "approved" } });
  run(STATE, checkout, ["unit", "complete", "--stage", "code-generation", "--unit", "alpha"]);
  return checkout;
}

// next, then the report it names: the gate it reopens is the gate the person sees.
function gateShownAgain(checkout: string): void {
  const step = nextDirective(checkout);
  expect(step.kind, JSON.stringify(step)).toBe("print");
  expect(String(step.message)).toContain("--result revised");
  expect(String(step.message)).toContain("--unit alpha");
  const reopened = report(checkout, ["--result", "revised"]);
  expect(reopened.kind, JSON.stringify(reopened)).toBe("print");
  expect(unitGateStatus(checkout, "code-generation", "alpha", "per-stage")).toBe("awaiting-approval");
  expect(nextDirective(checkout)).toMatchObject({
    kind: "run-stage", stage: "code-generation", unit: "alpha", gate: true, gate_only: true, unit_gate: "per-stage",
  });
}

describe("t-team-unit-revised-gate: a team Unit's revised gate takes the person's answer", () => {
  test("Request Changes at the gate of a reopened and rebuilt Unit is recorded", () => {
    const checkout = reopenedAndRebuilt();
    gateShownAgain(checkout);
    const rejected = report(checkout, ["--result", "rejected", "--user-input", "Request Changes", "--reason", "Rename it"]);
    expect(rejected.kind, JSON.stringify(rejected)).toBe("print");
    expect(unitGateStatus(checkout, "code-generation", "alpha", "per-stage")).toBe("revising");
  });

  test("Approve at the gate of a reopened and rebuilt Unit is recorded", () => {
    const checkout = reopenedAndRebuilt();
    gateShownAgain(checkout);
    const approved = report(checkout, ["--result", "approved", "--user-input", "Approve"]);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    expect(unitGateStatus(checkout, "code-generation", "alpha", "per-stage")).toBe("approved");
  });

  // The gate refused once on the way (a review it wanted was missing): the
  // recovery question it asked stood as the engine's step after the review was
  // recorded, because the revised report `next` then names is a printed step
  // that publishes none. The plan-approval guard judged that report by the
  // stale question and refused it (seen on ReviewDesk u16-menus-settings):
  // "Code Generation cannot start: the current state has no matching v2
  // code-generation active directive".
  test("the revised report next names passes the plan guard after a recovery question", () => {
    const checkout = reopenedAndRebuilt();
    writeActiveDirectiveMarker(checkout, {
      kind: "ask",
      ask_type: GUARD_RECOVERY_ASK_TYPE,
      stage: "functional-design",
      unit: "alpha",
      state_sha256: stateDigest(readStateFile(checkout)),
      remedies: [{
        op: "redo-jump",
        label: "Start the stage over",
        action: "Restart the stage from the top with /aidlc --stage functional-design.",
        interaction: "command",
        operation: { kind: "restart-stage", stage: "functional-design" },
      }],
    });
    const step = nextDirective(checkout);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const command = /`([^`]* report --stage code-generation --unit alpha --result revised)`/.exec(String(step.message))?.[1];
    expect(command, String(step.message)).toBeDefined();
    // As an installed engine runs it (the fixture prints the source tool's spelling).
    const installed = command!.replace(/^bun \S*aidlc-orchestrate\.ts /, "aidlc engine orchestrate ");
    const guard = spawnSync(process.execPath, [join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
      cwd: checkout,
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: installed } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: checkout, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
    });
    expect(guard.status, guard.stderr).toBe(0);
  });
});
