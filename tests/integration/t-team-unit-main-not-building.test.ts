// covers: hook:aidlc-plan-approval-guard, function:codeGenerationIsTheStepHere
//
// Under team ownership a Unit's Code Generation is built only in the checkout
// that claimed it. A team Unit's branch carries its own walk in the state file
// (its Current Stage among it), and a pull request built from that branch by
// hand brings it to main: main's state then read `Current Stage:
// code-generation`. The plan-approval guard took that Current Stage as Code
// Generation being the step, so in the main checkout, and in every worktree cut
// from main, each edit and most shell writes outside AI-DLC's records were
// refused ("the current state has no matching v2 code-generation active
// directive"), with the plan-approval setting no way out.
//
// In a team-owned intent a checkout with no Unit scope (the main checkout, a
// worktree cut from main) is not building Code Generation whatever its Current
// Stage says; only a step the engine issued there makes it the step. A claimed
// Unit's checkout, and a solo intent, are judged as before.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import { cleanupTempDirs, git, makeSeed, prepareCandidate, tempDirs } from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const BUN = process.execPath;
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");

function guardEdit(checkout: string): { code: number; stderr: string } {
  const run = spawnSync(BUN, [GUARD], {
    cwd: checkout,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(checkout, "src", "shared.ts"), old_string: "base", new_string: "side" },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
  });
  return { code: run.status ?? -1, stderr: run.stderr ?? "" };
}

// Main's state as a hand-built pull request of a Unit's branch leaves it.
function carryUnitWalk(checkout: string, ownership = "team"): void {
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation")
      .replace(/^- \*\*Unit Ownership\*\*: .*$/m, `- **Unit Ownership**: ${ownership}`),
  );
  git(checkout, ["commit", "-qam", "Merge a Unit's branch by hand"]);
}

describe("t-team-unit-main-not-building: a team main checkout is not building Code Generation", () => {
  test("the main checkout and a worktree cut from main take side work; a claimed Unit's checkout is still guarded", () => {
    const { seed, remote } = makeSeed();
    carryUnitWalk(seed);
    const onMain = guardEdit(seed);
    expect(onMain.stderr).not.toContain("no matching v2 code-generation active directive");
    expect(onMain.code, onMain.stderr).toBe(0);

    const worktree = mkdtempSync(join(tmpdir(), "aidlc-main-wt-"));
    rmSync(worktree, { recursive: true, force: true });
    tempDirs.push(worktree);
    git(seed, ["worktree", "add", "-q", "-b", "side-work", worktree, "HEAD"]);
    const inWorktree = guardEdit(worktree);
    expect(inWorktree.code, inWorktree.stderr).toBe(0);

    const { checkout } = prepareCandidate(remote, "alpha", "alpha-team");
    const statePath = seededStateFile(checkout);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
    );
    const claimed = guardEdit(checkout);
    expect(claimed.code).toBe(2);
    expect(claimed.stderr).toContain("no matching v2 code-generation active directive");
  });

  test("a solo intent at Code Generation is guarded as before", () => {
    const { seed } = makeSeed();
    carryUnitWalk(seed, "solo");
    const solo = guardEdit(seed);
    expect(solo.code).toBe(2);
    expect(solo.stderr).toContain("no matching v2 code-generation active directive");
  });
});
