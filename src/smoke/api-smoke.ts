#!/usr/bin/env node
import { OpenAICompatibleProvider } from "../core/openai-provider.js";
import { loadDotEnv } from "../utils/env.js";

await loadDotEnv(process.cwd());

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = emptyToUndefined(process.env.OPENAI_BASE_URL);
const model = emptyToUndefined(process.env.OPENAI_MODEL);

if (!apiKey) {
  console.error("Missing OPENAI_API_KEY.");
  process.exit(1);
}

const provider = new OpenAICompatibleProvider({ apiKey, baseURL, model });
const chat = await provider.createMessage({
  messages: [{ role: "user", content: "Return only: ok" }],
  temperature: 0,
  maxOutputTokens: 8,
});
const chatText = chat.content.trim();
console.log(`API_CHAT content=${JSON.stringify(chatText)}`);

let streamText = "";
for await (const event of provider.createMessageStream({
  messages: [{ role: "user", content: "Return only: ok" }],
  temperature: 0,
  maxOutputTokens: 8,
})) {
  if (event.type === "text_delta") {
    streamText += event.delta;
  }
}
console.log(`API_STREAM content=${JSON.stringify(streamText.trim())}`);

const toolResult = await forcedToolCall({
  apiKey,
  baseURL,
  model: model ?? "gpt-4.1-mini",
});
console.log(
  `API_TOOL name=${toolResult.name} args=${toolResult.arguments}`,
);

if (chatText !== "ok" || streamText.trim() !== "ok" || toolResult.name !== "add_numbers") {
  process.exitCode = 1;
}

async function forcedToolCall(input: {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
}): Promise<{ name: string; arguments: string }> {
  const apiBase = getApiBaseURL(input.baseURL);
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "user", content: "Call add_numbers with a=2 and b=5." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "add_numbers",
            description: "Add two numbers.",
            parameters: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "add_numbers" } },
      temperature: 0,
      max_tokens: 32,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Tool smoke failed with ${response.status}: ${text.slice(0, 300)}`);
  }

  const parsed = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const toolCall = parsed.choices?.[0]?.message?.tool_calls?.[0]?.function;
  return {
    name: toolCall?.name ?? "",
    arguments: toolCall?.arguments ?? "",
  };
}

function getApiBaseURL(baseURL: string | undefined): string {
  const value = baseURL ?? "https://api.openai.com/v1";
  const normalized = value.replace(/\/$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
