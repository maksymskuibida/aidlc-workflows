// covers: function:evaluateGuardRefusal, function:guardRecoveryAskForRefusal, function:validateDirective
//
// Contract test: a Unit's stage being revised stays finishable from the Unit's
// own checkout. Before, the revising state offered only finishing the revision
// (which needs the receipt or the review that is missing, so it asks again)
// and a stage restart. After, the completion is offered while revising when it
// is missing, and the revision's own review stays executable, so the way to
// the gate is always one of the remedies on offer. mechanism = pure.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/): aidlc-lib.ts
// evaluateGuardRefusal / guardRecoveryAskForRefusal; aidlc-directive.ts
// validateDirective.

import { describe, expect, test } from "bun:test";
import {
  evaluateGuardRefusal,
  guardRecoveryAskForRefusal,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";

const SLUG = "functional-design";
const SEP = "\u2014";

describe("a revising Unit stays finishable from its own checkout", () => {
  test("1: a revising team gate with the completion missing offers recording it first", () => {
    const refusal = evaluateGuardRefusal({
      code: "UNIT_COMPLETION_MISSING",
      blockedAction: "present-approval-gate",
      stage: SLUG,
      unit: "alpha",
      stateContent: `# State\n- **Unit Ownership**: team\n- [-] ${SLUG} ${SEP} EXECUTE\n`,
      invariant: "The Unit lifecycle is complete in the current attempt.",
      userMessage: "no current UNIT_COMPLETED receipt is recorded.",
      attempt: {
        recovery: "available",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
      teamGate: { resolved: true, scope: "per-stage", status: "revising", gateStage: SLUG },
    });
    expect(refusal.state).toBe("revising");
    expect(refusal.remedies.map((remedy) => remedy.op).slice(0, 2)).toEqual([
      "record-unit-completion",
      "finish-revision",
    ]);
    expect(refusal.remedies[0]).toMatchObject({
      requiresHuman: true,
      executableNow: true,
      operation: { kind: "record-unit-completion", stage: SLUG, unit: "alpha" },
    });
    const ask = guardRecoveryAskForRefusal(refusal);
    expect(ask).not.toBeNull();
    const checked = validateDirective(ask);
    expect(checked.valid ? [] : checked.errors).toEqual([]);
    for (const remedy of refusal.remedies) {
      if (remedy.operation) expect(remedy.requiresHuman, remedy.op).toBe(true);
    }
  });

  test("2: a revising team gate with the review evidence missing offers the next review first", () => {
    const refusal = evaluateGuardRefusal({
      code: "REVIEW_EVIDENCE_MISSING",
      blockedAction: "present-approval-gate",
      stage: SLUG,
      unit: "alpha",
      stateContent: `# State\n- **Unit Ownership**: team\n- [-] ${SLUG} ${SEP} EXECUTE\n`,
      invariant: "The current attempt has review evidence.",
      userMessage: "no review covers the current attempt.",
      attempt: {
        recovery: "available",
        summaryCoverage: "current",
        reviewCoverage: "missing",
        sourceCoverage: "current",
        nextReview: { iteration: 1, request: "aidlc engine log review --stage functional-design --unit alpha --iteration 1" },
      },
      humanAuthority: { freshTurn: true, unattended: false },
      teamGate: { resolved: true, scope: "per-stage", status: "revising", gateStage: SLUG },
    });
    expect(refusal.state).toBe("revising");
    expect(refusal.remedies.map((remedy) => remedy.op).slice(0, 2)).toEqual(["request-review", "finish-revision"]);
    expect(refusal.remedies[0]).toMatchObject({ requiresHuman: false, executableNow: true });
    const ask = guardRecoveryAskForRefusal(refusal);
    expect(ask).not.toBeNull();
    const checked = validateDirective(ask);
    expect(checked.valid ? [] : checked.errors).toEqual([]);
  });

  test("3: a revising team gate with a stale review and the recovery left offers that review first", () => {
    const refusal = evaluateGuardRefusal({
      code: "REVIEW_EVIDENCE_MISSING",
      blockedAction: "present-approval-gate",
      stage: SLUG,
      unit: "alpha",
      stateContent: `# State\n- **Unit Ownership**: team\n- [-] ${SLUG} ${SEP} EXECUTE\n`,
      invariant: "The current attempt has review evidence.",
      userMessage: "the recorded review no longer covers the current bytes.",
      attempt: {
        recovery: "available",
        summaryCoverage: "current",
        reviewCoverage: "stale",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
      teamGate: { resolved: true, scope: "per-stage", status: "revising", gateStage: SLUG },
    });
    expect(refusal.state).toBe("revising");
    expect(refusal.remedies.map((remedy) => remedy.op).slice(0, 2)).toEqual(["start-recovery-review", "finish-revision"]);
    expect(refusal.remedies[0]).toMatchObject({ requiresHuman: false, executableNow: true });
    const ask = guardRecoveryAskForRefusal(refusal);
    expect(ask).not.toBeNull();
    expect(validateDirective(ask).valid).toBe(true);
  });

});
