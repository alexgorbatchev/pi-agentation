#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const sourceSkillPath = path.join(
  path.dirname(require.resolve("@alexgorbatchev/agentation-skills/package.json", { paths: [packageRoot] })),
  "skills",
  "agentation-fix-loop",
  "SKILL.md"
);
const targetSkillPath = path.join(packageRoot, "skills", "agentation-fix-loop", "SKILL.md");

const sourceSkillContent = fs.readFileSync(sourceSkillPath);
const currentTargetContent = fs.existsSync(targetSkillPath) ? fs.readFileSync(targetSkillPath) : null;

if (currentTargetContent !== null && Buffer.compare(sourceSkillContent, currentTargetContent) === 0) {
  process.stdout.write("Skill is already in sync\n");
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetSkillPath), { recursive: true });
fs.writeFileSync(targetSkillPath, sourceSkillContent);
process.stdout.write("Synced skills/agentation-fix-loop/SKILL.md from @alexgorbatchev/agentation-skills\n");
