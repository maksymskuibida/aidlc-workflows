// covers: subcommand:aidlc-jump:execute, subcommand:aidlc-state:skip
//
// A team-owned Unit's design stages the person leaves out are skipped for that
// Unit with one forward jump in its claimed checkout, right after the claim:
// each named stage gets the Unit's UNIT_SKIPPED, the walk goes to the first
// stage left in, Unit Progress shows the skipped stages as [S], and the other
// Units still owe them.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

function claimed(unit: string, rhythm: "per-stage" | "unit-end"): string {
  const { remote } = makeSeed(parallelDependencyBody());
  const checkout = clone(remote, `${unit}-team`);
  const claim = runMergeTool(UNIT, ["claim", unit, "--team", `${unit}-team`, "--rhythm", rhythm], checkout);
  expect(claim.status, claim.out).toBe(0);
  const path = seededStateFile(checkout);
  writeFileSync(
    path,
    readFileSync(path, "utf-8").replace("## Project Information\n", "## Project Information\n- **Skeleton Stance**: on\n"),
  );
  return checkout;
}

function jumpSkipping(checkout: string, unit: string, stages: string[]): void {
  const jumped = runMergeTool(
    JUMP,
    ["execute", "--target", "code-generation", "--direction", "forward", "--units", unit, "--stages", stages.join(",")],
    checkout,
  );
  expect(jumped.status, jumped.out).toBe(0);
  expect(JSON.parse(jumped.stdout)).toMatchObject({ units: [unit], stages_skipped: stages });
}

function skipReceipts(checkout: string): string[] {
  const dir = seededAuditDir(checkout);
  return readdirSync(dir)
    .flatMap((file) => readFileSync(join(dir, file), "utf-8").split("\n## ").filter((block) => block.includes("UNIT_SKIPPED")))
    .map((block) => `${block.match(/\*\*Stage\*\*: (\S+)/)?.[1]}/${block.match(/\*\*Unit\*\*: (\S+)/)?.[1]}`);
}

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2, 7);
}

const DESIGN = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];

describe("t-team-unit-jump-skip: a claimed Unit's left-out stages are skipped with one jump", () => {
  for (const rhythm of ["per-stage", "unit-end"] as const) {
    test(`every design stage left out (${rhythm}): the walk goes straight to Code Generation`, () => {
      const checkout = claimed("alpha", rhythm);
      jumpSkipping(checkout, "alpha", DESIGN);
      expect(skipReceipts(checkout)).toEqual(DESIGN.map((stage) => `${stage}/alpha`));
      expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
      expect(cells(checkout, "alpha")).toEqual(["[S]", "[S]", "[S]", "[S]", "[ ]"]);
      expect(cells(checkout, "beta")).toEqual(["[ ]", "[ ]", "[ ]", "[ ]", "[ ]"]);
    });
  }

  test("only Functional Design kept: the jump at claim skips the rest and Functional Design runs first", () => {
    const checkout = claimed("alpha", "per-stage");
    jumpSkipping(checkout, "alpha", DESIGN.slice(1));
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    expect(cells(checkout, "alpha")).toEqual(["[ ]", "[S]", "[S]", "[S]", "[ ]"]);
  });

  test("stages left out with gaps: each kept stage runs in order, each left-out one is skipped", () => {
    const checkout = claimed("alpha", "per-stage");
    jumpSkipping(checkout, "alpha", ["functional-design", "nfr-design"]);
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
    expect(cells(checkout, "alpha")).toEqual(["[S]", "[ ]", "[S]", "[ ]", "[ ]"]);
  });
});
