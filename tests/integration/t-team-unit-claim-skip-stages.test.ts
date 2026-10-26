// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-orchestrate:next
//
// `unit claim <unit> --skip-stages <stages>` leaves the named per-Unit
// Construction stages out for that Unit at the moment it is claimed: each gets
// the Unit's UNIT_SKIPPED record right away, Unit Progress shows them [S], the
// Unit's walk starts at the first stage left in, and the other Units still owe
// them. With no flag the claim is as before. A stage that is not one of the
// plan's per-Unit stages, or Code Generation, refuses the claim before anything
// is claimed. `/aidlc --claim` passes the flag on.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LEFT_OUT = ["nfr-requirements", "nfr-design", "infrastructure-design"];

function team(): { remote: string; checkout: string } {
  const { remote } = makeSeed(parallelDependencyBody());
  const checkout = clone(remote, "alpha-team");
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8").replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n"),
  );
  return { remote, checkout };
}

function claim(checkout: string, extra: string[]) {
  return runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team", ...extra], checkout);
}

function skipReceipts(checkout: string): string[] {
  const dir = seededAuditDir(checkout);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((file) => readFileSync(join(dir, file), "utf-8").split("\n## ").filter((block) => block.includes("UNIT_SKIPPED")))
    .map((block) => `${block.match(/\*\*Stage\*\*: (\S+)/)?.[1]}/${block.match(/\*\*Unit\*\*: (\S+)/)?.[1]}`);
}

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2, 7);
}

describe("t-team-unit-claim-skip-stages: a claim leaves the person's left-out stages out at once", () => {
  test("the named stages are skipped for the Unit at claim, and its walk starts at Functional Design", () => {
    const { checkout } = team();
    const claimed = claim(checkout, ["--skip-stages", "infrastructure-design,nfr-requirements,nfr-design"]);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true, unit: "alpha", skipped_stages: LEFT_OUT });
    expect(skipReceipts(checkout)).toEqual(LEFT_OUT.map((stage) => `${stage}/alpha`));
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    expect(cells(checkout, "alpha")).toEqual(["[ ]", "[S]", "[S]", "[S]", "[ ]"]);
    expect(cells(checkout, "beta")).toEqual(["[ ]", "[ ]", "[ ]", "[ ]", "[ ]"]);
  });

  test("with no flag the claim is as before: nothing skipped", () => {
    const { checkout } = team();
    const claimed = claim(checkout, []);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout).skipped_stages).toBeUndefined();
    expect(skipReceipts(checkout)).toEqual([]);
  });

  for (const [named, said] of [
    ["code-generation", "cannot leave out code-generation"],
    ["nfr-requirements,build-and-test", "not one of this plan's per-Unit Construction stages"],
  ] as const) {
    test(`--skip-stages ${named} refuses the claim and claims nothing`, () => {
      const { checkout } = team();
      const refused = claim(checkout, ["--skip-stages", named]);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(said);
      expect(refused.out).toContain("Nothing was claimed");
      // Nothing was claimed: the same claim without the flag goes through as a first claim.
      const claimed = claim(checkout, []);
      expect(claimed.status, claimed.out).toBe(0);
      expect(JSON.parse(claimed.stdout).recovered).toBeUndefined();
    });
  }

  test("/aidlc --claim passes --skip-stages on to the claim", () => {
    const { checkout } = team();
    const routed = runMergeTool(ORCH, ["next", "--claim", "alpha", "--skip-stages", LEFT_OUT.join(",")], checkout);
    expect(routed.status, routed.out).toBe(0);
    expect(routed.stdout).toContain(`--claim alpha --skip-stages ${LEFT_OUT.join(",")}`);
  });

  test("the full flow: claim with the flag, Functional Design and Code Generation, then pin, gate and land", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { claimSkipStages: LEFT_OUT });
    gateAndLand(seed, "alpha");
    const row = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(row.slice(2, 7)).toEqual(["[x]", "[S]", "[S]", "[S]", "[x]"]);
  });
});
