import fs from "node:fs";
import path from "node:path";
import type { Job } from "@/lib/types";
import { publish } from "./events";
import { ensureDirs, JOBS_FILE, OUTPUTS_DIR, WEB_IMAGES_DIR } from "./paths";
import { readPngSize, stripPngTextChunks } from "./png";
import { decryptText, encryptText } from "./prompt-crypto";
import { MAX_ATTEMPTS } from "./retry";

export class JobStore {
  private jobs = new Map<string, Job>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    ensureDirs();
    this.load();
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  upsert(job: Job): Job {
    this.jobs.set(job.id, job);
    publish({ type: "job", job });
    this.scheduleSave();
    return job;
  }

  patch(id: string, update: (job: Job) => void): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    update(job);
    return this.upsert(job);
  }

  remove(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    this.jobs.delete(id);
    publish({ type: "job-removed", id });
    this.scheduleSave();
    return job;
  }

  private load(): void {
    if (!fs.existsSync(JOBS_FILE)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")) as { jobs?: Job[] };
      for (const job of raw.jobs ?? []) {
        // 프롬프트는 파일에 암호화해 둔다. 메모리로 올릴 때만 평문으로 되돌린다.
        job.params.prompt = decryptText(job.params.prompt);
        job.params.negativePrompt = decryptText(job.params.negativePrompt);
        // 재시도 예약 시각은 메모리에만 있던 값이다. 다시 뜬 서버에서는 곧바로 실행한다.
        job.retryAt = undefined;
        // 서버가 재시작되면 실행 중이던 작업은 이어갈 수 없다.
        // 자동 재시도 정책에 따라 대기열로 되돌리고, 시도 횟수를 소진하면 워커가 실패로 남긴다.
        if (job.status === "running") {
          job.status = "queued";
          job.error = undefined;
          job.finishedAt = undefined;
          job.progress = { step: 0, total: job.params.steps, phase: "queued" };
        } else if (job.status === "failed" && (job.attempts ?? 0) < MAX_ATTEMPTS) {
          // 이전 실패를 그대로 두지 않는다. 남은 시도가 있으면 다시 대기열에 넣는다.
          job.status = "queued";
          job.error = undefined;
          job.finishedAt = undefined;
          job.progress = { step: 0, total: job.params.steps, phase: "queued" };
        } else if (job.status === "failed" && !job.error) {
          // 자동 재시도가 재시작으로 끊겨 남긴, 원인이 기록되지 않은 실패는 사용자가 재시도할 수 있게 안내한다.
          job.error = "자동 재시도가 서버 재시작으로 중단되었습니다. 다시 시도해 주세요.";
        }
        // 생성은 끝났는데(저장된 출력 파일이 있음) 기록만 실패로 남은 작업을 되살린다.
        // 타임아웃으로 실패 처리되면서 이미지가 고아 파일로 남는 문제를 복구한다.
        if (job.status !== "done" && this.recoverSavedImage(job)) {
          job.status = "done";
          job.error = undefined;
          job.finishedAt = job.finishedAt ?? Date.now();
          job.progress = { step: job.params.steps, total: job.params.steps, phase: "finished" };
        }
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      console.error("[store] jobs.json 을 읽지 못했습니다:", err);
    }
  }

  /**
   * 작업의 출력 파일이 이미 있으면 `web/images/<id>.png` 로 옮기고 크기·용량을 채운다.
   * 이미 그 위치에 있으면 그대로 읽는다. 없으면 false.
   */
  private recoverSavedImage(job: Job): boolean {
    const dest = path.join(WEB_IMAGES_DIR, `${job.id}.png`);
    if (!fs.existsSync(/*turbopackIgnore: true*/ dest)) {
      const src = this.findSavedOutput(job.id);
      if (!src) return false;
      try {
        fs.mkdirSync(WEB_IMAGES_DIR, { recursive: true });
        fs.renameSync(src, dest);
      } catch (err) {
        console.error(`[store] 저장된 출력을 옮기지 못했습니다(${job.id}):`, err);
        return false;
      }
    }
    try {
      stripPngTextChunks(dest);
      const { width, height } = readPngSize(dest);
      if (!width || !height) return false;
      job.image = { file: dest, width, height, bytes: fs.statSync(dest).size };
      return true;
    } catch {
      return false;
    }
  }

  /** SaveImage 가 `web/<jobId>_NNNNN_.png` 로 남긴 파일 중 가장 최근 것을 찾는다. */
  private findSavedOutput(jobId: string): string | undefined {
    const dir = path.join(/*turbopackIgnore: true*/ OUTPUTS_DIR, "web");
    let names: string[];
    try {
      names = fs.readdirSync(/*turbopackIgnore: true*/ dir);
    } catch {
      return undefined;
    }
    const match = names
      .filter((n) => n.startsWith(`${jobId}_`) && n.toLowerCase().endsWith(".png"))
      .sort()
      .pop();
    return match ? path.join(/*turbopackIgnore: true*/ dir, match) : undefined;
  }

  /** 예약된 저장을 기다리지 않고 지금 디스크에 쓴다 (서버 종료 시). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 300);
  }

  private save(): void {
    try {
      ensureDirs();
      const tmp = path.join(path.dirname(JOBS_FILE), `.jobs.${process.pid}.tmp`);
      // 저장할 때만 프롬프트를 암호화한다. jobs.json 을 열어도 평문이 남지 않는다.
      const persisted = this.list().map((job) => ({
        ...job,
        params: {
          ...job.params,
          prompt: encryptText(job.params.prompt),
          negativePrompt: encryptText(job.params.negativePrompt),
        },
      }));
      fs.writeFileSync(tmp, JSON.stringify({ jobs: persisted }, null, 2));
      fs.renameSync(tmp, JOBS_FILE);
    } catch (err) {
      console.error("[store] jobs.json 저장 실패:", err);
    }
  }
}

const g = globalThis as unknown as { __qwenStore?: JobStore };
export const store: JobStore = (g.__qwenStore ??= new JobStore());
