import { generateObject } from "ai";
import { z } from "zod";

import { createModel, type AIModel } from "./ai/providers";
import { systemPrompt } from "./prompt";

/**
 * Provide clarifying questions that help shape an overarching goal,
 * subtopics, and sub-subtopics for the multi-step research agent.
 */
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
  const model = createModel(modelId, apiKey);

  const userFeedback = await generateObject({
    model,
    system: systemPrompt(),
    prompt: `
The user has provided an initial query for a multi-step research agent. 
This agent will:
1) Identify an overarching goal (the "WHY" of the research).
2) Break the query into subtopics, each with a unique purpose and sub-subtopics (success criteria).
3) Research each subtopic in parallel, focusing on only the relevant info. 
4) Merge everything in a final integrated report.

We want up to ${numQuestions} clarifying questions that help refine:
- The overarching goal
- The subtopics
- The sub-subtopics or success criteria
- The scope or target audience

Return exactly JSON:
{
  "questions": ["q1", "q2", ...]
}

User Query:
<query>${query}</query>
`,
    schema: z.object({
      questions: z.array(z.string()),
    }),
  });

  return userFeedback.object.questions.slice(0, numQuestions);
}
