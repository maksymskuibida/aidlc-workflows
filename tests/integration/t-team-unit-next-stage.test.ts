// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// The Approve option of a team-owned Unit's gate reads "Continue to
// <next_stage>". next_stage was the next stage in plan order, so the Unit's
// last step named Build and Test. For a Unit in the checkout that claimed it,
// what follows that step is the Unit's landing (publish, pin, the merge
// gate, land); Build and Test runs once, after every Unit lands. The
// gate, the reply that opens it and the approval now say so; an earlier step
// still names the Unit's next one.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LANDING = "landing Unit alpha";

// The skeleton Unit is done on main; the stance it was planned with is what
// lets the walk route the other Units. The harness's review records are
// shaped for pin, not for the walk's own review check, so reviews are off.
function routable(checkout: string): void {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8")
      .replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n")
      .replace("- **Review Override**: adversarial", "- **Review Override**: none"),
  );
}

function report(checkout: string, args: string[]): Record<string, unknown> {
  const res = runMergeTool(ORCH, ["report", ...args], checkout);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

describe("t-team-unit-next-stage: a team Unit's last step is followed by its landing", () => {
  test("the Code Generation gate, its opening reply and its approval name the Unit's landing", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "alpha-team", {
      ungated: ["code-generation"],
      keepRow: true,
      publish: false,
    });
    routable(checkout);
    const gate = nextDirective(checkout);
    expect(gate).toMatchObject({ stage: "code-generation", unit: "alpha", gate: true, unit_gate: "per-stage" });
    expect(gate.next_stage).toBe(LANDING);

    const opened = report(checkout, ["--stage", "code-generation", "--unit", "alpha", "--result", "awaiting-approval"]);
    expect(opened.next_stage, JSON.stringify(opened)).toBe(LANDING);

    const approved = report(checkout, [
      "--stage", "code-generation", "--unit", "alpha", "--result", "approved", "--user-input", "Approve",
    ]);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    expect(String(approved.reason)).toContain("the steps that land it");
  });

  test("an earlier step's gate still names the Unit's next step", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "alpha-team", {
      stages: ["functional-design", "nfr-requirements", "nfr-design"],
      ungated: ["nfr-design"],
      keepRow: true,
      publish: false,
    });
    routable(checkout);
    const gate = nextDirective(checkout);
    expect(gate).toMatchObject({ stage: "nfr-design", unit: "alpha", gate: true });
    expect(gate.next_stage).toBe("Infrastructure Design");
  });
});
