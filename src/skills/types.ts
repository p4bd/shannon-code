export type SkillMode = "inline" | "fork";

export interface Skill {
  name: string;
  description: string;
  allowedTools?: string[];
  mode: SkillMode;
  path: string;
  content: string;
}
