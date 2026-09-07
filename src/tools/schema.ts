import { z } from "zod";
import type { JsonSchema } from "../core/model-provider.js";

export function jsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _, ...portableSchema } = z.toJSONSchema(schema);
  return portableSchema as JsonSchema;
}
