// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land
//
// A Unit reopened (`claim --reopen`) in the checkout that ran the earlier
// phases and built its landed attempt. That checkout's own shard is on main,
// and it went on writing rows there after the landing. Publish once refused
// such a reopen ("cannot move its audit rows: ... already exists on this
// branch"), when a claim took a team shard named for its attempt. Claimed here
// now, the attempt keeps its rows in a shard of its own claim and publish
// carries every other shard as main has it, so the reopened attempt publishes,
// pins and lands, and main keeps the checkout's rows as it had them.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dirname, join } from "node:path";
import {
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const AUDIT = join(dirname(UNIT), "aidlc-audit.ts");
const WHY = "the reviewer asked for a smaller API";

// A row the engine writes in whichever shard the checkout writes now, as a
// guard writes it (the audit CLI takes a guard's row only with the test switch).
function logRow(checkout: string, reason: string): void {
  const logged = runMergeTool(
    AUDIT, ["append", "GUARD_STOOD_ASIDE", "--field", `Reason=${reason}`], checkout, false,
    { AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" },
  );
  expect(logged.status, logged.out).toBe(0);
}

describe("t-team-unit-reopen-same-checkout: a Unit reopened where it was built", () => {
  test("publishes, pins and lands, with the checkout's rows written after its landing", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    const checkout = clone(remote, "alpha-team");
    logRow(checkout, "the earlier phases ran here");
    git(checkout, ["add", "-A"]);
    git(checkout, ["commit", "-m", "the earlier phases' record"]);
    git(checkout, ["push", "origin", "main"]);

    const first = prepareCandidate(remote, "alpha", "alpha-team", { checkout });
    git(seed, ["pull", "--ff-only"]);
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);

    // The checkout goes on after the landing, then brings main in.
    logRow(checkout, "after the landing");
    git(checkout, ["fetch", "origin"]);
    git(checkout, ["merge", "--no-edit", "origin/main"]);
    git(checkout, ["add", "-A"]);
    git(checkout, ["commit", "--allow-empty", "-m", "the checkout's rows"]);

    const second = prepareCandidate(remote, "alpha", "alpha-team", {
      checkout,
      claimArgs: ["--reopen", "--user-input", WHY],
    });
    expect(second.generation).toBe(2);
    expect(second.auditShard).not.toBe(first.auditShard);
    git(seed, ["fetch", "origin"]);
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toContain("alpha-team");
  });
});
