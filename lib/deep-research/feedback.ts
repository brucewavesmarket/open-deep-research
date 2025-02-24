import { generateObject } from "ai";
import { z } from "zod";

import { createModel, type AIModel } from "./ai/providers";
import { systemPrompt } from "./prompt";

export async function generateFeedback({
  query,
  numQuestions = 3,
  modelId = "o3-mini",
  apiKey,
}: {
  query: string;
  numQuestions?: number;
  modelId?: AIModel;
  apiKey?: string;
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing API key in environment variables.");
  }

  const model = createModel(modelId, apiKey);

  const userFeedback = await generateObject({
    model,
    system: systemPrompt(),
    prompt: `Given the following user query, ask up to ${numQuestions} short follow-up questions to clarify what aspects of the topic they want to explore further.

Respond in this JSON format:
{
  "questions": [
    "question1",
    "question2",
    ...
  ]
}

<query>${query}</query>
`,
    schema: z.object({
      questions: z.array(z.string()),
    }),
  });

  return userFeedback.object.questions.slice(0, numQuestions);
}
