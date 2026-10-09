/** 서버 인스턴스가 뜰 때 한 번 실행된다 (Next instrumentation 관례). Node 런타임에서만 종료 처리를 건다. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installShutdownHandlers } = await import("@/lib/server/shutdown");
  installShutdownHandlers();
  // 대기열 상한·디스크 하한·참조 이미지 정리 정책을 상시 돌린다.
  const { startRetentionScheduler } = await import("@/lib/server/retention");
  startRetentionScheduler();
}
