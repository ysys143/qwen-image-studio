import fs from "node:fs";
import path from "node:path";
import type { Job } from "@/lib/types";
import { publish } from "./events";
import { ensureDirs, JOBS_FILE } from "./paths";
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
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      console.error("[store] jobs.json 을 읽지 못했습니다:", err);
    }
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
      fs.writeFileSync(tmp, JSON.stringify({ jobs: this.list() }, null, 2));
      fs.renameSync(tmp, JOBS_FILE);
    } catch (err) {
      console.error("[store] jobs.json 저장 실패:", err);
    }
  }
}

const g = globalThis as unknown as { __qwenStore?: JobStore };
export const store: JobStore = (g.__qwenStore ??= new JobStore());
