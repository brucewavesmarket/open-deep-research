import FirecrawlApp, { SearchResponse } from "@mendable/firecrawl-js";
import { generateObject } from "ai";
import { compact } from "lodash-es";
import { z } from "zod";

import { createModel, trimPrompt } from "./ai/providers";
import { systemPrompt } from "./prompt";

/** 
 *  Plan & Subtopic Structures 
 */
export interface ResearchPlan {
  overarchingGoal: string;
  subtopics: Array<{
    name: string;
    purpose: string;
    subSubtopics: Array<{
      name: string;
      criteria: string;
    }>;
  }>;
}

/** 
 * Step 1) parseResearchPlan:
 * Takes the user query & clarifications, returns an overarchingGoal, subtopics, sub-subtopics
 */
export async function parseResearchPlan({
  query,
  model,
}: {
  query: string;
  model: ReturnType<typeof createModel>;
}): Promise<ResearchPlan> {
  const prompt = `
The user has a research request:
<userQuery>${query}</userQuery>

We want a plan in JSON with:
- "overarchingGoal": a short summary (1-3 sentences) of the main purpose/why
- "subtopics": an array, each with:
   "name": short name of subtopic
   "purpose": short explanation (1-2 sentences) of that subtopic's role
   "subSubtopics": an array of objects, each with:
       "name": sub-subtopic name or sub-goal 
       "criteria": definition of success or detail to investigate

No matter how simple the user query is, produce at least 1 subtopic with subSubtopics. If it's truly single-faceted, just produce 1 subtopic with minimal subSubtopics. If complex, break it down more.

Return exactly:
{
  "overarchingGoal": "string",
  "subtopics": [
    {
      "name": "string",
      "purpose": "string",
      "subSubtopics": [
        {
          "name": "string",
          "criteria": "string"
        },
        ...
      ]
    },
    ...
  ]
}
`;

  // Use zod to enforce the structure
  const planSchema = z.object({
    overarchingGoal: z.string(),
    subtopics: z.array(
      z.object({
        name: z.string(),
        purpose: z.string(),
        subSubtopics: z.array(
          z.object({
            name: z.string(),
            criteria: z.string(),
          })
        ),
      })
    ),
  });

  const parsed = await generateObject({
    model,
    system: systemPrompt(),
    prompt,
    schema: planSchema,
  });

  return parsed.object;
}

/** 
 * Step 2) deepResearchSubtopic:
 *  Runs a research loop for a single subtopic in parallel with others
 */
export async function deepResearchSubtopic({
  subtopic,
  overarchingGoal,
  breadth,
  depth,
  model,
  firecrawlKey,
  onProgress,
}: {
  subtopic: ResearchPlan["subtopics"][number]; 
  overarchingGoal: string;
  breadth: number;
  depth: number;
  model: ReturnType<typeof createModel>;
  firecrawlKey?: string;
  onProgress?: (update: string) => Promise<void>;
}): Promise<{
  subtopicName: string;
  learnings: string[];
  visitedUrls: string[];
}> {
  // Construct a "big picture" query for the subtopic 
  // referencing the overarchingGoal, subtopic purpose, sub-subtopics, etc.
  const subtopicPrompt = `
Overarching Goal:
${overarchingGoal}

Subtopic: ${subtopic.name}
Purpose: ${subtopic.purpose}
Sub-Subtopics:
${subtopic.subSubtopics
  .map((ss) => `- ${ss.name}: ${ss.criteria}`)
  .join("\n")}

Your job is to gather knowledge specifically about the above subtopic, 
while keeping the overarching goal in mind. 
But do NOT research unrelated details from other subtopics. 
Focus on items that fulfill the success criteria above.

`;


  // We can reuse the existing "deepResearch" logic 
  // by injecting this subtopicPrompt as the "query"
  const { learnings, visitedUrls } = await deepResearch({
    query: subtopicPrompt,
    breadth,
    depth,
    model,
    firecrawlKey,
    onProgress,
  });

  return {
    subtopicName: subtopic.name,
    learnings,
    visitedUrls,
  };
}

/** 
 * Our existing deepResearch logic from prior code 
 * but updated to be exported 
 */

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

type DeepResearchOptions = {
  query: string;
  breadth?: number;
  depth?: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (update: string) => Promise<void>;
  model: ReturnType<typeof createModel>;
  firecrawlKey?: string;
};

function getFirecrawl(apiKey?: string) {
  return new FirecrawlApp({
    apiKey: apiKey ?? process.env.FIRECRAWL_KEY ?? "",
  });
}

// Summarize
async function summarizeSearchResults({
  query,
  searchResult,
  model,
  onProgress,
}: {
  query: string;
  searchResult: SearchResponse;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
}) {
  await onProgress?.(`Summarizing search results for "${query}"...`);

  const textContents = compact(searchResult.data.map((r) => r.markdown)).map(
    (c) => trimPrompt(c, 25_000)
  );

  const summarizer = await generateObject({
    model,
    system: systemPrompt(),
    prompt: `
We found the following data for "${query}":
${textContents.map((c) => `<content>\n${c}\n</content>`).join("\n")}

Return JSON:
{
  "learnings": [
    "key bullet point #1",
    "key bullet point #2",
    ...
  ]
}`,
    schema: z.object({
      learnings: z.array(z.string()),
    }),
  });

  return summarizer.object.learnings;
}

// Analyze
async function analyzeAndPlan({
  textContents,
  query,
  model,
  onProgress,
}: {
  textContents: string[];
  query: string;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
}) {
  const prompt = `
You have partial results from searching: "${query}". 
Contents: 
${textContents.map((c) => `<content>\n${c}\n</content>`).join("\n")}

Produce:
{
  "analysis": {
    "summary": "...",
    "gaps": [...],
    "shouldContinue": true or false,
    "nextSearchTopic": "string"
  }
}
`;

  await onProgress?.("Analyzing & planning next steps...");

  try {
    const result = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        analysis: z.object({
          summary: z.string(),
          gaps: z.array(z.string()),
          shouldContinue: z.boolean(),
          nextSearchTopic: z.string(),
        }),
      }),
    });
    return result.object.analysis;
  } catch {
    return null;
  }
}

/**
 * The main "deepResearch" function: we do a BFS-like approach 
 * for multiple search queries each iteration
 */
export async function deepResearch({
  query,
  breadth = 3,
  depth = 2,
  learnings = [],
  visitedUrls = [],
  onProgress,
  model,
  firecrawlKey,
}: DeepResearchOptions): Promise<ResearchResult> {
  const firecrawl = getFirecrawl(firecrawlKey);
  let combinedLearnings = [...learnings];
  let combinedUrls = [...visitedUrls];

  await onProgress?.(`Starting deepResearch on: ${query}`);

  for (let d = 0; d < depth; d++) {
    await onProgress?.(`Depth iteration: ${d + 1}/${depth}...`);

    // Step 1) generate subQueries
    const subQueries = await generateSubQueries({
      query,
      existingLearnings: combinedLearnings,
      model,
      count: breadth,
    });
    await onProgress?.(`Generated queries: ${JSON.stringify(subQueries)}`);

    // Step 2) run them in sequence (could also do parallel here if wanted)
    for (const sq of subQueries) {
      await onProgress?.(`Searching: ${sq}`);
      const result = await firecrawl.search(sq, {
        timeout: 15000,
        limit: 5,
        scrapeOptions: { formats: ["markdown"] },
      });

      // gather URLs
      const foundUrls = result.data.map((r) => r.url).filter(Boolean) as string[];
      combinedUrls.push(...foundUrls);

      // Step 3) summarize
      const newLearnings = await summarizeSearchResults({
        query: sq,
        searchResult: result,
        model,
        onProgress,
      });
      combinedLearnings.push(...newLearnings);

      // Step 4) analyze
      const analysis = await analyzeAndPlan({
        textContents: newLearnings,
        query: sq,
        model,
        onProgress,
      });
      if (!analysis) continue;

      if (!analysis.shouldContinue) {
        await onProgress?.(`Stopping early: ${analysis.summary}`);
        return {
          learnings: combinedLearnings,
          visitedUrls: combinedUrls,
        };
      }

      if (analysis.nextSearchTopic.trim()) {
        query = analysis.nextSearchTopic;
        await onProgress?.(`Next search topic: ${analysis.nextSearchTopic}`);
      }
    }
  }

  return {
    learnings: combinedLearnings,
    visitedUrls: combinedUrls,
  };
}

/** Helper to produce sub-queries each iteration */
async function generateSubQueries({
  query,
  existingLearnings,
  model,
  count,
}: {
  query: string;
  existingLearnings: string[];
  model: ReturnType<typeof createModel>;
  count: number;
}): Promise<string[]> {
  const prompt = `
We want up to ${count} short, realistic search queries to learn more about:
"${query}"

We already have partial learnings:
${existingLearnings.map((l) => "- " + l).join("\n")}

Return:
{
  "queries": [
    "short query #1",
    "short query #2",
    ...
  ]
}
`;
  const response = await generateObject({
    model,
    system: systemPrompt(),
    prompt,
    schema: z.object({
      queries: z.array(z.string()),
    }),
  });

  return response.object.queries.slice(0, count);
}

/**
 * Step 3) mergeSubtopicReports:
 *  After each subtopic is done in parallel, unify them in a final integrated markdown
 */
export async function mergeSubtopicReports({
  plan,
  subtopicResults,
  model,
}: {
  plan: {
    overarchingGoal: string;
    subtopics: Array<{
      name: string;
      purpose: string;
      subSubtopics: Array<{
        name: string;
        criteria: string;
      }>;
    }>;
  };
  subtopicResults: Array<{
    subtopicName: string;
    learnings: string[];
    visitedUrls: string[];
  }>;
  model: ReturnType<typeof createModel>;
}): Promise<string> {
  // Flatten
  const combinedLearnings = subtopicResults.flatMap((r) => r.learnings);
  const allUrls = subtopicResults.flatMap((r) => r.visitedUrls);

  // We'll pass everything to the LLM for final integrated markdown
  const prompt = `
We have an overarching goal: 
"${plan.overarchingGoal}"

Subtopics with sub-subtopics (the plan):
${JSON.stringify(plan.subtopics, null, 2)}

We ran parallel research. 
Here are the results for each subtopic:
${JSON.stringify(subtopicResults, null, 2)}

Now produce a comprehensive final report in Markdown:
- Summarize each subtopic's findings
- Relate them back to the overarchingGoal
- Outline any missing info or further recommended steps
- Provide a "Sources" section with visited URLs.

Return JSON:
{
  "reportMarkdown": "A single integrated markdown doc"
}
`;

  const final = await generateObject({
    model,
    system: systemPrompt(),
    prompt,
    schema: z.object({
      reportMarkdown: z.string(),
    }),
  });

  return final.object.reportMarkdown;
}
