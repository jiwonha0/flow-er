export type PaceColor = "green" | "yellow" | "red" | "gray";

export type RoutineStep = {
  id: string;
  label: string;
  defaultMinutes: number;
};

export type CompletionRecord = {
  stepId: string;
  actualMinutes: number;
  completedAt: string;
};

export type PlannedStep = RoutineStep & {
  suggestedMinutes: number;
  startAt: Date;
  endAt: Date;
};

export type RoutinePlan = {
  eventStartAt: Date;
  leaveHomeAt: Date;
  travelMinutes: number;
  travelBufferMinutes: number;
  steps: PlannedStep[];
};

export const DEFAULT_ROUTINE: RoutineStep[] = [
  { id: "breakfast", label: "아침 식사", defaultMinutes: 20 },
  { id: "shower", label: "샤워·씻기", defaultMinutes: 25 },
  { id: "get-ready", label: "화장·옷 입기", defaultMinutes: 25 },
  { id: "pack", label: "짐 챙기기", defaultMinutes: 10 }
];

const MIN_SUGGESTED_MINUTES = 3;
const HISTORY_SAMPLE_SIZE = 5;

/**
 * 초반에는 기본 템플릿을 유지하고, 기록이 쌓일수록 실제 시간을 더 크게 반영한다.
 * 머신러닝 모델 없이도 사용자가 느끼기에 충분히 개인화된 MVP 방식이다.
 */
export function getSuggestedMinutes(
  step: RoutineStep,
  records: CompletionRecord[]
): number {
  const recent = records
    .filter((record) => record.stepId === step.id)
    .slice(-HISTORY_SAMPLE_SIZE)
    .map((record) => record.actualMinutes);

  if (recent.length === 0) return step.defaultMinutes;

  const average = recent.reduce((sum, minutes) => sum + minutes, 0) / recent.length;
  const personalWeight = Math.min(recent.length / HISTORY_SAMPLE_SIZE, 1);
  const blended =
    step.defaultMinutes * (1 - personalWeight) + average * personalWeight;

  return Math.max(MIN_SUGGESTED_MINUTES, Math.round(blended));
}

export function createRoutinePlan({
  eventStartAt,
  travelMinutes,
  travelBufferMinutes,
  routine,
  records
}: {
  eventStartAt: Date;
  travelMinutes: number;
  travelBufferMinutes: number;
  routine: RoutineStep[];
  records: CompletionRecord[];
}): RoutinePlan {
  const leaveHomeAt = new Date(
    eventStartAt.getTime() - (travelMinutes + travelBufferMinutes) * 60_000
  );
  let cursor = leaveHomeAt.getTime();

  const steps = [...routine]
    .reverse()
    .map((step) => {
      const suggestedMinutes = getSuggestedMinutes(step, records);
      const endAt = new Date(cursor);
      const startAt = new Date(cursor - suggestedMinutes * 60_000);
      cursor = startAt.getTime();

      return { ...step, suggestedMinutes, startAt, endAt };
    })
    .reverse();

  return {
    eventStartAt,
    leaveHomeAt,
    travelMinutes,
    travelBufferMinutes,
    steps
  };
}

export function getPaceColor({
  now,
  step,
  completed
}: {
  now: Date;
  step: PlannedStep;
  completed: boolean;
}): PaceColor {
  if (completed) return "gray";
  if (now < step.startAt) return "gray";

  const elapsed = now.getTime() - step.startAt.getTime();
  const planned = step.endAt.getTime() - step.startAt.getTime();
  const progress = elapsed / planned;

  if (progress <= 0.72) return "green";
  if (progress <= 1) return "yellow";
  return "red";
}

export function formatClock(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
