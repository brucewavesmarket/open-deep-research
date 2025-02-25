import { NextRequest, NextResponse } from "next/server";
import { AIModel } from "@/lib/deep-research/ai/providers";
import { generateFeedback } from "@/lib/deep-research/feedback";

export async function POST(req: NextRequest) {
  try {
    const { query, numQuestions = 3, modelId = "o3-mini" } = await req.json();

    // Use environment variables (or secure cookies)
    const openaiKey = process.env.OPENAI_API_KEY;
    const firecrawlKey = process.env.FIRECRAWL_KEY;

    console.log("\n🔍 [FEEDBACK ROUTE] === Request Started ===");
    console.log("Query:", query);
    console.log("Model ID:", modelId);
    console.log("Number of Questions:", numQuestions);
    console.log("API Keys Present:", {
      OpenAI: openaiKey ? "✅" : "❌",
      FireCrawl: firecrawlKey ? "✅" : "❌",
    });

    try {
      // We updated generateFeedback to produce subtopic-friendly clarifications
      const questions = await generateFeedback({
        query,
        numQuestions,
        modelId: modelId as AIModel,
        apiKey: openaiKey,
      });

      console.log("\n✅ [FEEDBACK ROUTE] === Success ===");
      console.log("Generated Questions:", questions);

      return NextResponse.json({ questions });
    } catch (error) {
      console.error("\n❌ [FEEDBACK ROUTE] === Generation Error ===");
      console.error("Error:", error);
      throw error;
    }
  } catch (error) {
    console.error("\n💥 [FEEDBACK ROUTE] === Route Error ===");
    console.error("Error:", error);

    return NextResponse.json(
      {
        error: "Feedback generation failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
