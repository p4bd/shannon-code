import { z } from "zod";
import { fail, ok } from "./result.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";

const DEFAULT_MAX_LENGTH = 50_000;
const MAX_LENGTH = 200_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const webFetchInput = z.object({
  url: z.string().url().describe("HTTP or HTTPS URL to fetch."),
  maxLength: z.number().int().positive().max(MAX_LENGTH).optional().describe(`Maximum response characters to return, max ${MAX_LENGTH}.`),
});

type WebFetchInput = z.infer<typeof webFetchInput>;

export const webFetchTool: Tool<WebFetchInput> = {
  name: "web_fetch",
  description:
    "Fetch an HTTP or HTTPS URL and return readable text. HTML responses are converted to plain text.",
  inputSchema: jsonSchema(webFetchInput),
  inputValidator: webFetchInput,
  safety: "network",
  readOnly: true,
  requiresApproval: false,
  async execute(input, ctx) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(input.url, {
        signal: ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, controller.signal])
          : controller.signal,
        redirect: "follow",
      });
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const text = contentType.toLowerCase().includes("html")
        ? htmlToText(raw)
        : raw;
      const maxLength = input.maxLength ?? DEFAULT_MAX_LENGTH;
      const truncated = text.length > maxLength;
      const content = truncated ? `${text.slice(0, maxLength)}\n...[truncated]` : text;

      if (!response.ok) {
        return fail({
          code: "NetworkError",
          message: `HTTP ${response.status} fetching ${input.url}`,
          content,
          recoverable: true,
          details: {
            url: input.url,
            status: response.status,
            statusText: response.statusText,
          },
        });
      }

      return ok(content, {
        url: input.url,
        status: response.status,
        contentType,
        truncated,
      });
    } catch (error) {
      ctx.abortSignal?.throwIfAborted();
      return fail({
        code: "NetworkError",
        message:
          error instanceof Error
            ? `Failed to fetch ${input.url}: ${error.message}`
            : `Failed to fetch ${input.url}`,
        recoverable: true,
        details: { url: input.url },
      });
    } finally {
      clearTimeout(timeout);
    }
  },
};

function htmlToText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
