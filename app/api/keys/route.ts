import { NextRequest, NextResponse } from "next/server";

// Handle GET requests to check keys and POST/DELETE to set/remove keys
export async function GET(req: NextRequest) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const firecrawlKey = process.env.FIRECRAWL_KEY;
  const keysPresent = Boolean(openaiKey && firecrawlKey);
  return NextResponse.json({ keysPresent });
}

export async function POST(req: NextRequest) {
  try {
    const { openaiKey, firecrawlKey } = await req.json();
    // Validate keys match environment variables
    if (openaiKey !== process.env.OPENAI_API_KEY || firecrawlKey !== process.env.FIRECRAWL_KEY) {
      return NextResponse.json({ error: "Invalid API keys" }, { status: 401 });
    }
    const response = NextResponse.json({ success: true });
    response.cookies.set("openai-key", openaiKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      sameSite: "strict",
    });
    response.cookies.set("firecrawl-key", firecrawlKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      sameSite: "strict",
    });
    return response;
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to set API keys" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const response = NextResponse.json({ success: true });
    response.cookies.delete("openai-key");
    response.cookies.delete("firecrawl-key");
    return response;
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to remove API keys" },
      { status: 500 }
    );
  }
}
