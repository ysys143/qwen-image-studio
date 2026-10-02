/**
 * 작업 자동 재시도 정책.
 *
 * 실패한 작업을 그대로 방치하지 않고 정해진 횟수까지 다시 대기열에 넣는다.
 * 모두 실패하면 그때 failed 로 남긴다.
 */

/** 실패한 작업을 자동으로 다시 시도하는 최대 횟수 (최초 시도 포함). */
export const MAX_ATTEMPTS = Math.max(1, Number(process.env.QWEN_MAX_ATTEMPTS ?? 3) || 3);

/** 재시도 사이의 대기 시간 (지수 백오프, ms). attempt 는 1부터 시작한다. */
export function retryDelayMs(attempt: number): number {
  const base = Math.max(0, Number(process.env.QWEN_RETRY_DELAY_MS ?? 3000) || 0);
  return base * 2 ** Math.max(0, attempt - 1);
}
