import {
  type ActiveDirectiveMarker,
  codeGenerationIsTheStep,
  getField,
  isTeamUnitOwnership,
  readApplicableTeamUnitScopeStamp,
} from "./aidlc-lib.ts";
import { codeGenerationStepOnRecord } from "./aidlc-testing-posture.ts";

// codeGenerationStepOnRecord for the checkout at projectDir. Under team
// ownership a Unit's Code Generation is built only in the checkout that claimed
// it, and a Unit's branch carries its walk's Current Stage: a pull request built
// from it by hand leaves main reading code-generation. A checkout of a
// team-owned intent with no Unit scope of its own (the main checkout, a worktree
// cut from main) is therefore not building whatever its Current Stage says; only
// a step the engine issued there makes Code Generation the step.
export function codeGenerationIsTheStepHere(
  projectDir: string,
  stateContent: string,
  marker: ActiveDirectiveMarker | null,
): boolean {
  if (!codeGenerationStepOnRecord(projectDir, stateContent, marker)) return false;
  const unscopedTeam = isTeamUnitOwnership(stateContent) &&
    getField(stateContent, "Construction Iteration")?.trim() === "unit-major" &&
    readApplicableTeamUnitScopeStamp(projectDir, stateContent) === null;
  return !unscopedTeam || codeGenerationIsTheStep(marker?.stage ?? "", "");
}
