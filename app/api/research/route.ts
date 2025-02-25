import { NextRequest } from "next/server";
import {
  deepResearch,
  generateFeedback,
  writeFinalReport,
} from "@/lib/deep-research";
import { createModel, type AIModel } from "@/lib/deep-research/ai/providers";
import { generateResearchParameters } from "@/lib/deep-research/feedback";

// Define the types for our events
type ProgressEvent = {
  type: string;
  step: {
    type: string;
    content: string;
  };
  [key: string]: any; // Allow any additional properties
};

export async function POST(req: NextRequest) {
  // Create an AbortController to handle connection termination
  const controller = new AbortController();
  const { signal } = controller;
  
  // Set a timeout to prevent hanging connections
  const timeout = setTimeout(() => {
    controller.abort();
    console.log("⏱️ [RESEARCH ROUTE] === Connection Timed Out ===");
  }, 30 * 60 * 1000); // 30 minutes timeout
  
  try {
    const {
      query,
      breadth,
      depth,
      maxDuration = 30, // Default 30 minutes max duration
      modelId = "o3-mini",
      dynamicParameters = true // Enable dynamic parameter generation by default
    } = await req.json();

    // Use environment variables directly instead of cookies
    const openaiKey = process.env.OPENAI_API_KEY;
    const firecrawlKey = process.env.FIRECRAWL_KEY;

    // Optional: If your .env sets NEXT_PUBLIC_ENABLE_API_KEYS=true, we require the keys
    if (process.env.NEXT_PUBLIC_ENABLE_API_KEYS === "true") {
      if (!openaiKey || !firecrawlKey) {
        return new Response(
          JSON.stringify({
            error: "API keys are required but not provided",
          }),
          { status: 401 }
        );
      }
    }

    console.log("\n🔬 [RESEARCH ROUTE] === Request Started ===");
    console.log("Query:", query);
    console.log("Model ID:", modelId);
    console.log("Max Duration:", maxDuration, "minutes");
    console.log("Dynamic Parameters:", dynamicParameters ? "Enabled" : "Disabled");
    
    if (breadth && depth) {
      console.log("Manual Configuration:", {
      breadth,
      depth,
    });
    }
    
    console.log("API Keys Present:", {
      OpenAI: openaiKey ? "✅" : "❌",
      FireCrawl: firecrawlKey ? "✅" : "❌",
    });

    try {
      // Create the chosen model instance
      const model = createModel(modelId as AIModel, openaiKey);
      console.log("\n🤖 [RESEARCH ROUTE] === Model Created ===");
      console.log("Using Model:", modelId);

      // Prepare server-sent events streaming
      const encoder = new TextEncoder();
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();

      // Helper function to safely write to the stream
      const safeWrite = async (writer: WritableStreamDefaultWriter<any>, data: Uint8Array) => {
        try {
          await writer.write(data);
          return true;
        } catch (e) {
          // Stream is closed or another error occurred
          console.warn("Stream write failed:", e);
          return false;
        }
      };

      // Helper function to safely close the stream
      const safeClose = async (writer: WritableStreamDefaultWriter<any>) => {
        try {
          await writer.close();
        } catch (e) {
          // Stream is already closed or another error occurred
          console.warn("Stream close failed:", e);
        }
      };

      // Listen for client disconnects
      req.signal.addEventListener('abort', () => {
        console.log("📡 [RESEARCH ROUTE] === Client Disconnected ===");
        controller.abort();
        clearTimeout(timeout);
        safeClose(writer);
      });

      (async () => {
        try {
          console.log("\n🚀 [RESEARCH ROUTE] === Research Started ===");

          // 1) Generate some clarifying feedback questions
          const feedbackQuestions = await generateFeedback({
            query,
            numQuestions: 3,
            modelId: modelId as AIModel,
            apiKey: openaiKey,
          });
          
          // Use the safe write helper instead of direct write
          await safeWrite(
            writer,
            encoder.encode(
              `data: ${JSON.stringify({
                type: "progress",
                step: {
                  type: "query",
                  content: "Generated feedback questions",
                },
                feedbackQuestions,
              })}\n\n`
            )
          );

          // 2) Dynamically generate research parameters if enabled and not manually set
          let effectiveBreadth = breadth;
          let effectiveDepth = depth;
          let componentDepthMultipliers = {};
          
          if (dynamicParameters && (!breadth || !depth)) {
            await safeWrite(
              writer,
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "progress",
                  step: {
                    type: "research",
                    content: "Generating optimal research parameters based on query complexity...",
                  },
                })}\n\n`
              )
            );
            
            const parameters = await generateResearchParameters({
              query,
              maxDuration,
              modelId: modelId as AIModel,
              apiKey: openaiKey,
            });
            
            effectiveBreadth = breadth || parameters.breadth;
            effectiveDepth = depth || parameters.depth;
            componentDepthMultipliers = parameters.componentDepthMultipliers;
            
            await safeWrite(
              writer,
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "progress",
                  step: {
                    type: "research",
                    content: `Determined optimal parameters: breadth=${effectiveBreadth}, depth=${effectiveDepth}, estimated time=${parameters.estimatedTimeMinutes} minutes`,
                  },
                  researchParameters: parameters,
                })}\n\n`
              )
            );
            
            console.log("\n🧠 [RESEARCH ROUTE] === Dynamic Parameters ===");
            console.log("Generated Parameters:", {
              breadth: effectiveBreadth,
              depth: effectiveDepth,
              componentDepthMultipliers: parameters.componentDepthMultipliers,
              estimatedTime: parameters.estimatedTimeMinutes,
              reasoning: parameters.reasoning,
            });
          }

          // 3) Perform a multi-step "deep" research
          console.log("\n🔍 [RESEARCH ROUTE] === Starting Deep Research ===");
          console.log("Parameters:", {
            breadth: effectiveBreadth || 3,
            depth: effectiveDepth || 2,
            maxDuration,
            dynamicParameters,
          });
          console.log("Time budget:", maxDuration, "minutes");
          
          // Create the enhanced deep research with component-based execution and time management
          const { learnings, visitedUrls, researchPlan, componentResults, timeStats } = await deepResearch({
            query,
            breadth: effectiveBreadth || 3,
            depth: effectiveDepth || 2,
            maxDuration,
            componentDepthMultipliers,
            model,
            firecrawlKey,
            onProgress: async (update: string) => {
              console.log("\n📊 [RESEARCH ROUTE] Progress Update:", update);
              
              // Create a more detailed event object based on the type of update
              let eventData: ProgressEvent = {
                    type: "progress",
                    step: {
                      type: "research",
                      content: update,
                    },
              };
              
              // Check for specific progress update types
              if (update.startsWith("Research plan revised:")) {
                // This is a plan revision update
                console.log("\n🔄 [RESEARCH ROUTE] === Plan Revision ===");
                console.log("Reason:", update.replace("Research plan revised:", "").trim());
                
                // Create a plan revision event
                eventData = {
                  type: "plan_revision",
                  step: {
                    type: "plan_update",
                    content: update,
                  },
                  reason: update.replace("Research plan revised:", "").trim()
                };
              } 
              else if (update.startsWith("Added components:")) {
                console.log("\n➕ [RESEARCH ROUTE] === Components Added ===");
                console.log(update.replace("Added components:", "").trim());
                
                // Create a components added event
                eventData = {
                  type: "plan_revision_detail",
                  step: {
                    type: "components_added",
                    content: update,
                  },
                  components: update.replace("Added components:", "").trim().split(', ')
                };
              }
              else if (update.startsWith("Modified components:")) {
                console.log("\n🔄 [RESEARCH ROUTE] === Components Modified ===");
                console.log(update.replace("Modified components:", "").trim());
                
                // Create a components modified event
                eventData = {
                  type: "plan_revision_detail",
                  step: {
                    type: "components_modified",
                    content: update,
                  },
                  components: update.replace("Modified components:", "").trim().split(', ')
                };
              }
              else if (update.startsWith("Sequencing changed:")) {
                console.log("\n🔄 [RESEARCH ROUTE] === Sequencing Changed ===");
                console.log(update.replace("Sequencing changed:", "").trim());
                
                // Create a sequencing changed event
                eventData = {
                  type: "plan_revision_detail",
                  step: {
                    type: "sequencing_changed",
                    content: update,
                  },
                  reason: update.replace("Sequencing changed:", "").trim()
                };
              }
              else if (update.startsWith("Previous sequence:") || update.startsWith("New sequence:")) {
                console.log("\n🔢 [RESEARCH ROUTE] === Sequence Info ===");
                console.log(update);
                
                // Create a sequence info event
                eventData = {
                  type: "plan_revision_detail",
                  step: {
                    type: "sequence_info",
                    content: update,
                  },
                  isNewSequence: update.startsWith("New sequence:")
                };
              }
              else if (update.startsWith("Researching component:")) {
                const componentName = update.replace("Researching component:", "").trim();
                
                // Send a simplified component update without requiring researchPlan
                eventData = {
                  type: "research_component_update",
                  step: {
                    type: "component_focus",
                    content: update,
                  },
                  currentComponent: componentName,
                };
              }
              else if (update.startsWith("Evaluating mid-component progress")) {
                console.log("\n📊 [RESEARCH ROUTE] === Mid-Component Evaluation ===");
                console.log(update);
                
                // Create a mid-component evaluation event
                eventData = {
                  type: "mid_component_evaluation",
                  step: {
                    type: "mid_eval",
                    content: update,
                  }
                };
              }
              else if (update.startsWith("Mid-component evaluation:")) {
                console.log("\n📊 [RESEARCH ROUTE] === Mid-Component Results ===");
                console.log(update);
                
                // Extract coverage percentage
                const coverageMatch = update.match(/(\d+)% coverage/);
                const coverage = coverageMatch ? parseInt(coverageMatch[1]) : null;
                
                // Extract decision
                const isSufficient = update.includes('Sufficient');
                
                // Extract reasoning
                const reasoningMatch = update.match(/Insufficient - (.*)/);
                const reasoning = reasoningMatch ? reasoningMatch[1] : 
                                 update.includes('Sufficient -') ? 
                                 update.match(/Sufficient - (.*)/)?.[1] || "" : "";
                
                // Create a mid-component results event
                eventData = {
                  type: "mid_component_results",
                  step: {
                    type: "mid_component_results",
                    content: update,
                  },
                  coverage,
                  isSufficient,
                  reasoning
                };
              }
              else if (update.startsWith("Research saturation detected:")) {
                console.log("\n🔍 [RESEARCH ROUTE] === Research Saturation ===");
                console.log(update);
                
                // Extract coverage percentage
                const coverageMatch = update.match(/(\d+)% of criteria covered/);
                const coverage = coverageMatch ? parseInt(coverageMatch[1]) : null;
                
                // Create a saturation event
                eventData = {
                  type: "research_saturation",
                  step: {
                    type: "saturation_detected",
                    content: update,
                  },
                  coverage
                };
              }
              else if (update.startsWith("Research progress:")) {
                console.log("\n📊 [RESEARCH ROUTE] === Research Progress ===");
                console.log(update);
                
                // Extract coverage percentage
                const coverageMatch = update.match(/(\d+)% criteria coverage/);
                const coverage = coverageMatch ? parseInt(coverageMatch[1]) : null;
                
                // Create a progress event
                eventData = {
                  type: "research_progress",
                  step: {
                    type: "progress_update",
                    content: update,
                  },
                  coverage
                };
              }
              else if (update.includes("Time constraint:")) {
                console.log("\n⏱️ [RESEARCH ROUTE] === Time Management ===");
                console.log(update);
                
                // Create a time constraint event
                eventData = {
                  type: "time_management",
                  step: {
                    type: "time_constraint",
                    content: update,
                  }
                };
              }
              else if (update.startsWith("Time analysis:")) {
                console.log("\n⏱️ [RESEARCH ROUTE] === Time Analysis ===");
                console.log(update);
                
                // Create a time analysis event
                eventData = {
                  type: "time_analysis",
                  step: {
                    type: "time_analysis",
                    content: update,
                  },
                  analysisDetail: update.replace("Time analysis:", "").trim()
                };
              }
              else if (update.startsWith("Component importance analysis:")) {
                console.log("\n📊 [RESEARCH ROUTE] === Component Importance ===");
                console.log(update);
                
                // Create a component importance event
                eventData = {
                  type: "component_importance",
                  step: {
                    type: "component_importance",
                    content: update,
                  },
                  analysisDetail: update.replace("Component importance analysis:", "").trim()
                };
              }
              else if (update.startsWith("Dynamic depth multiplier for")) {
                console.log("\n📊 [RESEARCH ROUTE] === Depth Adjustment ===");
                console.log(update);
                
                // Extract component and multiplier
                const match = update.match(/Dynamic depth multiplier for (.*): ([\d.]+)/);
                const component = match ? match[1] : null;
                const multiplier = match ? parseFloat(match[2]) : null;
                
                // Create a depth multiplier event
                eventData = {
                  type: "depth_adjustment",
                  step: {
                    type: "depth_multiplier",
                    content: update,
                  },
                  component,
                  multiplier
                };
              }
              else if (update.startsWith("Time management decision for")) {
                console.log("\n⏱️ [RESEARCH ROUTE] === Time Decision ===");
                console.log(update);
                
                // Extract component and decision
                const match = update.match(/Time management decision for (.*): (Continue|Skip) - (.*)/);
                const component = match ? match[1] : null;
                const decision = match ? match[2] : null;
                const reasoning = match ? match[3] : null;
                
                // Create a time decision event
                eventData = {
                  type: "time_decision",
                  step: {
                    type: "time_decision",
                    content: update,
                  },
                  component,
                  decision,
                  reasoning
                };
              }
              else if (update.startsWith("Iteration completed in")) {
                console.log("\n⏱️ [RESEARCH ROUTE] === Iteration Timing ===");
                console.log(update);
                
                // Extract timing information
                const durationMatch = update.match(/Iteration completed in (\d+) seconds/);
                const avgMatch = update.match(/avg: (\d+) seconds/);
                
                // Create a iteration timing event
                eventData = {
                  type: "iteration_timing",
                  step: {
                    type: "iteration_timing",
                    content: update,
                  },
                  duration: durationMatch ? parseInt(durationMatch[1]) : null,
                  averageDuration: avgMatch ? parseInt(avgMatch[1]) : null
                };
              }
              else if (update.startsWith("Component completed in")) {
                console.log("\n⏱️ [RESEARCH ROUTE] === Component Timing ===");
                console.log(update);
                
                // Extract timing information
                const durationMatch = update.match(/Component completed in (\d+) seconds/);
                const avgMatch = update.match(/avg component: (\d+) seconds/);
                
                // Create a component timing event
                eventData = {
                  type: "component_timing",
                  step: {
                    type: "component_timing",
                    content: update,
                  },
                  duration: durationMatch ? parseInt(durationMatch[1]) : null,
                  averageDuration: avgMatch ? parseInt(avgMatch[1]) : null
                };
              }
              
              // Send the event to the client
              await safeWrite(
                writer,
                encoder.encode(
                  `data: ${JSON.stringify(eventData)}\n\n`
                )
              );
            },
          });

          console.log("\n✅ [RESEARCH ROUTE] === Research Completed ===");
          console.log("Learnings Count:", learnings.length);
          console.log("Visited URLs Count:", visitedUrls.length);
          console.log("Research Plan Components:", researchPlan?.components.length || 0);
          
          if (timeStats) {
            console.log("\n⏱ [RESEARCH ROUTE] === Time Statistics ===");
            console.log("Total Research Time:", Math.round(timeStats.totalTime / 1000), "seconds");
            console.log("Average Iteration Time:", Math.round(timeStats.averageIterationTimeMs / 1000), "seconds");
            console.log("Completed Components:", timeStats.completedComponents.length);
            console.log("Skipped Components:", timeStats.skippedComponents.length);
            
            // Log detailed component times if available
            if (Object.keys(timeStats.componentTimes).length > 0) {
              console.log("\nComponent Times:");
              Object.entries(timeStats.componentTimes).forEach(([component, time]) => {
                console.log(`- ${component}: ${Math.round(time / 1000)} seconds`);
              });
            }
          }

          // 4) Send research plan to client for UI display
          await safeWrite(
            writer,
            encoder.encode(
              `data: ${JSON.stringify({
                type: "research_plan",
                researchPlan,
                timeStats,
              })}\n\n`
            )
          );

          // Now that we have the complete research plan, send it to the client
          if (researchPlan) {
            await safeWrite(
              writer,
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "research_plan_complete",
                  researchPlan,
                  timeStats,
                })}\n\n`
              )
            );
          }

          // 5) Write final summary "report" with component-based structure
          // Transform component results into the format expected by writeFinalReport
          const reportSections = componentResults ? 
            Object.entries(componentResults).reduce((acc, [key, value]) => {
              acc[key] = value.summary;
              return acc;
            }, {} as Record<string, string>) : 
            {};
            
          const report = await writeFinalReport({
            prompt: query,
            learnings,
            visitedUrls,
            model,
            reportSections,
            plan: researchPlan,
            onProgress: async (update) => {
              await safeWrite(
                writer,
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "progress",
                    step: { type: "report", content: update },
                  } as ProgressEvent)}\n\n`
                )
              );
            },
          });

          // 6) Stream the final result
          await safeWrite(
            writer,
            encoder.encode(
              `data: ${JSON.stringify({
                type: "result",
                feedbackQuestions,
                learnings,
                visitedUrls,
                report,
                researchPlan,
                timeStats,
              })}\n\n`
            )
          );
        } catch (error) {
          console.error("\n❌ [RESEARCH ROUTE] === Research Process Error ===");
          console.error("Error:", error);
          
          if ((error as any)?.name === 'AbortError' || signal.aborted) {
            console.log("🛑 [RESEARCH ROUTE] === Research Aborted ===");
            await safeWrite(
              writer,
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "error",
                  message: "Research was aborted",
                })}\n\n`
              )
            );
          } else {
            // Use safeWrite for error state too
            await safeWrite(
              writer,
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                message: "Research failed",
              })}\n\n`
            )
          );
          }
        } finally {
          // Clear the timeout to prevent memory leaks
          clearTimeout(timeout);
          
          // Use safeClose in finally block
          await safeClose(writer);
        }
      })();

      return new Response(stream.readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      // Clear the timeout in case of early error
      clearTimeout(timeout);
      
      console.error("\n💥 [RESEARCH ROUTE] === Route Error ===");
      console.error("Error:", error);
      return new Response(
        JSON.stringify({ error: "Research failed" }),
        { status: 500 }
      );
    }
  } catch (error) {
    // Clear the timeout in case of early error
    clearTimeout(timeout);
    
    console.error("\n💥 [RESEARCH ROUTE] === Parse Error ===");
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Research failed" }),
      { status: 500 }
    );
  }
}
