import { createOpenAI } from "@ai-sdk/openai";
import { getEncoding } from "js-tiktoken";

import { RecursiveCharacterTextSplitter } from "../ai/text-splitter";

export const AI_MODEL_DISPLAY = {
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    logo: "/providers/openai.webp",
    vision: true,
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    logo: "/providers/openai.webp",
    vision: true,
  },
  "o3-mini": {
    id: "o3-mini",
    name: "o3 mini",
    logo: "/providers/openai.webp",
    vision: false,
  },
} as const;

export type AIModel = keyof typeof AI_MODEL_DISPLAY;
export type AIModelDisplayInfo = (typeof AI_MODEL_DISPLAY)[AIModel];

export const availableModels = Object.values(AI_MODEL_DISPLAY);

// Create a base openai client for convenience
const openai = createOpenAI({
  apiKey: process.env.OPENAI_KEY || "",
});

// Helper to create a model with the given ID & key
export function createModel(modelId: AIModel, apiKey?: string) {
  const client = createOpenAI({
    apiKey: apiKey || process.env.OPENAI_KEY || "",
  });

  return client(modelId, {
    structuredOutputs: true,
    // E.g. for "o3-mini", we can set reasoningEffort: "medium"
    ...(modelId === "o3-mini" ? { reasoningEffort: "medium" } : {}),
  });
}

// Token calculations for splitting text (optional)
const MinChunkSize = 140;
const encoder = getEncoding("o200k_base");

export function trimPrompt(prompt: string, contextSize = 120_000) {
  if (!prompt) return "";
  const length = encoder.encode(prompt).length;
  if (length <= contextSize) return prompt;

  const overflowTokens = length - contextSize;
  // ~3 characters per token as a rough guess
  const chunkSize = prompt.length - overflowTokens * 3;
  if (chunkSize < MinChunkSize) {
    return prompt.slice(0, MinChunkSize);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: 0,
  });
  const trimmedPrompt = splitter.splitText(prompt)[0] ?? "";
  if (trimmedPrompt.length === prompt.length) {
    return trimPrompt(prompt.slice(0, chunkSize), contextSize);
  }

  return trimPrompt(trimmedPrompt, contextSize);
}
