// Write one stage's produces for a Unit (fixture content), the artifacts a run-stage would produce.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [checkout, unit, slug] = process.argv.slice(2);
process.chdir(checkout);
const lib = await import(join(checkout, ".claude/tools/aidlc-lib.ts"));
const posture = await import(join(checkout, ".claude/tools/aidlc-testing-posture.ts"));
const record = join(checkout, "aidlc/spaces/default/intents/261015-demo-1-uniform-test");
const stage = lib.loadStageGraphAll().find((e: { slug: string }) => e.slug === slug)!;
const dir = join(record, "construction", unit, slug);
mkdirSync(dir, { recursive: true });
for (const name of stage.produces ?? []) writeFileSync(join(dir, lib.artifactFilename(name)), `# ${name}\n\n${unit} ${slug}\n`);
if (slug === "code-generation") {
  const contract = posture.resolveTestingPosture(checkout);
  writeFileSync(join(dir, "code-generation-plan.md"), `# Code Generation Plan\n\n${posture.renderTestingContract(contract)}\n## Steps\n\n- [x] Implement the Unit.\n`);
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\n## Command\n\n`pytest`\n");
}
console.log(JSON.stringify({ unit, slug, produces: (stage.produces ?? []).length }));
