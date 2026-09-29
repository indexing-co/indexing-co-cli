const fs = require("node:fs");
const path = require("node:path");

import { getHomeDirectory, getPackageRoot } from "./constants";

export const SKILL_NAME = "indexing-co-pipelines";

export function getBundledSkillPath(): string {
  return path.join(getPackageRoot(), "skills", SKILL_NAME, "SKILL.md");
}

export function getClaudeSkillPath(env: Record<string, string | undefined> = process.env): string {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(getHomeDirectory(env), ".claude");
  return path.join(claudeDir, "skills", SKILL_NAME, "SKILL.md");
}

export interface SkillInstallResult {
  skill: string;
  source: string;
  destination: string;
  status: "installed" | "updated" | "unchanged";
}

export function installSkill(destination: string, source = getBundledSkillPath()): SkillInstallResult {
  const contents = fs.readFileSync(source, "utf8");
  let status: SkillInstallResult["status"] = "installed";

  if (fs.existsSync(destination)) {
    if (fs.readFileSync(destination, "utf8") === contents) {
      return { skill: SKILL_NAME, source, destination, status: "unchanged" };
    }
    status = "updated";
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
  return { skill: SKILL_NAME, source, destination, status };
}
