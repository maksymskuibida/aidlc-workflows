// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-learnings:surface
//
// Under Unit Ownership: team a Unit's per-Unit stage runs in that Unit's own
// claimed checkout, which commits only the Unit's record tree
// (`construction/<unit>/`; pin refuses anything else). The run-stage directive
// still named the stage-level `construction/<stage>/memory.md` as the diary, so
// the agent was told to keep its notes in a file its checkout cannot land, and
// the learnings step at the Unit's gate read that same file. The diary is now
// the Unit's own `construction/<unit>/<stage>/memory.md`, the path a per-Unit
// wave entry already uses, and the learnings step reads it there.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relativeRecordDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const LEARNINGS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

function claimedCheckout(unit: string): string {
  const { remote } = makeSeed(parallelDependencyBody());
  const checkout = clone(remote, `${unit}-team`);
  const claim = runMergeTool(UNIT, ["claim", unit, "--team", `${unit}-team`], checkout);
  expect(claim.status, claim.out).toBe(0);
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8").replace(
      "- **Unit Gate Rhythm**: per-stage",
      "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
    ),
  );
  return checkout;
}

describe("t-team-unit-stage-diary a team Unit keeps its stage diary in its own record tree", () => {
  test("the run-stage directive names the Unit's own diary, not the stage-level one", () => {
    const checkout = claimedCheckout("alpha");
    const directive = nextDirective(checkout);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    const prefix = relativeRecordDir(checkout);
    expect(directive.memory_path).toBe(`${prefix}/construction/alpha/functional-design/memory.md`);
  });

  test("the learnings step at the Unit's gate reads the Unit's own diary", () => {
    const checkout = claimedCheckout("beta");
    const prefix = relativeRecordDir(checkout);
    const unitDiary = join(checkout, prefix!, "construction", "beta", "functional-design");
    mkdirSync(unitDiary, { recursive: true });
    writeFileSync(
      join(unitDiary, "memory.md"),
      "## Interpretations\n- Kept the profile form to one page, as the person asked\n",
    );
    const surfaced = runMergeTool(LEARNINGS, ["surface", "--slug", "functional-design"], checkout);
    expect(surfaced.status, surfaced.out).toBe(0);
    const out = JSON.parse(surfaced.stdout) as { phase: string; candidates: { summary: string }[] };
    expect(out.phase).toBe("construction");
    expect(out.candidates.map((candidate) => candidate.summary)).toEqual([
      "Kept the profile form to one page, as the person asked",
    ]);
  });
});
