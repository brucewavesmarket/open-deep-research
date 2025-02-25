import FirecrawlApp, { SearchResponse } from "@mendable/firecrawl-js";
import { generateObject } from "ai";
import { compact } from "lodash-es";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

import { createModel, trimPrompt } from "./ai/providers";
import { systemPrompt } from "./prompt";

//
// -- TYPES & INTERFACES -----------------------------------------------------
//

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// New types for research planning
export type ResearchComponent = {
  name: string;
  description: string;
  subQuestions: string[];
  successCriteria: string[];
};

export type ResearchPlan = {
  mainObjective: string;
  components: ResearchComponent[];
  sequencing: string[];
  potentialPivots: string[];
};

export type ComponentResult = {
  learnings: string[];
  visitedUrls: string[];
  summary: string;
  timeSpent: number; // Track time spent on each component
};

// Updated to include time management parameters
export type DeepResearchOptions = {
  query: string;
  breadth?: number;
  depth?: number;
  maxDuration?: number; // Maximum duration in minutes
  componentDepthMultipliers?: Record<string, number>; // Custom depth multipliers per component
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (update: string) => Promise<void>;
  model: ReturnType<typeof createModel>;
  firecrawlKey?: string;
  anthropicApiKey?: string; // Optional API key for Anthropic
  testAnthropicMode?: boolean; // Flag to test Anthropic API directly
  feedbackResponses?: Array<{ question: string; response: string }>; // User feedback responses
};

// Track overall research state for time management
type ResearchState = {
  startTime: number;
  currentTime: number;
  elapsedTime: number;
  remainingTime: number;
  completed: string[];
  inProgress: string | null;
  remaining: string[];
  componentTimes: Record<string, number>;
};

// Track iteration time statistics
export type ResearchStats = {
  averageIterationTimeMs: number;
  averageComponentTimeMs: number;
  completedIterations: number;
  totalIterationsTime: number;
  iterationTimes: number[];
};

//
// -- FIRECRAWL SETUP --------------------------------------------------------
//

function getFirecrawl(apiKey?: string) {
  return new FirecrawlApp({
    apiKey: apiKey ?? process.env.FIRECRAWL_KEY ?? "",
    apiUrl: process.env.FIRECRAWL_BASE_URL, // if needed
  });
}

//
// -- PLAN CREATION ----------------------------------------------------------
//

/**
 * Creates a research plan based on the user's query
 */
export async function createResearchPlan({
  query,
  model,
  onProgress,
  feedbackResponses = [],
}: {
  query: string;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
  feedbackResponses?: Array<{ question: string; response: string }>;
}): Promise<ResearchPlan> {
  await onProgress?.("Creating research plan...");

  // Build context from feedback if available
  const feedbackContext = feedbackResponses.length > 0 
    ? `
Additional context from follow-up questions:
${feedbackResponses.map(fr => `Question: ${fr.question}\nResponse: ${fr.response}`).join('\n\n')}
`
    : '';

  const prompt = `
Analyze this research query and create a structured research plan: 

<query>${query}</query>
${feedbackContext}

Your plan should break down the research into logical components that collectively address the query.
For each component, provide specific sub-questions that will help gather relevant information.

Return a JSON object with this structure:
{
  "mainObjective": "Clear statement of the overall research goal",
  "components": [
    {
      "name": "Component name (e.g., 'Market Demographics', 'Consumer Pain Points')",
      "description": "Brief description of what this component explores",
      "subQuestions": ["Specific question 1", "Specific question 2", ...],
      "successCriteria": ["Criterion 1", "Criterion 2", ...]
    },
    ...
  ],
  "sequencing": ["component1", "component2", ...],
  "potentialPivots": ["Possible direction 1", "Possible direction 2", ...]
}

Ensure that:
1. Each component addresses a distinct aspect of the research
2. Sub-questions are specific enough to guide focused searches
3. Success criteria define what information is needed to consider the component complete
4. Sequencing suggests the logical order to research components
5. Potential pivots identify areas where findings might lead to additional research directions
`;

  try {
    const result = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        mainObjective: z.string(),
        components: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            subQuestions: z.array(z.string()),
            successCriteria: z.array(z.string()),
          })
        ),
        sequencing: z.array(z.string()),
        potentialPivots: z.array(z.string()),
      }),
    });

    return result.object;
  } catch (err) {
    console.error("Research plan creation error:", err);
    // Fallback to a basic plan if generation fails
    return {
      mainObjective: query,
      components: [
        {
          name: "Basic Research",
          description: "General exploration of the topic",
          subQuestions: [query],
          successCriteria: ["Gather basic information about the topic"],
        },
      ],
      sequencing: ["Basic Research"],
      potentialPivots: [],
    };
  }
}

//
// -- TIME/STATE MANAGEMENT --------------------------------------------------
//

/**
 * Creates or updates research state for time management
 */
export function updateResearchState({
  state,
  plan,
  maxDuration,
  completedComponent = null,
  timeSpent = 0,
}: {
  state: ResearchState | null;
  plan: ResearchPlan;
  maxDuration: number;
  completedComponent?: string | null;
  timeSpent?: number;
}): ResearchState {
  const now = Date.now();

  if (!state) {
    // Initialize state if it doesn't exist
    return {
      startTime: now,
      currentTime: now,
      elapsedTime: 0,
      remainingTime: maxDuration * 60 * 1000, // Convert minutes to ms
      completed: [],
      inProgress: plan.sequencing[0] || null,
      remaining: plan.sequencing,
      componentTimes: {},
    };
  }

  // Update existing state
  const updatedState = { ...state };
  updatedState.currentTime = now;
  updatedState.elapsedTime = now - state.startTime;
  updatedState.remainingTime = Math.max(
    0,
    maxDuration * 60 * 1000 - updatedState.elapsedTime
  );

  // If a component was just completed
  if (completedComponent) {
    updatedState.completed = [...state.completed, completedComponent];
    updatedState.componentTimes = {
      ...state.componentTimes,
      [completedComponent]: timeSpent,
    };

    // Remove completed from the list of remaining
    const remainingIdx = updatedState.remaining.findIndex(
      (c) => c !== completedComponent
    );
    updatedState.inProgress =
      remainingIdx >= 0 ? updatedState.remaining[remainingIdx] : null;
    updatedState.remaining = updatedState.remaining.filter(
      (c) => c !== completedComponent
    );
  }

  return updatedState;
}

//
// -- COMPONENT SELECTION / TIME DECISIONS -----------------------------------
//

/**
 * Decides whether to continue or skip a research component based on time constraints
 */
export async function shouldContinueComponent({
  componentName,
  state,
  plan,
  model,
  onProgress,
  stats,
}: {
  componentName: string;
  state: ResearchState;
  plan: ResearchPlan;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
  stats: ResearchStats;
}): Promise<boolean> {
  // If we have more than 5 minutes remaining, continue
  if (state.remainingTime > 5 * 60 * 1000) {
    return true;
  }

  // If there is only one component left, continue
  const remainingComponentsCount = state.remaining.length;
  if (remainingComponentsCount <= 1) {
    await onProgress?.(
      `Time analysis: Continuing with final component "${componentName}"`
    );
    return true;
  }

  // Try to estimate time needed
  const component = plan.components.find((c) => c.name === componentName);
  if (!component) {
    console.error(`Component ${componentName} not found in plan`);
    return true;
  }

  const estimatedIterations = Math.min(component.subQuestions.length, 3);

  // Use rolling average of last 3 iteration times
  const recentIterationsTimes = stats.iterationTimes.slice(-3);
  const recentAvgIterationTime =
    recentIterationsTimes.length > 0
      ? recentIterationsTimes.reduce((a, b) => a + b, 0) /
        recentIterationsTimes.length
      : stats.averageIterationTimeMs;

  // Component time estimate
  const estimatedComponentTime =
    stats.averageComponentTimeMs > 0
      ? stats.averageComponentTimeMs
      : recentAvgIterationTime * estimatedIterations;

  const iterationTimeEstimate =
    recentIterationsTimes.length > 0
      ? recentAvgIterationTime
      : stats.averageIterationTimeMs > 0
      ? stats.averageIterationTimeMs
      : 60_000;

  await onProgress?.(
    `Time analysis: Recent average iteration ~${Math.round(
      iterationTimeEstimate / 1000
    )}s, component may take ~${Math.round(estimatedComponentTime / 1000)}s`
  );

  // Minimum time per remaining component
  const minTimePerComp = iterationTimeEstimate;
  const minTimeForOthers = (remainingComponentsCount - 1) * minTimePerComp;

  // Check if we can at least do one iteration
  const canDoSingleIteration =
    state.remainingTime > iterationTimeEstimate + minTimeForOthers;
  if (canDoSingleIteration) {
    await onProgress?.(
      `Time analysis: Enough time for at least one iteration of "${componentName}"`
    );
    return true;
  }

  // If we can't do even one iteration, see if we can do minimal research for all
  const timePerComponent = state.remainingTime / remainingComponentsCount;
  const canDoMinimalResearch = timePerComponent >= minTimePerComp;
  if (canDoMinimalResearch) {
    await onProgress?.(
      `Time analysis: Doing minimal research for "${componentName}" → ~${Math.round(
        timePerComponent / 1000
      )}s allocated`
    );
    return true;
  }

  // Otherwise, ask LLM for a final decision
  const prompt = `
We are researching "${plan.mainObjective}".
Completed components so far:
${state.completed.map((c) => `- ${c}`).join("\n")}

We have ~${Math.round(
    state.remainingTime / 1000
  )} seconds left total, and ${remainingComponentsCount} components remain:
${JSON.stringify(state.remaining)}

Recent average iteration time ~${Math.round(iterationTimeEstimate / 1000)}s.
The full component might take ~${Math.round(
    estimatedComponentTime / 1000
  )}s to finish.

Decide if we should skip "${component.name}" to ensure we have time
for the others, or if we should continue with at least one iteration on it.

Return JSON:
{
  "shouldContinue": true or false,
  "reasoning": "short reason",
  "recommendedBreadth": number(1..5),
  "recommendedDepth": number(1..3)
}
`;

  try {
    const decision = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        shouldContinue: z.boolean(),
        reasoning: z.string(),
        recommendedBreadth: z.number().int(),
        recommendedDepth: z.number().int(),
      }),
    });
    await onProgress?.(
      `Time mgmt decision for "${componentName}": ${
        decision.object.shouldContinue ? "Continue" : "Skip"
      } - ${decision.object.reasoning}`
    );
    return decision.object.shouldContinue;
  } catch (err) {
    console.error("Time mgmt decision error:", err);
    return true; // default to continuing if error
  }
}

//
// -- PLAN REVISION CHECK ----------------------------------------------------
//

/**
 * Checks if the plan needs revision based on new learnings
 */
export async function evaluateAndReviseResearchPlan({
  plan,
  completedComponents,
  currentLearnings,
  model,
  onProgress,
}: {
  plan: ResearchPlan;
  completedComponents: string[];
  currentLearnings: string[];
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
}): Promise<ResearchPlan> {
  await onProgress?.("Evaluating research plan...");

  const prompt = `
Based on these learnings so far:
${currentLearnings.map((l) => `- ${l}`).join("\n")}

Current research plan:
${JSON.stringify(plan, null, 2)}

Have we discovered new areas that warrant revising the plan?
Should we adjust or reorder components?
Should we add or remove sub-questions?

Return JSON:
{
  "needsRevision": true or false,
  "revisionReason": "why or why not",
  "revisionDetails": {
    "componentsAdded": [],
    "componentsModified": [],
    "sequencingChanged": true or false,
    "sequencingReason": ""
  },
  "revisedPlan": {
    "mainObjective": "string",
    "components": [...],
    "sequencing": [...],
    "potentialPivots": [...]
  }
}
`;

  try {
    const result = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        needsRevision: z.boolean(),
        revisionReason: z.string(),
        revisionDetails: z.object({
          componentsAdded: z.array(z.string()),
          componentsModified: z.array(z.string()),
          sequencingChanged: z.boolean(),
          sequencingReason: z.string(),
        }),
        revisedPlan: z.object({
          mainObjective: z.string(),
          components: z.array(
            z.object({
              name: z.string(),
              description: z.string(),
              subQuestions: z.array(z.string()),
              successCriteria: z.array(z.string()),
            })
          ),
          sequencing: z.array(z.string()),
          potentialPivots: z.array(z.string()),
        }),
      }),
    });

    if (result.object.needsRevision) {
      await onProgress?.(
        `Plan revised: ${result.object.revisionReason || "No reason provided"}`
      );
      return result.object.revisedPlan;
    }
    return plan;
  } catch (err) {
    console.error("Plan evaluation error:", err);
    return plan;
  }
}

//
// -- SEARCH RESULT ANALYSIS -------------------------------------------------
//

/**
 * Analyze partial results, decide if we should continue or pivot
 */
export async function analyzeAndPlan({
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
  if (
    textContents.length === 0 ||
    textContents.every((t) => !t || t.trim().length < 50)
  ) {
    await onProgress?.("No useful content found. Continuing with a simpler approach...");
    return {
      summary: "No relevant content discovered in this search.",
      gaps: ["Complete coverage of this topic"],
      shouldContinue: true,
      nextSearchTopic:
        query.split(" ").slice(0, 3).join(" ") + " basics",
    };
  }

  const textBlocks = textContents
    .map((c) => `<content>\n${c}\n</content>`)
    .join("\n");

  const prompt = `
We have partial research results from searching "<query>${query}</query>". The raw text is:

${textBlocks}

Produce a JSON object "analysis" like:
{
  "analysis": {
    "summary": "Short summary of the new findings discovered",
    "valuable": true or false,
    "gaps": ["missing info"],
    "shouldContinue": true or false,
    "nextSearchTopic": "If more research is needed, a short focused search query. Otherwise an empty string."
  }
}

If the findings are worthless or too generic, set valuable=false. 
If we haven't covered all known aspects, set shouldContinue=true. 
"nextSearchTopic" should be 2-5 words, no advanced operators.

Return exactly that JSON.
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
          valuable: z.boolean(),
          gaps: z.array(z.string()),
          shouldContinue: z.boolean(),
          nextSearchTopic: z.string(),
        }),
      }),
    });

    const analysis = result.object.analysis;
    if (!analysis.valuable) {
      await onProgress?.("Data not very valuable, we'll keep searching with a simpler query...");
      return {
        summary: analysis.summary,
        gaps: analysis.gaps,
        shouldContinue: true,
        nextSearchTopic:
          analysis.nextSearchTopic.trim() ||
          query.split(" ").slice(0, 3).join(" "),
      };
    }
    return analysis;
  } catch (err) {
    console.error("Analysis & plan error:", err);
    return {
      summary: "Error analyzing results",
      gaps: ["No coverage yet"],
      shouldContinue: true,
      nextSearchTopic: query.split(" ").slice(0, 3).join(" "),
    };
  }
}

//
// -- SUMMARIZATION ----------------------------------------------------------
//

/**
 * Summarize search results into "learnings"
 */
export async function summarizeSearchResults({
  query,
  searchResult,
  model,
  onProgress,
  component,
}: {
  query: string;
  searchResult: SearchResponse;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
  component?: ResearchComponent | null;
}): Promise<string[]> {
  await onProgress?.(`Summarizing search results for "${query}"...`);

  const textContents = compact(searchResult.data.map((r) => r.markdown)).map(
    (content) => trimPrompt(content, 25_000)
  );

  if (textContents.length === 0) {
    await onProgress?.(`No content found for "${query}"`);
    return [];
  }

  const componentContext = component
    ? `
This search is part of the research component: "${component.name}"

Description: ${component.description}

Success criteria to address:
${component.successCriteria.map((c) => `- ${c}`).join("\n")}
`
    : "";

  const prompt = `
You have the following text from a search on "${query}":
${textContents.map((c) => `<content>\n${c}\n</content>`).join("\n")}

${componentContext}

Return a JSON object:
{
  "learnings": [
    "key point #1",
    "key point #2",
    ...
  ]
}

Guidelines:
1. Extract 3-5 specific, factual insights relevant to the search query
2. Focus on new or unique info not obviously covered before
3. Provide distinct bullet points
4. If part of a component, emphasize insights that fulfill success criteria
`;

  const summarizer = await generateObject({
    model,
    system: systemPrompt(),
    prompt,
    schema: z.object({
      learnings: z.array(z.string()),
    }),
  });

  return summarizer.object.learnings;
}

//
// -- SATURATION CHECK -------------------------------------------------------
//

/**
 * Evaluates if current research on a component is sufficient or if more is needed
 */
export async function evaluateComponentSaturation({
  component,
  learnings,
  completedIterations,
  totalPlannedIterations,
  model,
  onProgress,
}: {
  component: ResearchComponent;
  learnings: string[];
  completedIterations: number;
  totalPlannedIterations: number;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
}): Promise<{
  isSaturated: boolean;
  coveragePercentage: number;
  coveredCriteria: string[];
  remainingCriteria: string[];
  reasoning: string;
  gapDetails: Record<string, string>;
}> {
  await onProgress?.(
    `Evaluating saturation after ${completedIterations}/${totalPlannedIterations} iterations on "${component.name}"...`
  );

  // If fewer than 10% of planned iterations done, keep going
  if (completedIterations < Math.ceil(totalPlannedIterations * 0.1)) {
    return {
      isSaturated: false,
      coveragePercentage: 0,
      coveredCriteria: [],
      remainingCriteria: component.successCriteria,
      reasoning: "Minimal iteration threshold not met",
      gapDetails: component.successCriteria.reduce((acc, c) => {
        acc[c] = "No coverage yet";
        return acc;
      }, {} as Record<string, string>),
    };
  }

  const prompt = `
We have a research component "${component.name}" with success criteria:
${component.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Completed ${completedIterations} out of ${totalPlannedIterations} planned sub-questions.

Learnings so far:
${learnings.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Decide:
1) Which success criteria are met
2) Which are unmet
3) The coverage % (0-100)
4) If further iterations are needed ("isSaturated" true if no major new insights are likely)
5) If there are any specific info gaps, list them in gapDetails

Return JSON:
{
  "evaluation": {
    "isSaturated": true/false,
    "coveragePercentage": 0-100,
    "coveredCriteria": [],
    "remainingCriteria": [],
    "gapDetails": {
      "someCriterion": "missing info detail"
    },
    "reasoning": "brief reasoning"
  }
}
`;

  try {
    const result = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        evaluation: z.object({
          isSaturated: z.boolean(),
          coveragePercentage: z.number(),
          coveredCriteria: z.array(z.string()),
          remainingCriteria: z.array(z.string()),
          gapDetails: z.record(z.string()).optional(),
          reasoning: z.string(),
        }),
      }),
    });

    const e = result.object.evaluation;
    await onProgress?.(
      `Saturation check: ${e.coveragePercentage.toFixed(0)}% covered, ${
        e.isSaturated ? "Saturated" : "Not yet done"
      }`
    );
    return {
      isSaturated: e.isSaturated,
      coveragePercentage: e.coveragePercentage,
      coveredCriteria: e.coveredCriteria,
      remainingCriteria: e.remainingCriteria,
      reasoning: e.reasoning,
      gapDetails: e.gapDetails || {},
    };
  } catch (err) {
    console.error("Saturation eval error:", err);
    return {
      isSaturated: false,
      coveragePercentage: 0,
      coveredCriteria: [],
      remainingCriteria: component.successCriteria,
      reasoning: "Evaluation failed; continuing",
      gapDetails: component.successCriteria.reduce((acc, c) => {
        acc[c] = "Unknown gap; continuing";
        return acc;
      }, {} as Record<string, string>),
    };
  }
}

//
// -- COMPONENT RESEARCH -----------------------------------------------------
//

/**
 * Researches a single component's subQuestions
 */
export async function researchComponent({
  component,
  subQuestions,
  breadth,
  depth,
  existingLearnings,
  model,
  firecrawl,
  onProgress,
  state,
  maxDuration,
  componentDepthMultiplier = 1.0,
  stats,
  mainTopic = "",
}: {
  component: ResearchComponent;
  subQuestions: string[];
  breadth: number;
  depth: number;
  existingLearnings: string[];
  model: ReturnType<typeof createModel>;
  firecrawl: FirecrawlApp;
  onProgress?: (update: string) => Promise<void>;
  state: ResearchState;
  maxDuration: number;
  componentDepthMultiplier?: number;
  stats: ResearchStats;
  mainTopic?: string;
}): Promise<ComponentResult> {
  const componentStartTime = Date.now();
  await onProgress?.(`Researching component: ${component.name}`);

  const componentLearnings: string[] = [];
  const componentUrls: string[] = [];

  // Adjust depth by multiplier
  const adjustedDepth = Math.max(1, Math.round(depth * componentDepthMultiplier));
  if (componentDepthMultiplier !== 1.0) {
    await onProgress?.(
      `Adjusted depth for "${component.name}": ${adjustedDepth} (multiplier: ${componentDepthMultiplier})`
    );
  }

  let completedIterations = 0;
  const totalPlannedIterations = subQuestions.length;

  let gapDetails: Record<string, string> = component.successCriteria.reduce(
    (acc, c) => {
      acc[c] = "Initial gap";
      return acc;
    },
    {} as Record<string, string>
  );

  for (const question of subQuestions) {
    // Update time
    const currentState = updateResearchState({
      state,
      plan: { mainObjective: "", components: [], sequencing: [], potentialPivots: [] },
      maxDuration,
    });

    // Estimate time per subQuestion
    const remainingCount = subQuestions.length - subQuestions.indexOf(question);
    const timePerQ = currentState.remainingTime / remainingCount;

    // Possibly reduce breadth/depth if time is short
    let effectiveBreadth = breadth;
    let effectiveDepth = adjustedDepth;

    // If we have <30s per question, go minimal
    if (timePerQ < 30_000) {
      effectiveBreadth = 1;
      effectiveDepth = 1;
      await onProgress?.(
        `Time constraint: Reducing to breadth=${effectiveBreadth}, depth=${effectiveDepth} for question "${question}"`
      );
    } else if (timePerQ < 60_000) {
      // If we have <60s but >30s, reduce half
      effectiveBreadth = Math.max(1, Math.floor(breadth / 2));
      effectiveDepth = 1;
      await onProgress?.(
        `Time constraint: Optimizing to breadth=${effectiveBreadth}, depth=${effectiveDepth} for "${question}"`
      );
    }

    // If less than 20s remain total, skip
    if (currentState.remainingTime < 20_000) {
      await onProgress?.(
        `Time constraint: <20s left, skipping question "${question}"`
      );
      break;
    }

    const iterationStart = Date.now();
    await onProgress?.(`Investigating: ${question}`);

    const result = await deepResearchQuery({
      query: question,
      breadth: effectiveBreadth,
      depth: effectiveDepth,
      learnings: [...existingLearnings, ...componentLearnings],
      visitedUrls: componentUrls,
      model,
      firecrawl,
      onProgress,
      remainingTime: currentState.remainingTime,
      stats,
      mainTopic,
      component,
      gapDetails,
    });

    const iterationEnd = Date.now();
    const iterationTime = iterationEnd - iterationStart;
    stats.completedIterations += 1;
    stats.totalIterationsTime += iterationTime;
    stats.iterationTimes.push(iterationTime);
    stats.averageIterationTimeMs =
      stats.totalIterationsTime / stats.completedIterations;

    completedIterations += 1;
    componentLearnings.push(...result.learnings);
    componentUrls.push(...result.visitedUrls);

    await onProgress?.(
      `Iteration took ~${Math.round(iterationTime / 1000)}s (avg ~${Math.round(
        stats.averageIterationTimeMs / 1000
      )}s)`
    );

    // Check saturation
    const saturRes = await evaluateComponentSaturation({
      component,
      learnings: componentLearnings,
      completedIterations,
      totalPlannedIterations,
      model,
      onProgress,
    });

    gapDetails = saturRes.gapDetails;
    if (saturRes.isSaturated || saturRes.coveragePercentage >= 75) {
      await onProgress?.(
        `Saturation reached ~${saturRes.coveragePercentage.toFixed(0)}%. Stopping "${component.name}" now.`
      );
      break;
    }
  }

  // Summarize the entire component
  const summaryPrompt = `
Summarize the findings for "${component.name}" in a concise but thorough way:

Component description:
${component.description}

Sub-questions answered:
${subQuestions.map((q) => `- ${q}`).join("\n")}

Learnings:
${componentLearnings.map((l) => `- ${l}`).join("\n")}

Success criteria:
${component.successCriteria.map((c) => `- ${c}`).join("\n")}

Return JSON:
{
  "summary": "Comprehensive summary"
}
`;

  let finalSummary = `Findings for ${component.name}`;
  try {
    const sumRes = await generateObject({
      model,
      system: systemPrompt(),
      prompt: summaryPrompt,
      schema: z.object({
        summary: z.string(),
      }),
    });
    finalSummary = sumRes.object.summary;
  } catch (err) {
    console.error(`Summary error for "${component.name}":`, err);
  }

  const componentEndTime = Date.now();
  const timeSpent = componentEndTime - componentStartTime;

  if (stats.averageComponentTimeMs === 0) {
    stats.averageComponentTimeMs = timeSpent;
  } else {
    stats.averageComponentTimeMs =
      (stats.averageComponentTimeMs + timeSpent) / 2;
  }

  await onProgress?.(
    `Component "${component.name}" completed in ~${Math.round(timeSpent / 1000)}s (avg component ~${Math.round(
      stats.averageComponentTimeMs / 1000
    )}s)`
  );

  return {
    learnings: componentLearnings,
    visitedUrls: componentUrls,
    summary: finalSummary,
    timeSpent,
  };
}

//
// -- QUALITY CHECK ----------------------------------------------------------
//

/**
 * Check if a component meets its success criteria well enough
 */
export async function evaluateComponentQuality({
  component,
  componentResult,
  model,
  onProgress,
  remainingTime,
}: {
  component: ResearchComponent;
  componentResult: ComponentResult;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
  remainingTime: number;
}): Promise<{
  meetsQuality: boolean;
  missingElements: string[];
  additionalQueries: string[];
}> {
  await onProgress?.(`Evaluating quality for component: ${component.name}`);

  if (remainingTime < 3 * 60_000) {
    await onProgress?.("Time constraint: <3m left, skipping further quality checks");
    return {
      meetsQuality: true,
      missingElements: [],
      additionalQueries: [],
    };
  }

  const prompt = `
Evaluate whether these findings for "${component.name}" meet its success criteria:

Success criteria:
${component.successCriteria.map((c) => `- ${c}`).join("\n")}

Learnings:
${componentResult.learnings.map((l) => `- ${l}`).join("\n")}

Return JSON:
{
  "meetsQuality": true or false,
  "missingElements": [],
  "additionalQueries": []
}
`;

  try {
    const res = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        meetsQuality: z.boolean(),
        missingElements: z.array(z.string()),
        additionalQueries: z.array(z.string()),
      }),
    });
    return res.object;
  } catch (err) {
    console.error(`Quality eval error for "${component.name}":`, err);
    return {
      meetsQuality: true,
      missingElements: [],
      additionalQueries: [],
    };
  }
}

//
// -- DEEP RESEARCH QUERY (SUB-LEVEL) ----------------------------------------
//

/**
 * A lower-level function that does repeated web searches and analysis
 * for a given query at a certain breadth and depth
 */
export async function deepResearchQuery({
  query,
  breadth,
  depth,
  learnings,
  visitedUrls,
  model,
  firecrawl,
  onProgress,
  remainingTime,
  stats,
  mainTopic = "",
  component = null,
  gapDetails = {},
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings: string[];
  visitedUrls: string[];
  model: ReturnType<typeof createModel>;
  firecrawl: FirecrawlApp;
  onProgress?: (update: string) => Promise<void>;
  remainingTime?: number;
  stats: ResearchStats;
  mainTopic?: string;
  component?: ResearchComponent | null;
  gapDetails?: Record<string, string>;
}): Promise<{
  learnings: string[];
  visitedUrls: string[];
}> {
  let combinedLearnings = [...learnings];
  let combinedUrls = [...visitedUrls];

  for (let d = 0; d < depth; d++) {
    if (remainingTime && remainingTime < 20_000) {
      await onProgress?.("Time constraint: <20s, ending depth loop");
      break;
    }

    await onProgress?.(`Depth iteration: ${d + 1}/${depth}`);

    const iterationStart = Date.now();

    // Generate sub-queries
    const subQueries = await generateSubQueries({
      query,
      existingLearnings: combinedLearnings,
      model,
      count: breadth,
      mainTopic,
      component,
      gapDetails,
    });

    await onProgress?.(`Generated sub-queries (depth ${d + 1}): ${JSON.stringify(subQueries)}`);

    for (const sq of subQueries) {
      await onProgress?.(`Searching: ${sq}`);
      const result = await firecrawl.search(sq, {
        timeout: 15000,
        limit: 4,
        scrapeOptions: { formats: ["markdown"] },
      });

      const foundUrls = result.data.map((r) => r.url).filter((url): url is string => typeof url === 'string');
      const hasMeaningful = result.data.some(
        (r) => r.markdown && r.markdown.trim().length > 100
      );

      if (!hasMeaningful) {
        // Try fallback
        await onProgress?.(`No meaningful results for "${sq}", trying fallback...`);
        let simplified = sq.replace(/site:[^\s]+/gi, "").replace(/"/g, "");
        const words = simplified.split(" ").filter((w) => w.trim().length > 0);
        if (words.length > 4) {
          simplified = words.slice(0, 4).join(" ");
        }

        await onProgress?.(`Fallback query: "${simplified}"`);
        const retry = await firecrawl.search(simplified, {
          timeout: 15000,
          limit: 4,
          scrapeOptions: { formats: ["markdown"] },
        });
        if (
          retry.data.some((r) => r.markdown && r.markdown.trim().length > 100)
        ) {
          result.data = retry.data;
          foundUrls.length = 0;
          foundUrls.push(
            ...retry.data.map((r) => r.url).filter((url): url is string => typeof url === 'string')
          );
        } else {
          await onProgress?.("Still no meaningful results; skipping");
          continue;
        }
      }

      combinedUrls.push(...foundUrls);

      // Summarize
      const newLearnings = await summarizeSearchResults({
        query: sq,
        searchResult: result,
        model,
        onProgress,
        component,
      });
      combinedLearnings.push(...newLearnings);

      // Analyze & Plan
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
      if (!analysis.shouldContinue) {
        await onProgress?.("LLM indicated we should stop further queries.");
        return {
          learnings: combinedLearnings,
          visitedUrls: combinedUrls,
        };
      }

      if (analysis.nextSearchTopic.trim()) {
        query = analysis.nextSearchTopic.trim();
      }
    }

    const iterationEnd = Date.now();
    const iterationTime = iterationEnd - iterationStart;
    stats.completedIterations += 1;
    stats.totalIterationsTime += iterationTime;
    stats.iterationTimes.push(iterationTime);
    stats.averageIterationTimeMs =
      stats.totalIterationsTime / stats.completedIterations;

    await onProgress?.(
      `Depth iteration took ~${Math.round(iterationTime / 1000)}s (avg ~${Math.round(
        stats.averageIterationTimeMs / 1000
      )}s)`
    );

    // (Optional) mid-depth saturation check if needed
    if (component && d < depth - 1) {
      const saturEval = await evaluateComponentSaturation({
        component,
        learnings: combinedLearnings,
        completedIterations: d + 1,
        totalPlannedIterations: depth,
        model,
        onProgress,
      });
      gapDetails = saturEval.gapDetails;

      if (saturEval.isSaturated || saturEval.coveragePercentage >= 65) {
        await onProgress?.(
          `Mid-depth saturation >=65%. Exiting sub-queries for "${component.name}".`
        );
        break;
      }
    }
  }

  return {
    learnings: combinedLearnings,
    visitedUrls: combinedUrls,
  };
}

//
// -- SUB-QUERY GENERATION ---------------------------------------------------
//

/**
 * Generates "count" sub-queries for a given topic, referencing existing knowledge and potential gaps
 */
export async function generateSubQueries({
  query,
  existingLearnings,
  model,
  count,
  mainTopic = "",
  component = null,
  gapDetails = {},
}: {
  query: string;
  existingLearnings: string[];
  model: ReturnType<typeof createModel>;
  count: number;
  mainTopic?: string;
  component?: ResearchComponent | null;
  gapDetails?: Record<string, string>;
}): Promise<string[]> {
  const includeTopic =
    mainTopic && !query.toLowerCase().includes(mainTopic.toLowerCase());

  const componentContext = component
    ? `
This is part of the research component "${component.name}": ${component.description}

Success criteria:
${component.successCriteria.map((c) => `- ${c}`).join("\n")}
`
    : "";

  const relevantGaps = Object.entries(gapDetails)
    .filter(
      ([, details]) =>
        details !== "No coverage yet" &&
        details !== "Initial gap" &&
        details !== "Unknown gap; continuing"
    )
    .map(([crit, detail]) => `- ${crit}: ${detail}`)
    .join("\n");

  const gapContext =
    relevantGaps.length > 0
      ? `
RESEARCH GAPS to address:
${relevantGaps}
`
      : "";

  const prompt = `
You are generating up to ${count} search queries to gather more info about:
"${query}"

${
  includeTopic
    ? `Include references to "${mainTopic}" or synonyms for relevance.`
    : ""
}

${componentContext}${gapContext}

We already know:
${existingLearnings.slice(-7).map((l) => `- ${l}`).join("\n")}

Guidelines:
1. Each query: 2-5 words, no quotes/operators (except site:reddit.com or site:quora.com).
2. Aim to fill knowledge gaps or address success criteria.
3. Keep queries short & realistic.
4. Return JSON of the form:
{
  "queries": [
    { "query": "string", "reasoning": "why it's helpful" },
    ...
  ]
}
`;

  const obj = await generateObject({
    model,
    system: systemPrompt(),
    prompt,
    schema: z.object({
      queries: z.array(
        z.object({
          query: z.string(),
          reasoning: z.string(),
        })
      ),
    }),
  });

  return obj.object.queries.map((q) => q.query).slice(0, count);
}

//
// -- PROGRESSIVE REPORT BUILDING --------------------------------------------
//

export async function buildProgressiveReport({
  plan,
  componentResults,
  completedComponents,
  model,
  onProgress,
}: {
  plan: ResearchPlan;
  componentResults: Record<string, ComponentResult>;
  completedComponents: string[];
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
}): Promise<Record<string, string>> {
  await onProgress?.("Building progressive report...");

  const reportSections: Record<string, string> = {};

  for (const cName of completedComponents) {
    const component = plan.components.find((c) => c.name === cName);
    const result = componentResults[cName];
    if (!component || !result) continue;

    const prompt = `
Create a detailed section for the component "${component.name}":
Description: ${component.description}
Success criteria:
${component.successCriteria.map((s) => `- ${s}`).join("\n")}

Key findings:
${result.summary}

Detailed learnings:
${result.learnings.map((l) => `- ${l}`).join("\n")}

Organize this section in markdown with subheadings, ensuring all success criteria are addressed.

Return JSON:
{
  "sectionContent": "Section in Markdown"
}
`;

    try {
      const res = await generateObject({
        model,
        system: systemPrompt(),
        prompt,
        schema: z.object({
          sectionContent: z.string(),
        }),
      });
      reportSections[cName] = res.object.sectionContent;
      await onProgress?.(`Generated section for "${cName}"`);
    } catch (err) {
      console.error(`Section gen error for ${cName}:`, err);
      reportSections[cName] = `## ${cName}\n\n${result.summary}\n\n${result.learnings
        .map((x) => `- ${x}`)
        .join("\n")}`;
    }
  }

  return reportSections;
}

//
// -- FINAL REPORT -----------------------------------------------------------
//

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
  model,
  reportSections = {},
  plan = null,
  onProgress,
  anthropicApiKey,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  model: ReturnType<typeof createModel>;
  reportSections?: Record<string, string>;
  plan?: ResearchPlan | null;
  onProgress?: (update: string) => Promise<void>;
  anthropicApiKey?: string;
}) {
  const apiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await onProgress?.("Anthropic API key not found. Using fallback...");
    return fallbackReportGeneration({
      prompt,
      learnings,
      visitedUrls,
      model,
      reportSections,
      plan,
    });
  }

  const anthropic = new Anthropic({ apiKey });
  const usePlanBased = plan && Object.keys(reportSections).length > 0;

  let componentsXML = "";
  if (usePlanBased && plan) {
    componentsXML = plan.components
      .map((c) => {
        const section = reportSections[c.name] || "";
        return `
<component>
  <name>${c.name}</name>
  <description>${c.description}</description>
  <content>${section}</content>
  <success_criteria>${c.successCriteria.join("; ")}</success_criteria>
</component>
`;
      })
      .join("");
  }

  const sourcesSec = visitedUrls
    .map((u, i) => {
      const match = u.match(/https?:\/\/(?:www\.)?([^/]+)/);
      const domain = match ? match[1] : `Source ${i + 1}`;
      return `<source><url>${u}</url><title>${domain}</title></source>`;
    })
    .join("\n");

  const learnSec = learnings.map((l) => `<learning>${l}</learning>`).join("\n");

  // Prepare final prompt for Claude
  let promptForClaude: string;
  if (usePlanBased && plan) {
    promptForClaude = `
You are an expert research synthesizer. Create a comprehensive final report addressing:
<original_query>${prompt}</original_query>

<research_components>
  ${componentsXML}
</research_components>

<sources>
  ${sourcesSec}
</sources>

<learnings>
  ${learnSec}
</learnings>

Your final report should:
1. Directly answer the user's query
2. Provide a well-structured Markdown document with headings
3. Cite sources where relevant
4. Integrate component findings into a cohesive narrative
    `;
  } else {
    const shortLearnings = learnings.map((l) => `- ${l}`).join("\n");
    const shortSources = visitedUrls.map((u) => `- ${u}`).join("\n");
    promptForClaude = `
The user asked: "${prompt}"

Combined learnings from research:
${shortLearnings}

Sources visited:
${shortSources}

Write a final Markdown report with an introduction, main findings, and references.
`;
  }

  try {
    await onProgress?.("Generating final report with Claude...");
    let finalReport = "";

    const stream = await anthropic.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 50396,
      temperature: 1.0,
      system:
        "You are an expert research synthesizer creating a thorough, structured report.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: promptForClaude }],
        },
      ],
      thinking: { type: "enabled", budget_tokens: 6554 },
      stream: true,
    });

    let streamBuffer = "";
    const BUFFER_SIZE = 100;

    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        const text = ev.delta.text || "";
        finalReport += text;
        streamBuffer += text;

        if (streamBuffer.length >= BUFFER_SIZE) {
          if (streamBuffer.trim().length > 0) {
            await onProgress?.(`[CLAUDE STREAM] ${streamBuffer}`);
          }
          streamBuffer = "";
        }
      } else if (ev.type === "message_stop") {
        await onProgress?.("[CLAUDE] Stream complete.");
      }
    }

    if (streamBuffer.trim().length > 0) {
      await onProgress?.(`[CLAUDE STREAM] ${streamBuffer}`);
    }

    await onProgress?.(`Final report generated. Length=${finalReport.length} chars`);
    return finalReport;
  } catch (err) {
    console.error("Claude generation error:", err);
    await onProgress?.("Error from Claude API. Falling back to local generation...");
    return fallbackReportGeneration({
      prompt,
      learnings,
      visitedUrls,
      model,
      reportSections,
      plan,
    });
  }
}

/**
 * If Anthropic is unavailable or fails, use this fallback approach
 */
async function fallbackReportGeneration({
  prompt,
  learnings,
  visitedUrls,
  model,
  reportSections = {},
  plan = null,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  model: ReturnType<typeof createModel>;
  reportSections?: Record<string, string>;
  plan?: ResearchPlan | null;
}) {
  const bulletLearnings = learnings.map((l) => `- ${l}`).join("\n");
  const bulletSources = visitedUrls.map((u) => `- ${u}`).join("\n");

  const promptFallback = `
User's query: "${prompt}"

We have these combined learnings:
${bulletLearnings}

We visited these sources:
${bulletSources}

Write a final report in Markdown with:
- Introduction
- Key findings
- Potential next steps
- References listing visited URLs

Return JSON:
{
  "reportMarkdown": "..."
}
`;

  const res = await generateObject({
    model,
    system: systemPrompt(),
    prompt: promptFallback,
    schema: z.object({
      reportMarkdown: z.string(),
    }),
  });

  return res.object.reportMarkdown;
}

//
// -- IMPORTANCE SCORING -----------------------------------------------------
//

/**
 * Evaluate relative importance of components to guide time allocation
 */
export async function evaluateComponentImportance({
  components,
  mainObjective,
  model,
  onProgress,
}: {
  components: ResearchComponent[];
  mainObjective: string;
  model: ReturnType<typeof createModel>;
  onProgress?: (update: string) => Promise<void>;
}): Promise<Record<string, number>> {
  await onProgress?.(
    `Evaluating importance for ${components.length} components...`
  );

  const prompt = `
Our main research objective: "${mainObjective}"

We have these components:
${components.map((c) => `- ${c.name}: ${c.description}`).join("\n")}

Assign each component a score 0-100 indicating its importance. Sum ~100 total.

Return JSON:
{
  "scores": [
    {"component": "string", "score": number},
    ...
  ]
}
`;

  try {
    const resp = await generateObject({
      model,
      system: systemPrompt(),
      prompt,
      schema: z.object({
        scores: z.array(
          z.object({
            component: z.string(),
            score: z.number(),
          })
        ),
      }),
    });
    const scoresArray = resp.object.scores;
    const out: Record<string, number> = {};
    for (const s of scoresArray) {
      out[s.component] = s.score;
    }
    const display = Object.entries(out)
      .map(([k, v]) => `${k}: ${v.toFixed(1)}`)
      .join(", ");
    await onProgress?.(`Importance scores: ${display}`);
    return out;
  } catch (err) {
    console.error("evaluateComponentImportance error:", err);
    const eq = 100 / components.length;
    return components.reduce((acc, c) => {
      acc[c.name] = eq;
      return acc;
    }, {} as Record<string, number>);
  }
}

//
// -- OPTIONAL INITIAL PARALLEL RESEARCH PASS --------------------------------
//

/**
 * Run a quick pass (breadth=2, depth=1) on each component in parallel
 * to gather initial learnings and help rebalance the plan
 */
export async function initialParallelResearch({
  plan,
  model,
  firecrawl,
  onProgress,
  stats,
  mainTopic = "",
  maxDuration,
}: {
  plan: ResearchPlan;
  model: ReturnType<typeof createModel>;
  firecrawl: FirecrawlApp;
  onProgress?: (update: string) => Promise<void>;
  stats: ResearchStats;
  mainTopic?: string;
  maxDuration: number;
}): Promise<Record<string, ComponentResult>> {
  await onProgress?.(
    'Starting initial parallel "quick pass" for each component (breadth=2, depth=1)...'
  );

  const results: Record<string, ComponentResult> = {};
  const now = Date.now();

  // We'll do a single subQuestion for each component in parallel
  const tasks = plan.components.map(async (component) => {
    const start = Date.now();
    const question = component.subQuestions[0] || component.description;

    await onProgress?.(
      `[Parallel Pass] Quick check for "${component.name}" on subQuestion: "${question}"`
    );

    // Reuse deepResearchQuery with breadth=2, depth=1
    const mini = await deepResearchQuery({
      query: question,
      breadth: 2, // specifically 2 for the parallel pass
      depth: 1,
      learnings: [],
      visitedUrls: [],
      model,
      firecrawl,
      onProgress,
      stats,
      mainTopic,
    });

    const end = Date.now();
    const timeSpent = end - start;

    // Summarize this partial result
    const sumPrompt = `
Quick-pass partial findings for "${component.name}":
${mini.learnings.map((l) => `- ${l}`).join("\n")}

Return JSON:
{
  "summary": "Short summary"
}
`;
    let summary = `Initial pass for ${component.name}`;
    try {
      const sres = await generateObject({
        model,
        system: systemPrompt(),
        prompt: sumPrompt,
        schema: z.object({ summary: z.string() }),
      });
      summary = sres.object.summary;
    } catch (err) {
      console.error(`Quick summary error for ${component.name}:`, err);
    }

    return {
      name: component.name,
      result: {
        learnings: mini.learnings,
        visitedUrls: mini.visitedUrls,
        summary,
        timeSpent,
      },
    };
  });

  const resolved = await Promise.all(tasks);
  for (const item of resolved) {
    results[item.name] = item.result;
  }

  const totalTime = Date.now() - now;
  await onProgress?.(
    `Initial parallel pass finished in ~${Math.round(totalTime / 1000)}s total`
  );
  return results;
}

/**
 * Optional function to reorder or adjust plan after parallel pass
 */
export function rebalanceResearchPlan({
  plan,
  partialResults,
  importanceScores,
  onProgress,
}: {
  plan: ResearchPlan;
  partialResults: Record<string, ComponentResult>;
  importanceScores: Record<string, number>;
  onProgress?: (update: string) => Promise<void>;
}): ResearchPlan {
  // Example: reorder plan.sequencing so that higher-importance components come first
  const sortedSeq = [...plan.sequencing].sort((a, b) => {
    const scoreA = importanceScores[a] || 0;
    const scoreB = importanceScores[b] || 0;
    return scoreB - scoreA; // descending
  });

  onProgress?.(`Rebalanced sequencing based on importance: ${sortedSeq.join(" => ")}`);

  return { ...plan, sequencing: sortedSeq };
}

//
// -- MAIN ENTRY: deepResearch -----------------------------------------------
//

export async function deepResearch({
  query,
  breadth = 3,
  depth = 2,
  maxDuration = 30,
  componentDepthMultipliers = {},
  learnings = [],
  visitedUrls = [],
  onProgress,
  model,
  firecrawlKey,
  anthropicApiKey,
  testAnthropicMode = false,
  feedbackResponses = [],
}: DeepResearchOptions): Promise<{
  learnings: string[];
  visitedUrls: string[];
  researchPlan?: ResearchPlan;
  componentResults?: Record<string, ComponentResult>;
  timeStats?: {
    totalTime: number;
    componentTimes: Record<string, number>;
    completedComponents: string[];
    skippedComponents: string[];
    averageIterationTimeMs: number;
  };
  report?: string;
  apiTestResult?: {
    success: boolean;
    message: string;
  };
}> {
  // 1) If test mode, just test Anthropic API quickly
  if (testAnthropicMode) {
    await onProgress?.("Testing Anthropic API...");
    try {
      const testReport = await writeFinalReport({
        prompt: `Test query: ${query}`,
        learnings: ["Testing the Anthropic API streaming..."],
        visitedUrls: ["https://example.com/test"],
        model,
        onProgress,
        anthropicApiKey,
      });
      await onProgress?.("Anthropic test successful. Partial output:");
      await onProgress?.(testReport.slice(0, 500));
      return {
        learnings: ["Anthropic test successful"],
        visitedUrls: [],
        report: testReport,
        apiTestResult: {
          success: true,
          message: "Anthropic API working as expected",
        },
      };
    } catch (err) {
      const msg = (err as Error).message || "Unknown error";
      await onProgress?.(`Anthropic test failed: ${msg}`);
      return {
        learnings: [`Anthropic test failed: ${msg}`],
        visitedUrls: [],
        apiTestResult: {
          success: false,
          message: msg,
        },
      };
    }
  }

  // 2) Normal research process
  const firecrawl = getFirecrawl(firecrawlKey);
  const startTime = Date.now();

  const researchStats: ResearchStats = {
    averageIterationTimeMs: 60_000,
    averageComponentTimeMs: 180_000,
    completedIterations: 0,
    totalIterationsTime: 0,
    iterationTimes: [],
  };

  // 3) Create plan
  const plan = await createResearchPlan({ 
    query, 
    model, 
    onProgress,
    feedbackResponses 
  });
  
  if (feedbackResponses.length > 0) {
    await onProgress?.(`Created plan with ${plan.components.length} components, incorporating ${feedbackResponses.length} feedback responses. Time limit ~${maxDuration}m`);
  } else {
    await onProgress?.(
      `Created plan with ${plan.components.length} components. Time limit ~${maxDuration}m`
    );
  }

  // 4) Identify main topic from the plan
  const topicMatch = plan.mainObjective.match(
    /\b(about|on|for|regarding|of|into|analyzing)\s+([^,.]+)/i
  );
  const mainTopic = topicMatch ? topicMatch[2].trim() : "";
  if (mainTopic) {
    await onProgress?.(`Main topic recognized: "${mainTopic}"`);
  }

  // 5) Evaluate importance
  const importanceScores = await evaluateComponentImportance({
    components: plan.components,
    mainObjective: plan.mainObjective,
    model,
    onProgress,
  });

  // 6) Parallel quick pass with (breadth=2, depth=1) for each component
  const quickPassResults = await initialParallelResearch({
    plan,
    model,
    firecrawl,
    onProgress,
    stats: researchStats,
    mainTopic,
    maxDuration,
  });

  // Add those quick-pass learnings to our global arrays
  Object.entries(quickPassResults).forEach(([comp, res]) => {
    learnings.push(...res.learnings);
    visitedUrls.push(...res.visitedUrls);
  });

  // 7) Rebalance plan based on importance (and partial results if desired)
  const updatedPlan = rebalanceResearchPlan({
    plan,
    partialResults: quickPassResults,
    importanceScores,
    onProgress,
  });

  // Merge user-specified depth multipliers with dynamic
  const averageImp = 100 / updatedPlan.components.length;
  const finalDepthMults: Record<string, number> = {};
  for (const c of updatedPlan.components) {
    const imp = importanceScores[c.name] ?? averageImp;
    // scale 0.5..2.0
    const dynamicMult = 0.5 + (imp / averageImp) * 0.75;
    finalDepthMults[c.name] =
      componentDepthMultipliers[c.name] ?? dynamicMult;
    await onProgress?.(
      `Final depth multiplier for "${c.name}": ${finalDepthMults[c.name].toFixed(2)}`
    );
  }

  let timeState = updateResearchState({
    state: null,
    plan: updatedPlan,
    maxDuration,
  });

  // 8) Full research pass
  const componentResults: Record<string, ComponentResult> = {};
  const completedComponents: string[] = [];
  const skippedComponents: string[] = [];

  for (const cName of updatedPlan.sequencing) {
    const comp = updatedPlan.components.find((x) => x.name === cName);
    if (!comp) continue;

    timeState = updateResearchState({
      state: timeState,
      plan: updatedPlan,
      maxDuration,
    });

    const proceed = await shouldContinueComponent({
      componentName: cName,
      state: timeState,
      plan: updatedPlan,
      model,
      onProgress,
      stats: researchStats,
    });
    if (!proceed) {
      await onProgress?.(`Skipping "${cName}" due to time constraints`);
      skippedComponents.push(cName);
      continue;
    }

    const multiplier = finalDepthMults[cName] || 1.0;

    // We already did a mini pass. We can skip the first subQuestion because we used it in the parallel pass.
    const subQs = comp.subQuestions.slice(1);
    // Merge the quick pass result with the new deep pass:
    const quickData = quickPassResults[cName] || {
      learnings: [],
      visitedUrls: [],
      summary: "",
      timeSpent: 0,
    };

    const deepRes = await researchComponent({
      component: comp,
      subQuestions: subQs,
      breadth,
      depth,
      existingLearnings: learnings, // so it doesn't re-learn the same data
      model,
      firecrawl,
      onProgress,
      state: timeState,
      maxDuration,
      componentDepthMultiplier: multiplier,
      stats: researchStats,
      mainTopic,
    });

    // Merge
    componentResults[cName] = {
      learnings: [...quickData.learnings, ...deepRes.learnings],
      visitedUrls: [...quickData.visitedUrls, ...deepRes.visitedUrls],
      summary: deepRes.summary,
      timeSpent: quickData.timeSpent + deepRes.timeSpent,
    };
    completedComponents.push(cName);

    // Update time state
    timeState = updateResearchState({
      state: timeState,
      plan: updatedPlan,
      maxDuration,
      completedComponent: cName,
      timeSpent: componentResults[cName].timeSpent,
    });

    // Add to global
    learnings.push(...deepRes.learnings);
    visitedUrls.push(...deepRes.visitedUrls);

    // Check quality
    const remainingTime = timeState.remainingTime;
    const qc = await evaluateComponentQuality({
      component: comp,
      componentResult: componentResults[cName],
      model,
      onProgress,
      remainingTime,
    });
    if (!qc.meetsQuality && qc.additionalQueries.length > 0 && remainingTime > 3 * 60_000) {
      await onProgress?.(`Additional queries needed for "${cName}" -> ${qc.additionalQueries.join(", ")}`);
      // Only do 2 of them at most
      for (const addQ of qc.additionalQueries.slice(0, 2)) {
        const gapMap = qc.missingElements.reduce((acc, el) => {
          acc[el] = `Need more detail about ${el}`;
          return acc;
        }, {} as Record<string, string>);

        const addRes = await deepResearchQuery({
          query: addQ,
          breadth: 2,
          depth: 1,
          learnings,
          visitedUrls,
          model,
          firecrawl,
          onProgress,
          remainingTime: timeState.remainingTime,
          stats: researchStats,
          mainTopic,
          component: comp,
          gapDetails: gapMap,
        });

        componentResults[cName].learnings.push(...addRes.learnings);
        componentResults[cName].visitedUrls.push(...addRes.visitedUrls);
        learnings.push(...addRes.learnings);
        visitedUrls.push(...addRes.visitedUrls);
      }

      // Update summary
      const updPrompt = `
We have new findings for "${cName}":
${componentResults[cName].learnings.slice(-10).map((l) => `- ${l}`).join("\n")}

Old summary:
${componentResults[cName].summary}

Return JSON:
{
  "summary": "Updated summary"
}
`;
      try {
        const upd = await generateObject({
          model,
          system: systemPrompt(),
          prompt: updPrompt,
          schema: z.object({ summary: z.string() }),
        });
        componentResults[cName].summary = upd.object.summary;
      } catch (err) {
        console.error(`Summary update error for ${cName}:`, err);
      }
    }
  }

  const endTime = Date.now();
  const totalTime = endTime - startTime;

  const timeStats = {
    totalTime,
    componentTimes: Object.fromEntries(
      Object.entries(componentResults).map(([k, v]) => [k, v.timeSpent])
    ),
    completedComponents,
    skippedComponents,
    averageIterationTimeMs: researchStats.averageIterationTimeMs,
  };

  return {
    learnings,
    visitedUrls,
    researchPlan: updatedPlan,
    componentResults,
    timeStats,
  };
}
