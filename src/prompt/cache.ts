import type {
  ModelPromptCacheControl,
  ModelPromptSection,
} from "../core/model-provider.js";
import { sha256 } from "../utils/hash.js";

export function createPromptCacheControl(
  sections: ModelPromptSection[],
): ModelPromptCacheControl | undefined {
  const cacheable = sections.filter(
    (section) => section.cacheable && section.content.trim().length > 0,
  );
  if (cacheable.length === 0) {
    return undefined;
  }

  return {
    type: "ephemeral",
    key: sha256(
      cacheable
        .map((section) => `${section.name}\n${section.content}`)
        .join("\n\n---\n\n"),
    ),
    sectionNames: cacheable.map((section) => section.name),
  };
}

