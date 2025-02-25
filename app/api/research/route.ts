import { NextRequest } from "next/server";

import {
  generateFeedback,
  parseResearchPlan,       // new
  deepResearchSubtopic,   // new, parallel sub-research
  mergeSubtopicReports,   // new final merging
} from "@/lib/deep-research";
import { createModel, type AIModel } from "@/lib/deep-research/ai/providers";

// Define interfaces for the types we need
interface Subtopic {
  name: string;
  [key: string]: any; // Allow for other properties
}

interface ResearchPlan {
  overarchingGoal: string;
  subtopics: Subtopic[];
  [key: string]: any; // Allow for other properties
}

export async function POST(req: NextRequest) {
  try {
    const { query, breadth = 3, depth = 2, modelId = "o3-mini" } =
      await req.json();

    const openaiKey = process.env.OPENAI_API_KEY;
    const firecrawlKey = process.env.FIRECRAWL_KEY;

    // If your .env sets NEXT_PUBLIC_ENABLE_API_KEYS=true, check them
    if (process.env.NEXT_PUBLIC_ENABLE_API_KEYS === "true") {
      if (!openaiKey || !firecrawlKey) {
        return new Response(
          JSON.stringify({ error: "API keys are required but not provided" }),
          { status: 401 }
        );
      }
    }

    console.log("\n🔬 [RESEARCH ROUTE] === Request Started ===");
    console.log("Query:", query);
    console.log("Model ID:", modelId);
    console.log("Configuration:", { breadth, depth });
    console.log("API Keys Present:", {
      OpenAI: openaiKey ? "✅" : "❌",
      FireCrawl: firecrawlKey ? "✅" : "❌",
    });

    try {
      const model = createModel(modelId as AIModel, openaiKey);
      console.log("\n🤖 [RESEARCH ROUTE] === Model Created ===");
      console.log("Using Model:", modelId);

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          console.log("\n🚀 [RESEARCH ROUTE] === Research Started ===");

          // 1) Possibly gather clarifying feedback (already done via /feedback).
          //    We'll assume the user has answered them if needed.
          //    We'll just store the final user "query" (plus answers) as input.

          // 2) Create a structured plan with an overarching goal, subtopics, sub-subtopics
          const plan = await parseResearchPlan({
            query,
            model,
          });
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "plan",
                content: plan,
              })}\n\n`
            )
          );

          // 3) For clarity, let's also generate "feedback" again for demonstration
          //    (In real usage, you might skip or have user answers. We'll just show how).
          const clarifyingQuestions = await generateFeedback({
            query,
            numQuestions: 2,
            modelId: modelId as AIModel,
            apiKey: openaiKey,
          });
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "progress",
                step: {
                  type: "query",
                  content: "Additional clarifying questions",
                },
                clarifyingQuestions,
              })}\n\n`
            )
          );

          // 4) If the plan has subtopics, let's do parallel deep research on each
          //    We'll gather the results for each subtopic
          const subtopicPromises = plan.subtopics.map((sub: Subtopic) =>
            deepResearchSubtopic({
              subtopic: sub,
              overarchingGoal: plan.overarchingGoal,
              breadth,
              depth,
              model,
              firecrawlKey,
              onProgress: async (update: string) => {
                console.log(`[${sub.name}] progress: ${update}`);
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "subtopic-progress",
                      subtopic: sub.name,
                      content: update,
                    })}\n\n`
                  )
                );
              },
            })
          );

          // Execute them in parallel
          const subtopicResults = await Promise.all(subtopicPromises);

          // 5) Merge all subtopics into a final integrated report
          const finalReport = await mergeSubtopicReports({
            plan,
            subtopicResults,
            model,
          });

          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "result",
                finalReport,
                subtopicResults,
              })}\n\n`
            )
          );
        } catch (error) {
          console.error("\n❌ [RESEARCH ROUTE] === Research Process Error ===");
          console.error(error);
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                message: "Research failed",
              })}\n\n`
            )
          );
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      console.error("\n💥 [RESEARCH ROUTE] === Route Error ===");
      console.error(error);
      return new Response(JSON.stringify({ error: "Research failed" }), {
        status: 500,
      });
    }
  } catch (error) {
    console.error("\n💥 [RESEARCH ROUTE] === Parse Error ===");
    console.error(error);
    return new Response(JSON.stringify({ error: "Research failed" }), {
      status: 500,
    });
  }
}
