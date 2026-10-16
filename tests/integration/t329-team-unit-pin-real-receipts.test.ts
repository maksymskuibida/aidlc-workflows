// covers: file:tools/aidlc-unit.ts
//
// Pin reads a candidate the way a real claimed clone produces it. A clone
// stamps every receipt with the run floor it reads from the whole audit record
// (main's rows and its own); the engine's own plan question stamps its
// approval row's Checkpoint as `plan-approval`; and the Unit's row of the
// candidate's aidlc-state.md is engine metadata a landing discards. Pin must
// read the receipts against that same floor, accept that checkpoint name, and
// derive the row from the receipts rather than read it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { seededAuditDir } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STARTED_AT = "2026-08-19T23:00:00Z";
// The floor a clone reads once the record carries the workflow's start.
const STARTED_FLOOR = `WORKFLOW_STARTED:${STARTED_AT}#1`;

// Every real record carries its workflow's start on main; the fixture seed
// does not, so the floor it implies is the one of a record with no rows.
function startWorkflowOnMain(seed: string): void {
  writeFileSync(
    join(seededAuditDir(seed), "main-workflow.md"),
    `## Workflow Started\n**Timestamp**: ${STARTED_AT}\n**Event**: WORKFLOW_STARTED\n` +
      "**Stage**: functional-design\n\n---\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "workflow started"]);
  git(seed, ["push", "origin", "main"]);
}

const LANDED_ROW = "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |";

describe("t329 pin reads the candidate a real clone produces", () => {
  test("receipts stamped with the record's run floor pin, gate and land", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toBe(LANDED_ROW);
  });

  test("receipts below the record's run floor are not evidence", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    // Stamped as if the record had never started: below the floor main holds.
    prepareCandidate(remote, "alpha", "alpha-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain("UNIT_COMPLETED receipts");
  });

  test("the engine's own plan-approval checkpoint name is the same approval", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { checkpoint: "plan-approval" });
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toBe(LANDED_ROW);
  });

  test("the Unit's row in the candidate state is derived from receipts, not read", () => {
    const { seed, remote } = makeSeed();
    // The candidate leaves its row as main had it: unowned and unstarted.
    prepareCandidate(remote, "alpha", "alpha-team", { keepRow: true });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    expect(JSON.parse(pin.stdout).evidence.stages_completed).toEqual([
      "functional-design",
      "nfr-requirements",
      "nfr-design",
      "infrastructure-design",
      "code-generation",
    ]);
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toBe(LANDED_ROW);
  });
});
