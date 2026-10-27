// covers: subcommand:aidlc-unit:status
//
// A team Unit claimed with stages left out (`unit claim --skip-stages`) lands
// with those stages folded as [S] in its Unit Progress row, its gate and merged
// cells [x]. The one opening rule that claim, status, release, the picker and
// the board share read a Unit as complete only when every stage cell was [x],
// so such a Unit stayed "claimed" after it landed and every Unit depending on it
// stayed blocked by it (seen on ReviewDesk u5-commenting, u12-local-git and
// u31-thin-slice). A skipped stage now counts as settled; the gate and merged
// cells still have to be [x].

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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

const LEFT_OUT = ["nfr-requirements", "nfr-design", "infrastructure-design"];

function blockedBy(seed: string, unit: string): string[] | null {
  const status = runMergeTool(UNIT, ["status"], seed);
  expect(status.status, status.out).toBe(0);
  const out = JSON.parse(status.stdout) as { waiting: Array<{ unit: string; blockedBy: string[] }> };
  return out.waiting.find((entry) => entry.unit === unit)?.blockedBy ?? null;
}

describe("t-team-unit-skipped-complete: a landed Unit with skipped stages is complete", () => {
  test("a Unit landed with stages left out at claim no longer blocks the Units that depend on it", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { claimSkipStages: LEFT_OUT });
    expect(blockedBy(seed, "beta")).toContain("alpha");
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toContain("[S]");
    git(seed, ["push", "-q", "origin", "HEAD:main"]);
    expect(blockedBy(seed, "beta") ?? []).not.toContain("alpha");
  });
});
