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

/**
 * Process user responses to feedback questions, preparing them for research
 */
export async function processFeedbackResponses({
  query,
  questionResponsePairs,
  modelId = "o3-mini",
  apiKey,
}: {
  query: string;
  questionResponsePairs: Array<{ question: string; response: string }>;
  modelId?: AIModel;
  apiKey?: string;
}) {
  if (questionResponsePairs.length === 0) {
    return [];
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing API key in environment variables.");
  }

  const model = createModel(modelId, apiKey);

  // Optionally, we could use an LLM to further refine the responses 
  // but for now we'll just pass them through as is
  return questionResponsePairs;
}

/**
 * Dynamically generates recommended breadth and depth parameters based on
 * the query complexity and user time constraints.
 */
export async function generateResearchParameters({
  query,
  maxDuration = 20, // Default max duration in minutes
  modelId = "o3-mini",
  apiKey,
  feedbackResponses = [],
}: {
  query: string;
  maxDuration?: number;
  modelId?: AIModel;
  apiKey?: string;
  feedbackResponses?: Array<{ question: string; response: string }>;
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing API key in environment variables.");
  }

  const model = createModel(modelId, apiKey);

  // Include feedback in the analysis if available
  const feedbackContext = feedbackResponses.length > 0 
    ? `
Additional context from follow-up questions:
${feedbackResponses.map(fr => `Question: ${fr.question}\nResponse: ${fr.response}`).join('\n\n')}
`
    : '';

  const parameters = await generateObject({
    model,
    system: systemPrompt(),
    prompt: `Analyze the following research query and recommend optimal parameters for the research process.

<query>${query}</query>
${feedbackContext}

Time constraint: ${maxDuration} minutes maximum duration

Based on the complexity of this query, determine:
1. The optimal breadth (number of parallel search queries per iteration)
2. The optimal depth (number of iterations of research)
3. Component-specific depth recommendations (some components may need more or less depth)

Consider:
- More complex/broad topics need higher breadth but may require controlled depth to fit time constraints
- Very specific/technical topics may benefit from lower breadth but deeper exploration
- The time constraint should influence your recommendations
- A higher breadth (more parallel searches) is better for exploring diverse aspects
- A higher depth (more iterations) is better for diving deeper into specific aspects

Respond in this JSON format:
{
  "breadth": number (1-5),
  "depth": number (1-3),
  "componentDepthMultipliers": {
    "componentTypeA": number (0.5-2.0),
    "componentTypeB": number (0.5-2.0),
    ...
  },
  "estimatedTimeMinutes": number,
  "reasoning": "Brief explanation of your recommendations"
}

IMPORTANT: 
- breadth should be an integer between 1 and 5 (inclusive)
- depth should be an integer between 1 and 3 (inclusive)
- componentDepthMultipliers should have values between 0.5 and 2.0

For componentDepthMultipliers, identify up to 4 key component types that might be part of this research and recommend depth multipliers.
`,
    schema: z.object({
      breadth: z.number().int(),
      depth: z.number().int(),
      componentDepthMultipliers: z.record(z.number()).optional(),
      estimatedTimeMinutes: z.number(),
      reasoning: z.string(),
    }),
  });

  return {
    ...parameters.object,
    componentDepthMultipliers: parameters.object.componentDepthMultipliers || {}
  };
}
