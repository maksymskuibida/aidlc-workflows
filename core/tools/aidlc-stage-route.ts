// The stage a stage still needs before it can run: a requirement the plan runs
// that never started. aidlc-lib.ts loads this module at start: nothing here may
// import it, so the per-Unit test (lib's isPerUnitStage) is passed in.

// The first stage `stage` requires that runs once after its phase's per-Unit
// block and before run position `cursor`, whose row reads not started ([ ])
// although the plan runs it, or null: an engine that walked number order left
// a team fold past Build and Test like that. Done and skipped rows, a SKIP in
// the plan, and a stage with no row (or not in the graph) count as settled; a
// stage at or after the cursor is work a walk is projecting past, such as the
// stages one late approval covers. A per-Unit stage is left to its Unit walk,
// whose rows are a projection. A stage the work left behind anywhere else (a
// scope change's, Reverse Engineering left out at the plan pick) keeps the
// rules it has (stagesOwedBehindCursor).
export function unstartedRequirement<
  T extends { slug: string; phase: string; for_each?: string; requires_stage?: string[] },
>(
  stage: T,
  cursor: number,
  graph: readonly T[],
  checkboxStates: readonly { slug: string; state: string }[],
  stateOverrides: Map<string, "EXECUTE" | "SKIP"> | null,
  mapping: { stages: Record<string, string> },
  isPerUnitStage: (stage: T) => boolean,
): T | null {
  const required = new Set(stage.requires_stage ?? []);
  const blockEnd = graph.findLastIndex((s) => s.phase === stage.phase && isPerUnitStage(s));
  if (required.size === 0 || cursor === -1 || isPerUnitStage(stage) || blockEnd === -1) return null;
  for (const candidate of graph.slice(blockEnd + 1, cursor)) {
    if (!required.has(candidate.slug)) continue;
    if (checkboxStates.find((c) => c.slug === candidate.slug)?.state !== "pending") continue;
    if ((stateOverrides?.get(candidate.slug) ?? mapping.stages[candidate.slug]) !== "EXECUTE") continue;
    return candidate;
  }
  return null;
}
