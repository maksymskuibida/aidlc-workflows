// A Unit's own stage diary under team ownership, read by the run-stage
// directive and the learnings step.
import { isTeamUnitOwnership, relativeSpaceRecordPrefix } from "./aidlc-lib.ts";
import { isPerUnitStage } from "./aidlc-stage-route.ts";

// Under Unit Ownership: team a Unit's per-Unit stage runs in the Unit's claimed
// checkout, which lands only the Unit's own record tree (pin refuses a
// stage-level diary), so its diary is `<prefix>/construction/<unit>/<stage>/memory.md`,
// the path a per-Unit wave entry already writes. Null when the stage-level
// diary applies. The run-stage directive and the learnings step both read it here.
export function teamUnitMemoryPath(
  stage: { slug: string; for_each?: string },
  unit: string | null,
  stateContent: string | null,
  recordPrefix?: string | null,
): string | null {
  if (!unit || !isTeamUnitOwnership(stateContent) || !isPerUnitStage(stage)) return null;
  return unitMemoryPath(stage.slug, unit, recordPrefix);
}

// `<prefix>/construction/<unit>/<stage>/memory.md`: one Unit's own diary for a
// per-Unit stage, the one path every caller builds it from.
export function unitMemoryPath(stageSlug: string, unit: string, recordPrefix?: string | null): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  return `${prefix}/construction/${unit}/${stageSlug}/memory.md`;
}
