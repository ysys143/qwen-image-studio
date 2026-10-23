import { triggerShutdown } from "./events";
import { store } from "./store";
import { comfy } from "./comfy";

/** 정리 뒤 Next 가 스스로 끝나길 기다리는 최대 시간. 남은 요청은 짧으므로 길게 잡을 이유가 없다. */
const FORCE_EXIT_MS = 1_500;
/** ComfyUI 에 모델 반환을 요청하고 기다리는 최대 시간. 응답이 없으면 그냥 끝낸다. */
const FREE_MEMORY_WAIT_MS = 3_000;

/**
 * 종료 신호 처리. 열린 SSE 연결을 끊고 작업 기록을 저장한 뒤 Next 의 정상 종료에 맡긴다.
 * Next 는 진행 중 요청이 끝나길 기다리므로 SSE 가 열려 있으면 Ctrl+C 로 끝나지 않는다.
 * 그래도 끝나지 않으면 잠시 후 강제로 끝낸다.
 */
export function installShutdownHandlers(): void {
  const g = globalThis as unknown as { __qwenShutdownHooked?: boolean };
  if (g.__qwenShutdownHooked) return;
  g.__qwenShutdownHooked = true;

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} 수신: 연결을 정리하고 종료합니다.`);
    try {
      triggerShutdown();
      store.flush();
      void import("./retention").then((m) => m.stopRetentionScheduler()).catch(() => undefined);
    } catch (err) {
      console.error("[server] 종료 정리 중 오류:", err);
    }
    // 프로세스를 내리기 전에 ComfyUI 가 붙들고 있는 모델을 반환한다.
    // 이걸 빠뜨리면 웹 앱만 죽고 모델 메모리는 남아 스왑이 풀리지 않는다.
    // 응답을 기다리되, 안 오면 정해진 시간 안에 그냥 끝낸다.
    const freeMemory = comfy.freeMemory(true).catch(() => false);
    const waited = Promise.race([
      freeMemory,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), FREE_MEMORY_WAIT_MS)),
    ]);
    void waited.then((ok) => {
      if (ok) console.log("[server] ComfyUI 모델 메모리를 반환했습니다.");
      setTimeout(() => {
        console.log(`[server] 정리를 마쳤습니다. 종료합니다.`);
        process.exit(0);
      }, FORCE_EXIT_MS).unref();
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
