import FirecrawlApp, { SearchResponse } from "@mendable/firecrawl-js";
import { generateObject } from "ai";
import { compact } from "lodash-es";
import { z } from "zod";

import { createModel, trimPrompt } from "./ai/providers";
import { systemPrompt } from "./prompt";

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

// Instantiate Firecrawl with whichever key is available
function getFirecrawl(apiKey?: string) {
  return new FirecrawlApp({
    apiKey: apiKey ?? process.env.FIRECRAWL_KEY ?? "",
    apiUrl: process.env.FIRECRAWL_BASE_URL, // if needed
  });
}

/**
 * Asks the model to produce a JSON analysis of the discovered text,
 * including "gaps", "shouldContinue", "nextSearchTopic", etc.
 */
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
  const textBlocks = textContents.map((c) => `<content>\n${c}\n</content>`).join("\n");
  const prompt = `
You have the following partial research results from searching "<query>${query}</query>". 
The raw text is:

${textBlocks}

Produce an "analysis" JSON object with the following structure:

{
  "analysis": {
    "summary": "A short summary of new findings discovered",
    "gaps": ["array of open questions or missing info if any exist"],
    "shouldContinue": true or false, 
    "nextSearchTopic": "If you think we should do another search, provide the search topic or relevant angle. Otherwise an empty string."
  }
}

- "gaps": things we have not learned or any unclear aspects we might still investigate
- "shouldContinue": set true if we should keep searching and investigating, false if it's sufficient
- "nextSearchTopic": if "shouldContinue" is true, suggest a short query or angle

Please follow the exact JSON format. Do not add other keys.
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
  } catch (err) {
    console.error("Analysis and planning error:", err);
    return null;
  }
}

/**
 * Summarize search results into "learnings"
 */
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
}): Promise<string[]> {
  await onProgress?.(`Summarizing search results for "${query}"...`);

  const textContents = compact(searchResult.data.map((r) => r.markdown)).map(
    (content) => trimPrompt(content, 25_000)
  );

  // Summarize as bullet points
  const summarizer = await generateObject({
    model,
    system: systemPrompt(),
    prompt: `You have the following text from a search on "${query}":
${textContents.map((c) => `<content>\n${c}\n</content>`).join("\n")}

Return a JSON object:
{
  "learnings": [
    "key point or fact #1",
    "key point or fact #2",
    ...
  ]
}

Only produce up to 5 bullet points in "learnings". Be concise but factual.`,
    schema: z.object({
      learnings: z.array(z.string()),
    }),
  });

  return summarizer.object.learnings;
}

export async function deepResearch({
  query,
  breadth = 3,
  depth = 2,
  learnings = [],
  visitedUrls = [],
  onProgress,
  model,
  firecrawlKey,
}: DeepResearchOptions): Promise<{
  learnings: string[];
  visitedUrls: string[];
}> {
  const firecrawl = getFirecrawl(firecrawlKey);
  let combinedLearnings = [...learnings];
  let combinedUrls = [...visitedUrls];

  await onProgress?.(
    `Starting research on "${query}" with breadth=${breadth}, depth=${depth}...`
  );

  // We do a nested loop: for 'depth' times, we generate 'breadth' queries,
  // then search, summarize, analyze, decide if we continue.
  for (let d = 0; d < depth; d++) {
    await onProgress?.(`Depth iteration: ${d + 1}/${depth}...`);

    // Step 1) Generate some sub-queries for this iteration
    const subQueries = await generateSubQueries({
      query,
      existingLearnings: combinedLearnings,
      model,
      count: breadth,
    });
    await onProgress?.(`Generated sub-queries: ${JSON.stringify(subQueries)}`);

    for (const sq of subQueries) {
      // Step 2) Firecrawl search
      await onProgress?.(`Searching: ${sq}`);
      const result = await firecrawl.search(sq, {
        timeout: 15000,
        limit: 4,
        scrapeOptions: { formats: ["markdown"] },
      });

      // Combine visited URLs
      const foundUrls = result.data
        .map((r) => r.url)
        .filter((u): u is string => !!u);
      combinedUrls.push(...foundUrls);

      // Step 3) Summarize
      const newLearnings = await summarizeSearchResults({
        query: sq,
        searchResult: result,
        model,
        onProgress,
      });
      combinedLearnings.push(...newLearnings);

      // Step 4) Analyze & decide if we want to continue
      const analysis = await analyzeAndPlan({
        textContents: newLearnings,
        query: sq,
        model,
        onProgress,
      });

      if (!analysis) {
        await onProgress?.("Analysis failed; continuing to next sub-query...");
        continue;
      }

      await onProgress?.(`Analysis summary: ${analysis.summary}`);

      // If the LLM says "stop," then break out
      if (!analysis.shouldContinue) {
        await onProgress?.("LLM indicated we should stop here.");
        return {
          learnings: combinedLearnings,
          visitedUrls: combinedUrls,
        };
      }

      // If there’s a recommended next topic, override `query` for the next iteration
      if (analysis.nextSearchTopic.trim()) {
        await onProgress?.(`Next search topic: ${analysis.nextSearchTopic}`);
        query = analysis.nextSearchTopic;
      }
    }
    // Move to the next depth iteration if we haven't returned early
  }

  // If we complete the loops, return
  return {
    learnings: combinedLearnings,
    visitedUrls: combinedUrls,
  };
}

/**
 * Basic function to produce "sub-queries" for each iteration,
 * referencing known learnings so it can refine.
 */
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
You are creating short, specific search queries for investigating the main topic:
<mainTopic>${query}</mainTopic>

We have these existing partial learnings:
${existingLearnings.map((l) => `- ${l}`).join("\n")}

Generate up to ${count} short, distinct Google-like queries that each investigate an unresolved angle or gap in the knowledge.

Return JSON in the following format:
{
  "queries": [
    "short query 1",
    "short query 2",
    ...
  ]
}

Ensure each query is short, realistic, and focuses on a single subtopic or new angle.
`;

  const obj = await generateObject({
    model,
    system: systemPrompt(),
    prompt,
    schema: z.object({
      queries: z.array(z.string()),
    }),
  });

  return obj.object.queries.slice(0, count);
}

/**
 * After we've compiled all learnings, produce a final "report"
 */
export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
  model,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  model: ReturnType<typeof createModel>;
}) {
  // Merge learnings into a single string
  const merged = learnings.map((l) => `- ${l}`).join("\n");
  const sources = visitedUrls.map((u) => `- ${u}`).join("\n");

  // Let the model produce a final, long markdown doc
  const final = await generateObject({
    model,
    system: systemPrompt(),
    prompt: `
The user originally asked: <prompt>${prompt}</prompt>

We have the following combined learnings from the multi-step research:
${merged}

Write a comprehensive final research report in Markdown. 
It should include:
- A short introduction
- Key findings with relevant detail
- Potential next steps or open questions
- A "Sources" section listing the visited URLs

Return JSON in the format:
{
  "reportMarkdown": "Full markdown text"
}
`,
    schema: z.object({
      reportMarkdown: z.string(),
    }),
  });

  // Optionally append a final "## Sources" if not included
  const finalReport = final.object.reportMarkdown;
  return finalReport;
}
