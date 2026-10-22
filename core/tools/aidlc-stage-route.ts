// The order the work runs the stages in, and the stage a stage still needs
// before it can run: which stages run once per Unit of Work, the run order that
// keeps a phase's per-Unit stages together, and a requirement the plan runs
// that never started. aidlc-lib.ts loads this module at start: nothing here
// may import it.

// The per-unit marker carried by the Construction stages that run once per
// Unit of Work. It lives on the stage's `for_each` field (stage frontmatter,
// compiled onto the GraphStage and into stage-graph.json). The canonical
// 5-stage set (nfr-requirements, nfr-design, functional-design,
// infrastructure-design, code-generation) is the defensive cross-check; the
// node's own `for_each` is the source of truth so a future per-unit stage is
// picked up without editing this file. Exported so both the runtime resolver
// (isPerUnit in aidlc-orchestrate.ts) and the cost summary (gridCostSummary
// in aidlc-lib.ts) resolve per-unit identically.
export const PER_UNIT_FOR_EACH = "unit-of-work";
export const KNOWN_PER_UNIT_STAGES: ReadonlySet<string> = new Set([
  "nfr-requirements",
  "nfr-design",
  "functional-design",
  "infrastructure-design",
  "code-generation",
]);

// True when a stage runs once per Unit of Work. Reads the node's own
// `for_each` marker (source of truth); the known-set membership is a defensive
// cross-check so a typo'd marker on one of the five canonical stages still
// resolves per-unit. Structural param so both a GraphStage and a bare
// {slug, for_each} record satisfy it.
export function isPerUnitStage(e: { slug: string; for_each?: string }): boolean {
  return e.for_each === PER_UNIT_FOR_EACH || KNOWN_PER_UNIT_STAGES.has(e.slug);
}

// The order the work runs the stages in, which every walk (the next stage, the
// solo Unit walk, the team fold, the next-stage hint, the plan listing) reads
// through loadStageGraph. It is graph-number order, except that a phase's
// per-Unit stages run as one block, where its first per-Unit stage stands: each
// Unit walks the block, and the stages that run once per intent come after it.
// Numbers are pinned and a plugin's new stage is numbered past its phase's
// highest (compileStageGraph), so a plugin's per-Unit stage can be numbered
// after Build and Test; it still runs with its Unit. compileStageGraph refuses
// a graph whose requires_stage edges this order would break.
export function stageRouteOrder<T extends { slug: string; number: string; phase: string; for_each?: string }>(
  stages: readonly T[],
): T[] {
  const key = (n: string | undefined) => String(n ?? "").split(".").map((x) => parseInt(x, 10));
  const byNumber = [...stages].sort((a, b) => {
    const [aPhase, aIndex] = key(a.number);
    const [bPhase, bIndex] = key(b.number);
    return aPhase - bPhase || aIndex - bIndex;
  });
  const routed: T[] = [];
  const placed = new Set<T>();
  for (const stage of byNumber) {
    if (placed.has(stage)) continue;
    if (isPerUnitStage(stage)) {
      for (const member of byNumber) {
        if (member.phase === stage.phase && isPerUnitStage(member)) {
          routed.push(member);
          placed.add(member);
        }
      }
    } else {
      routed.push(stage);
      placed.add(stage);
    }
  }
  return routed;
}

// The first stage `stage` requires, in run order before run position `cursor`,
// whose row reads not started ([ ]) although the plan runs it, or null: an
// engine that walked number order left a team fold past Build and Test like
// that. Done and skipped rows, a SKIP in the plan, and a stage with no row (or
// not in the graph) count as settled; a stage at or after the cursor is work a
// walk is projecting past, such as the stages one late approval covers. A
// per-Unit stage is left to its Unit walk, whose rows are a projection.
export function unstartedRequirement<T extends { slug: string; for_each?: string; requires_stage?: string[] }>(
  stage: T,
  cursor: number,
  graph: readonly T[],
  checkboxStates: readonly { slug: string; state: string }[],
  stateOverrides: Map<string, "EXECUTE" | "SKIP"> | null,
  mapping: { stages: Record<string, string> },
): T | null {
  const required = new Set(stage.requires_stage ?? []);
  if (required.size === 0 || cursor === -1 || isPerUnitStage(stage)) return null;
  for (const candidate of graph.slice(0, cursor)) {
    if (!required.has(candidate.slug)) continue;
    if (checkboxStates.find((c) => c.slug === candidate.slug)?.state !== "pending") continue;
    if ((stateOverrides?.get(candidate.slug) ?? mapping.stages[candidate.slug]) !== "EXECUTE") continue;
    return candidate;
  }
  return null;
}
