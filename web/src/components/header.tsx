"use client";

import { ImageIcon, ListTodoIcon, Loader2Icon, PlayIcon, SparklesIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EngineStatus } from "@/lib/types";

interface Props {
  engine: EngineStatus | null;
  connected: boolean;
  onStartComfy: () => void;
  /** 상단 탭으로 옮긴 결과 패널 전환. 폼을 스크롤하지 않고도 완료 갤러리로 갈 수 있다. */
  resultsTab: string;
  onResultsTabChange: (value: string) => void;
  activeCount: number;
  doneCount: number;
}

export function Header({ engine, connected, onStartComfy, resultsTab, onResultsTabChange, activeCount, doneCount }: Props) {
  const comfy = engine?.comfy;
  const comfyState: "on" | "starting" | "off" | "unknown" = !comfy
    ? "unknown"
    : comfy.reachable
      ? "on"
      : comfy.starting
        ? "starting"
        : "off";

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4 lg:px-8">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <SparklesIcon className="size-4" />
          </span>
          <div className="leading-tight">
            <h1 className="font-heading text-base font-semibold">Qwen Image 2.1 Studio</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">Apple Silicon 로컬 이미지 생성</p>
          </div>
        </div>

        <Tabs value={resultsTab} onValueChange={(value) => onResultsTabChange(value as string)} className="ml-2 sm:ml-4">
          <TabsList>
            <TabsTrigger value="progress" className="gap-2">
              <ListTodoIcon />
              <span className="hidden sm:inline">진행 중</span>
              <span className="tabular-nums">{activeCount}</span>
            </TabsTrigger>
            <TabsTrigger value="gallery" className="gap-2">
              <ImageIcon />
              <span className="hidden sm:inline">완료 갤러리</span>
              <span className="tabular-nums">{doneCount}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="outline" className="hidden gap-1.5 sm:inline-flex">
                  <span
                    className={
                      "size-1.5 rounded-full " + (connected ? "bg-emerald-500" : "bg-muted-foreground/50")
                    }
                  />
                  {connected ? "실시간 연결" : "재연결 중"}
                </Badge>
              }
            />
            <TooltipContent>브라우저와 서버 사이의 실시간 이벤트 연결 상태</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant={comfyState === "on" ? "secondary" : "outline"} className="gap-1.5">
                  {comfyState === "starting" ? (
                    <Loader2Icon className="size-3 animate-spin" />
                  ) : (
                    <span
                      className={
                        "size-1.5 rounded-full " +
                        (comfyState === "on"
                          ? "bg-emerald-500"
                          : comfyState === "off"
                            ? "bg-red-500"
                            : "bg-muted-foreground/50")
                      }
                    />
                  )}
                  ComfyUI
                  {comfyState === "on" && comfy?.version ? (
                    <span className="text-muted-foreground">{comfy.version}</span>
                  ) : null}
                </Badge>
              }
            />
            <TooltipContent>
              {comfyState === "on"
                ? `ComfyUI 연결됨 · 대기열 ${comfy?.queueRemaining ?? 0}개`
                : comfyState === "starting"
                  ? "ComfyUI 서버를 시작하는 중입니다"
                  : comfyState === "off"
                    ? "ComfyUI 서버가 꺼져 있습니다. 생성을 시작하면 자동으로 켜집니다."
                    : "상태를 확인하는 중"}
            </TooltipContent>
          </Tooltip>

          {comfyState === "off" ? (
            <Button size="sm" variant="outline" onClick={onStartComfy}>
              <PlayIcon data-icon="inline-start" />
              ComfyUI 시작
            </Button>
          ) : null}

          <Badge variant="outline" className="hidden gap-1.5 md:inline-flex">
            <span
              className={
                "size-1.5 rounded-full " + (engine?.mflux.available ? "bg-emerald-500" : "bg-muted-foreground/50")
              }
            />
            mflux
          </Badge>

          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
