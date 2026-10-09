import { NextResponse } from "next/server";
import { engineStatus } from "@/lib/server/queue";
import { checkCapacity } from "@/lib/server/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await engineStatus();
  // 남은 디스크와 대기열 여유를 함께 알려 화면에서 미리 경고할 수 있게 한다.
  return NextResponse.json({ ...status, capacity: checkCapacity(0) });
}
