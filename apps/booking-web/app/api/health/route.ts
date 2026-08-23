import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      buildSha: process.env.BOOKING_WEB_BUILD_SHA || "development",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
