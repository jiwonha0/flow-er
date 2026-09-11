import React, { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, SafeAreaView, View, Text, StyleSheet, Pressable, ScrollView, TextInput } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadUpcomingGoogleCalendarEvents } from './src/lib/googleCalendar';
import type { GoogleCalendarEvent } from './src/lib/googleCalendar';

type Task = { id: number; name: string; start: string; duration: number };
type TaskResult = 'done' | 'skipped';
type TaskHistoryEntry = { id: string; seconds: number; recordedAt: string; ignored?: boolean };
type TaskHistory = Record<string, TaskHistoryEntry[]>;
type PaceType = 'morning' | 'daytime' | 'cooking' | 'night';
type SavedRoutines = Record<PaceType, Task[]>;

const TASK_HISTORY_KEY = '@pacemaker/task-duration-history-v1';
const SAVED_ROUTINES_KEY = '@pacemaker/saved-routines-v1';
const MIN_LEARNING_SAMPLES = 3;
const MAX_HISTORY_SAMPLES = 10;
const MIN_RECORDABLE_SECONDS = 10;

const paceOptions: Record<PaceType, { title: string; description: string; icon: string }> = {
  morning: { title: '아침 외출 준비', description: '기상부터 집 밖으로 나가기까지', icon: '☀️' },
  daytime: { title: '일과 중 이동', description: '약속 장소로 출발하기 전 준비', icon: '🚶' },
  cooking: { title: '저녁 식사 요리', description: '재료 준비부터 식사 준비까지', icon: '🍳' },
  night: { title: '나이트 루틴', description: '하루를 마무리하고 잠들기까지', icon: '🌙' },
};

const defaultRoutines: SavedRoutines = {
  morning: [
    { id: 1, name: '기상', start: '', duration: 5 },
    { id: 2, name: '씻기', start: '', duration: 20 },
    { id: 3, name: '아침 식사', start: '', duration: 20 },
    { id: 4, name: '화장 / 준비', start: '', duration: 35 },
    { id: 5, name: '짐 챙기기', start: '', duration: 20 },
    { id: 6, name: '집 밖으로 나가기', start: '', duration: 10 },
  ],
  daytime: [
    { id: 11, name: '일정 확인', start: '', duration: 3 },
    { id: 12, name: '짐 챙기기', start: '', duration: 5 },
    { id: 13, name: '자리 정리', start: '', duration: 2 },
    { id: 14, name: '약속 장소로 이동', start: '', duration: 20 },
  ],
  cooking: [
    { id: 21, name: '메뉴 확인', start: '', duration: 5 },
    { id: 22, name: '재료 준비', start: '', duration: 10 },
    { id: 23, name: '재료 손질', start: '', duration: 15 },
    { id: 24, name: '요리하기', start: '', duration: 25 },
    { id: 25, name: '상 차리기', start: '', duration: 5 },
  ],
  night: [
    { id: 31, name: '씻기', start: '', duration: 20 },
    { id: 32, name: '스킨케어', start: '', duration: 10 },
    { id: 33, name: '내일 준비', start: '', duration: 10 },
    { id: 34, name: '휴대폰 정리', start: '', duration: 10 },
    { id: 35, name: '취침 준비', start: '', duration: 5 },
  ],
};

const copyRoutines = (routines: SavedRoutines): SavedRoutines => ({
  morning: routines.morning.map((task) => ({ ...task })),
  daytime: routines.daytime.map((task) => ({ ...task })),
  cooking: routines.cooking.map((task) => ({ ...task })),
  night: routines.night.map((task) => ({ ...task })),
});

const taskHistoryKey = (paceType: PaceType, taskName: string) => `${paceType}::${taskName.trim()}`;

const taskEntriesFor = (paceType: PaceType, taskName: string, history: TaskHistory) => (
  history[taskHistoryKey(paceType, taskName)] ?? []
);

const activeTaskEntriesFor = (paceType: PaceType, taskName: string, history: TaskHistory) => (
  taskEntriesFor(paceType, taskName, history).filter((entry) => !entry.ignored)
);

const taskSamplesFor = (paceType: PaceType, taskName: string, history: TaskHistory) => (
  activeTaskEntriesFor(paceType, taskName, history).map((entry) => entry.seconds)
);

const medianSeconds = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const isOutlierEntry = (entry: TaskHistoryEntry, allEntries: TaskHistoryEntry[]) => {
  if (entry.ignored) return false;
  const activeEntries = allEntries.filter((item) => !item.ignored);
  if (activeEntries.length < 4) return false;

  const comparisonSeconds = activeEntries
    .filter((item) => item.id !== entry.id)
    .map((item) => item.seconds);
  if (comparisonSeconds.length < 3) return false;

  const median = medianSeconds(comparisonSeconds);
  if (median <= 0) return false;

  const difference = Math.abs(entry.seconds - median);
  const isTooLong = entry.seconds >= median * 1.75 && difference >= 60;
  const isTooShort = entry.seconds <= median * 0.5 && difference >= 60;
  return isTooLong || isTooShort;
};

const learnedMinutesFor = (paceType: PaceType, taskName: string, history: TaskHistory) => {
  const samples = taskSamplesFor(paceType, taskName, history);
  if (samples.length < MIN_LEARNING_SAMPLES) return null;

  const recentSamples = samples.slice(-MAX_HISTORY_SAMPLES);
  const averageSeconds = recentSamples.reduce((sum, seconds) => sum + seconds, 0) / recentSamples.length;
  // 실제 기록을 너무 거칠게 1분 단위로 반올림하면 10~59초 기록이
  // 모두 1분으로 보이는 문제가 있어요. 30초 단위까지 반영합니다.
  return Math.max(0.5, Math.round(averageSeconds / 30) * 0.5);
};

const applyLearnedDurations = (paceType: PaceType, routine: Task[], history: TaskHistory) => (
  routine.map((item) => {
    const learnedMinutes = learnedMinutesFor(paceType, item.name, history);
    return learnedMinutes === null ? item : { ...item, duration: learnedMinutes };
  })
);

const parseAppointmentTime = (timeText: string) => {
  const matchedTime = timeText.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!matchedTime) return null;

  const hours = Number(matchedTime[1]);
  const minutes = Number(matchedTime[2]);
  if (hours > 23 || minutes > 59) return null;

  const appointmentAt = new Date();
  appointmentAt.setHours(hours, minutes, 0, 0);
  if (appointmentAt.getTime() <= Date.now()) {
    appointmentAt.setDate(appointmentAt.getDate() + 1);
  }
  return appointmentAt;
};

const formatClock = (date: Date) => {
  const hours = date.getHours();
  const period = hours < 12 ? '오전' : '오후';
  const displayHours = hours % 12 || 12;
  return `${period} ${displayHours}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const formatCountdown = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const formatDuration = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${secs}초` : `${secs}초`;
};

const formatMinutes = (seconds: number) => {
  const minutes = Math.max(0, seconds / 60);
  return `${Math.round(minutes * 10) / 10}분`;
};

const formatHistoryDate = (isoText: string) => {
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return '날짜 없음';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const historyEntryId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const remainingRoutineSeconds = (routine: Task[], fromIndex: number) => (
  routine.slice(fromIndex).reduce((total, item) => total + item.duration * 60, 0)
);

const plannedTaskStart = (routine: Task[], index: number, leaveAt: Date) => (
  new Date(leaveAt.getTime() - remainingRoutineSeconds(routine, index) * 1000)
);

const taskBudgetAt = (routine: Task[], index: number, leaveAt: Date, referenceTime: Date) => {
  const timeUntilLeave = (leaveAt.getTime() - referenceTime.getTime()) / 1000;
  const laterTasksSeconds = remainingRoutineSeconds(routine, index + 1);
  return Math.max(0, Math.floor(timeUntilLeave - laterTasksSeconds));
};

export default function App() {
  const routineListRef = useRef<any>(null);
  const [tasks, setTasks] = useState<Task[]>(defaultRoutines.morning.map((task) => ({ ...task })));
  const [draftTasks, setDraftTasks] = useState<Task[]>(defaultRoutines.morning.map((task) => ({ ...task })));
  const [savedRoutines, setSavedRoutines] = useState<SavedRoutines>(copyRoutines(defaultRoutines));
  const [selectedPaceType, setSelectedPaceType] = useState<PaceType | null>(null);
  const [isRoutinesReady, setIsRoutinesReady] = useState(false);
  const [isSetup, setIsSetup] = useState(true);
  const [isFinished, setIsFinished] = useState(false);
  const [draftTitle, setDraftTitle] = useState('강남역 약속');
  const [draftTime, setDraftTime] = useState('10:00');
  const [draftPlace, setDraftPlace] = useState('강남역');
  const [draftTravelMinutes, setDraftTravelMinutes] = useState('30');
  const [calendarEvents, setCalendarEvents] = useState<GoogleCalendarEvent[]>([]);
  const [isCalendarLoading, setIsCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState('');
  const [appointmentTitle, setAppointmentTitle] = useState('');
  const [appointmentTime, setAppointmentTime] = useState('');
  const [appointmentPlace, setAppointmentPlace] = useState('');
  const [travelMinutes, setTravelMinutes] = useState(30);
  const [leaveAt, setLeaveAt] = useState<Date | null>(null);
  const [planStartAt, setPlanStartAt] = useState<Date | null>(null);
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(new Date());
  const [currentTask, setCurrentTask] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [addedSeconds, setAddedSeconds] = useState(0);
  const [taskBudgetSeconds, setTaskBudgetSeconds] = useState(defaultRoutines.morning[0].duration * 60);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [results, setResults] = useState<Record<number, TaskResult>>({});
  const [taskHistory, setTaskHistory] = useState<TaskHistory>({});
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [isLearningScreen, setIsLearningScreen] = useState(false);
  const [isGuideScreen, setIsGuideScreen] = useState(false);
  const alarmPlayer = useAudioPlayer(require('./assets/alarm.wav'));

  const task = tasks[currentTask];
  const isWaiting = !isSetup && !isFinished && Boolean(planStartAt && now < planStartAt);
  const plannedSeconds = taskBudgetSeconds + addedSeconds;
  const isOvertime = elapsedSeconds >= plannedSeconds;
  const remainingSeconds = Math.max(plannedSeconds - elapsedSeconds, 0);
  const overtimeSeconds = Math.max(elapsedSeconds - plannedSeconds, 0);
  const remainingMinutes = Math.floor(remainingSeconds / 60);
  const remainingSecs = remainingSeconds % 60;
  const overtimeMinutes = Math.floor(overtimeSeconds / 60);
  const overtimeSecs = overtimeSeconds % 60;
  const progress = (Object.keys(results).length / tasks.length) * 100;

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (isSetup || isFinished || isWaiting) return;
    const timer = setInterval(() => setElapsedSeconds((previous) => previous + 1), 1000);
    return () => clearInterval(timer);
  }, [currentTask, isSetup, isFinished, isWaiting]);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  useEffect(() => {
    const loadSavedData = async () => {
      try {
        const [savedHistory, storedRoutines] = await Promise.all([
          AsyncStorage.getItem(TASK_HISTORY_KEY),
          AsyncStorage.getItem(SAVED_ROUTINES_KEY),
        ]);
        const rawHistory = savedHistory ? JSON.parse(savedHistory) : {};
        const parsedHistory: TaskHistory = Object.entries(rawHistory).reduce<TaskHistory>((result, [key, rawEntries]) => {
          const scopedKey = key.includes('::') ? key : taskHistoryKey('morning', key);
          const entriesArray = Array.isArray(rawEntries) ? rawEntries : [];
          result[scopedKey] = entriesArray
            .map((entry, index) => {
              if (typeof entry === 'number') {
                return {
                  id: `${scopedKey}-${index}-${entry}`,
                  seconds: entry,
                  recordedAt: new Date(Date.now() - (entriesArray.length - index) * 24 * 60 * 60 * 1000).toISOString(),
                  ignored: false,
                };
              }

              if (entry && typeof entry === 'object' && typeof entry.seconds === 'number') {
                return {
                  id: typeof entry.id === 'string' ? entry.id : `${scopedKey}-${index}-${entry.seconds}`,
                  seconds: Math.max(0, entry.seconds),
                  recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : new Date().toISOString(),
                  ignored: Boolean(entry.ignored),
                };
              }

              return null;
            })
            .filter((entry): entry is TaskHistoryEntry => entry !== null);
          return result;
        }, {});
        const parsedRoutines = storedRoutines ? JSON.parse(storedRoutines) : copyRoutines(defaultRoutines);
        const safeRoutines: SavedRoutines = {
          morning: Array.isArray(parsedRoutines.morning) ? parsedRoutines.morning : copyRoutines(defaultRoutines).morning,
          daytime: Array.isArray(parsedRoutines.daytime) ? parsedRoutines.daytime : copyRoutines(defaultRoutines).daytime,
          cooking: Array.isArray(parsedRoutines.cooking) ? parsedRoutines.cooking : copyRoutines(defaultRoutines).cooking,
          night: Array.isArray(parsedRoutines.night) ? parsedRoutines.night : copyRoutines(defaultRoutines).night,
        };
        setTaskHistory(parsedHistory);
        setSavedRoutines(safeRoutines);
        AsyncStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(parsedHistory)).catch(() => undefined);
      } catch {
        setTaskHistory({});
        setSavedRoutines(copyRoutines(defaultRoutines));
      } finally {
        setIsHistoryReady(true);
        setIsRoutinesReady(true);
      }
    };

    loadSavedData();
  }, []);

  useEffect(() => {
    if (!selectedPaceType || !isRoutinesReady) return;

    setSavedRoutines((previous) => {
      const nextRoutines = { ...previous, [selectedPaceType]: draftTasks.map((task) => ({ ...task })) };
      AsyncStorage.setItem(SAVED_ROUTINES_KEY, JSON.stringify(nextRoutines)).catch(() => undefined);
      return nextRoutines;
    });
  }, [draftTasks, selectedPaceType, isRoutinesReady]);

  useEffect(() => {
    if (!isSetup && !isFinished && !isWaiting && isOvertime) {
      alarmPlayer.loop = true;
      alarmPlayer.play();
      return;
    }

    alarmPlayer.pause();
    alarmPlayer.seekTo(0);
  }, [alarmPlayer, isFinished, isOvertime, isSetup, isWaiting]);

  const choosePaceType = (paceType: PaceType) => {
    setDraftTasks(applyLearnedDurations(paceType, savedRoutines[paceType], taskHistory));
    setSelectedPaceType(paceType);
  };

  const updateDraftTask = (id: number, field: 'name' | 'duration', value: string) => {
    setDraftTasks((previous) => previous.map((item) => (
      item.id === id ? { ...item, [field]: field === 'duration' ? Number(value) || 0 : value } : item
    )));
  };

  const removeDraftTask = (id: number) => {
    setDraftTasks((previous) => previous.length > 1 ? previous.filter((item) => item.id !== id) : previous);
  };

  const addDraftTask = () => {
    setDraftTasks((previous) => [...previous, { id: Date.now(), name: '새 준비 단계', start: '', duration: 10 }]);
    setTimeout(() => routineListRef.current?.scrollToEnd({ animated: true }), 150);
  };

  const moveDraftTask = (id: number, direction: -1 | 1) => {
    setDraftTasks((previous) => {
      const currentIndex = previous.findIndex((item) => item.id === id);
      const nextIndex = currentIndex + direction;

      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= previous.length) {
        return previous;
      }

      const nextTasks = [...previous];
      const currentItem = nextTasks[currentIndex];
      nextTasks[currentIndex] = nextTasks[nextIndex];
      nextTasks[nextIndex] = currentItem;

      return nextTasks;
    });
  };

  const recordCompletedTask = () => {
    const taskName = task.name.trim();
    if (!taskName || elapsedSeconds < MIN_RECORDABLE_SECONDS) return;

    const paceType = selectedPaceType ?? 'morning';
    const historyKey = taskHistoryKey(paceType, taskName);

    const nextHistory: TaskHistory = {
      ...taskHistory,
      [historyKey]: [
        ...(taskHistory[historyKey] ?? []),
        { id: historyEntryId(), seconds: elapsedSeconds, recordedAt: new Date().toISOString(), ignored: false },
      ].slice(-MAX_HISTORY_SAMPLES * 2),
    };

    setTaskHistory(nextHistory);
    setDraftTasks((previous) => applyLearnedDurations(paceType, previous, nextHistory));
    AsyncStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(nextHistory)).catch(() => undefined);
  };

  const excludeHistoryEntry = (paceType: PaceType, taskName: string, entryId: string) => {
    const historyKey = taskHistoryKey(paceType, taskName);
    const nextHistory: TaskHistory = {
      ...taskHistory,
      [historyKey]: (taskHistory[historyKey] ?? []).map((entry) => (
        entry.id === entryId ? { ...entry, ignored: true } : entry
      )),
    };

    setTaskHistory(nextHistory);
    if (selectedPaceType) {
      setDraftTasks((previous) => applyLearnedDurations(selectedPaceType, previous, nextHistory));
    }
    AsyncStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(nextHistory)).catch(() => undefined);
  };

  const startPlan = () => {
    const cleanedTasks = draftTasks
      .filter((item) => item.name.trim() !== '')
      .map((item) => ({ ...item, name: item.name.trim(), duration: item.duration > 0 ? item.duration : 5 }));
    if (cleanedTasks.length === 0) return;

    const parsedAppointmentAt = parseAppointmentTime(draftTime);
    if (!parsedAppointmentAt) {
      Alert.alert('약속 시간을 확인해주세요', '시간은 10:00처럼 24시간 형식으로 입력해주세요.');
      return;
    }

    const parsedTravelMinutes = Math.max(0, Math.round(Number(draftTravelMinutes) || 0));
    const parsedLeaveAt = new Date(parsedAppointmentAt.getTime() - parsedTravelMinutes * 60 * 1000);
    const parsedPlanStartAt = plannedTaskStart(cleanedTasks, 0, parsedLeaveAt);
    const referenceTime = new Date();
    const firstTaskReference = referenceTime < parsedPlanStartAt ? parsedPlanStartAt : referenceTime;
    const firstTaskBudget = taskBudgetAt(cleanedTasks, 0, parsedLeaveAt, firstTaskReference);

    setTasks(cleanedTasks);
    setAppointmentTitle(draftTitle || '약속');
    setAppointmentTime(formatClock(parsedAppointmentAt));
    setAppointmentPlace(draftPlace || '장소 미정');
    setTravelMinutes(parsedTravelMinutes);
    setLeaveAt(parsedLeaveAt);
    setPlanStartAt(parsedPlanStartAt);
    setFinishedAt(null);
    setCurrentTask(0);
    setElapsedSeconds(0);
    setAddedSeconds(0);
    setTaskBudgetSeconds(firstTaskBudget);
    setBufferSeconds(firstTaskBudget - cleanedTasks[0].duration * 60);
    setResults({});
    setIsFinished(false);
    setIsSetup(false);
  };

  const finishTask = (result: TaskResult) => {
    if (result === 'done') recordCompletedTask();
    setResults((previous) => ({ ...previous, [task.id]: result }));
    if (currentTask < tasks.length - 1) {
      const nextTaskIndex = currentTask + 1;
      const completionTime = new Date();
      if (leaveAt) {
        const nextTaskBudget = taskBudgetAt(tasks, nextTaskIndex, leaveAt, completionTime);
        setTaskBudgetSeconds(nextTaskBudget);
        setBufferSeconds(nextTaskBudget - tasks[nextTaskIndex].duration * 60);
      }
      setCurrentTask(nextTaskIndex);
      setElapsedSeconds(0);
      setAddedSeconds(0);
      return;
    }
    setFinishedAt(new Date());
    setIsFinished(true);
  };

  const returnToSetup = () => {
    setElapsedSeconds(0);
    setAddedSeconds(0);
    setIsSetup(true);
  };

  const forceStart = () => {
    const startTime = new Date();
    const firstTaskBudget = leaveAt
      ? taskBudgetAt(tasks, 0, leaveAt, startTime)
      : tasks[0].duration * 60;

    setNow(startTime);
    setPlanStartAt(startTime);
    setTaskBudgetSeconds(firstTaskBudget);
    setBufferSeconds(firstTaskBudget - tasks[0].duration * 60);
    setElapsedSeconds(0);
    setAddedSeconds(0);
  };

  const restart = () => {
    setCurrentTask(0);
    setElapsedSeconds(0);
    setAddedSeconds(0);
    setTaskBudgetSeconds(defaultRoutines.morning[0].duration * 60);
    setBufferSeconds(0);
    setResults({});
    setLeaveAt(null);
    setPlanStartAt(null);
    setFinishedAt(null);
    setIsFinished(false);
    setIsSetup(true);
  };

  const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

  const loadCalendarEvents = async () => {
    if (Platform.OS !== 'web') {
      Alert.alert('웹 버전에서 사용해주세요', '현재 Google Calendar 연결은 웹 버전부터 지원해요.');
      return;
    }

    setIsCalendarLoading(true);
    setCalendarError('');

    try {
      const events = await loadUpcomingGoogleCalendarEvents(googleWebClientId, 10);
      setCalendarEvents(events);
      if (events.length === 0) {
        setCalendarError('앞으로 예정된 일정을 찾지 못했어요.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google Calendar 연결 중 오류가 발생했어요.';
      setCalendarError(message);
      setCalendarEvents([]);
    } finally {
      setIsCalendarLoading(false);
    }
  };

  const chooseCalendarEvent = (event: GoogleCalendarEvent) => {
    setDraftTitle(event.title);
    setDraftPlace(event.location);

    if (!event.allDay) {
      const startDate = new Date(event.start);
      if (!Number.isNaN(startDate.getTime())) {
        setDraftTime(`${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`);
      }
    }

    setCalendarEvents([]);
    setCalendarError('');
  };

  const calendarEventTimeLabel = (event: GoogleCalendarEvent) => {
    if (event.allDay) return '종일 일정';
    const startDate = new Date(event.start);
    if (Number.isNaN(startDate.getTime())) return '';
    return `${startDate.getMonth() + 1}/${startDate.getDate()} ${formatClock(startDate)}`;
  };

  const renderRoutineItem = ({ item, drag, isActive, getIndex }: RenderItemParams<Task>) => {
    const paceType = selectedPaceType ?? 'morning';
    const samples = taskSamplesFor(paceType, item.name, taskHistory);
    const recentSamples = samples.slice(-MAX_HISTORY_SAMPLES);
    const averageSeconds = recentSamples.length > 0
      ? recentSamples.reduce((sum, seconds) => sum + seconds, 0) / recentSamples.length
      : 0;
    const learningStatus = samples.length === 0
      ? '완료 기록 없음'
      : samples.length < MIN_LEARNING_SAMPLES
        ? `완료 ${samples.length}회 · ${MIN_LEARNING_SAMPLES - samples.length}회 더 기록하면 반영`
        : `완료 ${samples.length}회 · 평균 ${formatDuration(averageSeconds)} 반영 중`;

    return (
    <View style={[styles.routineItem, isActive && styles.draggingItem]}>
      <Pressable
        style={styles.dragHandle}
        onLongPress={drag}
        delayLongPress={150}
        disabled={isActive}
      >
        <Text style={styles.dragHandleText}>☰</Text>
      </Pressable>

      <Text style={styles.routineNumber}>{(getIndex() ?? 0) + 1}</Text>

      <View style={styles.routineInputs}>
        <TextInput
          value={item.name}
          onChangeText={(value) => updateDraftTask(item.id, 'name', value)}
          style={styles.taskNameInput}
          placeholder="준비 단계"
        />
        <View style={styles.durationRow}>
          <TextInput
            value={String(item.duration)}
            onChangeText={(value) => updateDraftTask(item.id, 'duration', value)}
            style={styles.durationInput}
            keyboardType="decimal-pad"
          />
          <Text style={styles.minuteText}>분</Text>
          {samples.length >= MIN_LEARNING_SAMPLES && (
            <Text style={styles.learnedBadge}>최근 평균</Text>
          )}
        </View>
        <Text style={styles.learningInfo}>{learningStatus}</Text>
      </View>

      <Pressable style={styles.deleteTaskButton} onPress={() => removeDraftTask(item.id)}>
        <Text style={styles.deleteTaskText}>삭제</Text>
      </Pressable>
    </View>
    );
  };

  const renderSetupHeader = () => (
    <View>
      <View style={styles.setupTopRow}>
        <Text style={styles.logo}>PACE MAKER</Text>
        <View style={styles.headerActions}>
          <Pressable style={styles.learningRecordsButton} onPress={() => setIsGuideScreen(true)}>
            <Text style={styles.learningRecordsButtonText}>사용 방법</Text>
          </Pressable>
          <Pressable style={styles.learningRecordsButton} onPress={() => setIsLearningScreen(true)}>
            <Text style={styles.learningRecordsButtonText}>준비 기록</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.setupTitle}>오늘의 약속을 입력해주세요</Text>
      <Text style={styles.setupDescription}>약속을 기준으로 외출 준비의 페이스를 만들어드릴게요.</Text>

      <Pressable style={styles.paceBackButton} onPress={() => setSelectedPaceType(null)}>
        <Text style={styles.paceBackButtonText}>← 준비 페이스 선택</Text>
      </Pressable>

      {selectedPaceType && (
        <View style={styles.currentPaceCard}>
          <Text style={styles.currentPaceLabel}>현재 준비 페이스</Text>
          <Text style={styles.currentPaceValue}>
            {paceOptions[selectedPaceType].icon} {paceOptions[selectedPaceType].title}
          </Text>
        </View>
      )}

      {Platform.OS === 'web' && (
        <View style={styles.calendarCard}>
          <View style={styles.calendarCardHeader}>
            <View style={styles.calendarCardTextArea}>
              <Text style={styles.calendarCardTitle}>Google Calendar</Text>
              <Text style={styles.calendarCardDescription}>
                다가오는 일정을 선택하면 이름·시간·장소를 자동으로 채워요.
              </Text>
            </View>
            <Pressable
              style={[styles.calendarButton, isCalendarLoading && styles.calendarButtonDisabled]}
              onPress={loadCalendarEvents}
              disabled={isCalendarLoading}
            >
              <Text style={styles.calendarButtonText}>
                {isCalendarLoading ? '불러오는 중...' : '일정 불러오기'}
              </Text>
            </Pressable>
          </View>

          {calendarError !== '' && (
            <Text style={styles.calendarError}>{calendarError}</Text>
          )}

          {calendarEvents.length > 0 && (
            <View style={styles.calendarEventList}>
              {calendarEvents.map((event) => (
                <Pressable
                  key={event.id}
                  style={styles.calendarEventItem}
                  onPress={() => chooseCalendarEvent(event)}
                >
                  <View style={styles.calendarEventTextArea}>
                    <Text style={styles.calendarEventTitle}>{event.title}</Text>
                    <Text style={styles.calendarEventMeta}>
                      {calendarEventTimeLabel(event)}{event.location ? ` · ${event.location}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.calendarEventArrow}>›</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      <Text style={styles.inputLabel}>약속 이름</Text>
      <TextInput
        value={draftTitle}
        onChangeText={setDraftTitle}
        placeholder="예: 친구와 점심 약속"
        style={styles.input}
      />

      <Text style={styles.inputLabel}>약속 시간</Text>
      <TextInput
        value={draftTime}
        onChangeText={setDraftTime}
        placeholder="예: 10:00"
        keyboardType="numbers-and-punctuation"
        style={styles.input}
      />

      <Text style={styles.inputLabel}>약속 장소</Text>
      <TextInput
        value={draftPlace}
        onChangeText={setDraftPlace}
        placeholder="예: 강남역"
        style={styles.input}
      />

      <Text style={styles.inputLabel}>이동 시간</Text>
      <View style={styles.travelInputRow}>
        <TextInput
          value={draftTravelMinutes}
          onChangeText={setDraftTravelMinutes}
          placeholder="30"
          keyboardType="number-pad"
          style={[styles.input, styles.travelInput]}
        />
        <Text style={styles.travelUnit}>분</Text>
      </View>

      <Text style={styles.travelHint}>약속 시간에서 이동 시간을 뺀 시각을 ‘집 밖으로 나가기’ 마감으로 잡아요.</Text>

      <View style={styles.routineHeader}>
        <Text style={styles.routineTitle}>내 준비 루틴</Text>
        <Text style={styles.routineDescription}>
          {isHistoryReady
            ? '완료 기록 3회부터 최근 10회 평균 시간이 자동 반영돼요.'
            : '내 준비 기록을 불러오는 중이에요.'}
        </Text>
        <Text style={styles.dragHint}>
          {Platform.OS === 'web'
            ? '웹에서는 ↑↓ 버튼으로 순서를 바꿀 수 있어요.'
            : '☰을 길게 누른 채 끌어 순서를 바꿀 수 있어요.'}
        </Text>
      </View>
    </View>
  );

  const renderSetupFooter = () => (
    <View style={styles.routineFooter}>
      <Pressable style={styles.addTaskButton} onPress={addDraftTask}>
        <Text style={styles.addTaskText}>+ 준비 단계 추가</Text>
      </Pressable>
      <Pressable style={styles.startButton} onPress={startPlan}>
        <Text style={styles.startButtonText}>준비 페이스 시작하기 →</Text>
      </Pressable>
    </View>
  );



  const renderHistoryChart = (paceType: PaceType, taskName: string, entries: TaskHistoryEntry[]) => {
    const recentEntries = entries.slice(-MAX_HISTORY_SAMPLES);
    const chartWidth = 280;
    const chartHeight = 126;
    const chartPaddingX = 18;
    const chartPaddingY = 18;
    const maxSeconds = Math.max(60, ...recentEntries.map((entry) => entry.seconds));
    const usableWidth = chartWidth - chartPaddingX * 2;
    const usableHeight = chartHeight - chartPaddingY * 2 - 18;

    const points = recentEntries.map((entry, index) => {
      const x = chartPaddingX + (recentEntries.length <= 1 ? usableWidth / 2 : (usableWidth * index) / (recentEntries.length - 1));
      const y = chartPaddingY + usableHeight - (entry.seconds / maxSeconds) * usableHeight;
      const outlier = isOutlierEntry(entry, entries);
      return { entry, index, x, y, outlier };
    });

    const segments = points.slice(1).map((point, index) => {
      const previous = points[index];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      return { x: previous.x, y: previous.y, length, angle, key: `${previous.entry.id}-${point.entry.id}` };
    });

    if (recentEntries.length === 0) {
      return <Text style={styles.noHistoryText}>아직 그래프로 볼 기록이 없어요.</Text>;
    }

    return (
      <View>
        <View style={[styles.historyChart, { width: chartWidth, height: chartHeight }]}> 
          {segments.map((segment) => (
            <View
              key={segment.key}
              style={[
                styles.historyLine,
                {
                  left: segment.x,
                  top: segment.y,
                  width: segment.length,
                  transform: [{ rotate: `${segment.angle}deg` }],
                },
              ]}
            />
          ))}

          {points.map((point) => (
            <Pressable
              key={point.entry.id}
              style={[
                styles.historyPoint,
                { left: point.x - 7, top: point.y - 7 },
                point.outlier && styles.outlierPoint,
                point.entry.ignored && styles.ignoredPoint,
              ]}
              disabled={!point.outlier || point.entry.ignored}
              onPress={() => excludeHistoryEntry(paceType, taskName, point.entry.id)}
            >
              <Text style={styles.historyPointText}>{point.index + 1}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.historyChartLabels}>
          <Text style={styles.historyChartLabel}>{formatHistoryDate(recentEntries[0].recordedAt)}</Text>
          <Text style={styles.historyChartLabel}>{formatMinutes(maxSeconds)}</Text>
          <Text style={styles.historyChartLabel}>{formatHistoryDate(recentEntries[recentEntries.length - 1].recordedAt)}</Text>
        </View>
      </View>
    );
  };

  const learningTaskNamesFor = (paceType: PaceType) => Array.from(new Set([
    ...savedRoutines[paceType].map((item) => item.name.trim()).filter(Boolean),
    ...Object.keys(taskHistory)
      .filter((key) => key.startsWith(`${paceType}::`))
      .map((key) => key.slice(`${paceType}::`.length)),
  ]));

  if (isGuideScreen) {
    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaView style={styles.container}>
          <ScrollView contentContainerStyle={styles.guideScreenContent}>
            <Pressable style={styles.backButton} onPress={() => setIsGuideScreen(false)}>
              <Text style={styles.backButtonText}>← 약속 설정으로</Text>
            </Pressable>
            <Text style={styles.learningScreenTitle}>사용 방법</Text>
            <Text style={styles.learningScreenDescription}>약속에 맞춰 준비 시간을 관리하는 방법이에요.</Text>

            <View style={styles.guideCard}>
              <Text style={styles.guideNumber}>1</Text>
              <View style={styles.guideTextArea}>
                <Text style={styles.guideTitle}>약속과 이동 시간 입력</Text>
                <Text style={styles.guideText}>약속 시간에서 이동 시간을 뺀 시각까지 집을 나가는 것을 목표로 잡아요.</Text>
              </View>
            </View>
            <View style={styles.guideCard}>
              <Text style={styles.guideNumber}>2</Text>
              <View style={styles.guideTextArea}>
                <Text style={styles.guideTitle}>내 루틴 편집</Text>
                <Text style={styles.guideText}>단계를 추가·삭제하거나 시간을 바꿀 수 있어요. 웹에서는 ↑↓ 버튼, 앱에서는 ☰ 드래그로 순서를 바꿀 수 있어요.</Text>
              </View>
            </View>
            <View style={styles.guideCard}>
              <Text style={styles.guideNumber}>3</Text>
              <View style={styles.guideTextArea}>
                <Text style={styles.guideTitle}>준비 중 시간 확인</Text>
                <Text style={styles.guideText}>‘남은 시간’은 이번 단계의 남은 시간이에요. 여유 시간은 다음 단계에 사용할 수 있어요.</Text>
              </View>
            </View>
            <View style={styles.guideCard}>
              <Text style={styles.guideNumber}>4</Text>
              <View style={styles.guideTextArea}>
                <Text style={styles.guideTitle}>시간 학습</Text>
                <Text style={styles.guideText}>같은 준비 페이스의 같은 단계에서 10초 이상 걸린 완료 기록이 3회 쌓이면 최근 평균이 다음 루틴에 적용돼요.</Text>
              </View>
            </View>
            <View style={styles.guideCard}>
              <Text style={styles.guideNumber}>5</Text>
              <View style={styles.guideTextArea}>
                <Text style={styles.guideTitle}>알람과 버튼</Text>
                <Text style={styles.guideText}>시간을 넘기면 알람이 울려요. 완료, +5분, 건너뛰기로 다음 단계로 진행하세요.</Text>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  if (isLearningScreen) {
    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaView style={styles.container}>
          <ScrollView contentContainerStyle={styles.learningScreenContent}>
            <Pressable style={styles.backButton} onPress={() => setIsLearningScreen(false)}>
              <Text style={styles.backButtonText}>← 약속 설정으로</Text>
            </Pressable>
            <Text style={styles.learningScreenTitle}>준비 기록</Text>
            <Text style={styles.learningScreenDescription}>
              준비 페이스별 완료 기록을 그래프로 확인하고, 튀는 기록은 평균에서 제외할 수 있어요.
            </Text>

            {(Object.keys(paceOptions) as PaceType[]).map((paceType) => (
              <View key={paceType} style={styles.learningPaceSection}>
                <Text style={styles.learningPaceTitle}>
                  {paceOptions[paceType].icon} {paceOptions[paceType].title}
                </Text>
                {learningTaskNamesFor(paceType).map((taskName) => {
                  const entries = taskEntriesFor(paceType, taskName, taskHistory);
                  const activeEntries = entries.filter((entry) => !entry.ignored);
                  const samples = activeEntries.map((entry) => entry.seconds);
                  const recentSamples = samples.slice(-MAX_HISTORY_SAMPLES);
                  const averageSeconds = recentSamples.length > 0
                    ? recentSamples.reduce((sum, seconds) => sum + seconds, 0) / recentSamples.length
                    : 0;
                  const outlierCount = entries.filter((entry) => isOutlierEntry(entry, entries)).length;
                  const learnedMinutes = learnedMinutesFor(paceType, taskName, taskHistory);
                  const routineDuration = savedRoutines[paceType].find((item) => item.name.trim() === taskName)?.duration;

                  return (
                    <View key={`${paceType}-${taskName}`} style={styles.learningRecordCard}>
                      <View style={styles.learningRecordHeader}>
                        <Text style={styles.learningRecordName}>{taskName}</Text>
                        {outlierCount > 0 && <Text style={styles.outlierBadge}>이상치 {outlierCount}개 · 제거 권장</Text>}
                      </View>

                      <View style={styles.learningMetrics}>
                        <View>
                          <Text style={styles.learningMetricLabel}>평균 반영 기록</Text>
                          <Text style={styles.learningMetricValue}>{samples.length}회</Text>
                        </View>
                        <View>
                          <Text style={styles.learningMetricLabel}>최근 평균</Text>
                          <Text style={styles.learningMetricValue}>
                            {samples.length > 0 ? formatDuration(averageSeconds) : '-'}
                          </Text>
                        </View>
                      </View>

                      {renderHistoryChart(paceType, taskName, entries)}

                      <View style={styles.historyRecordList}>
                        {entries.slice(-MAX_HISTORY_SAMPLES).map((entry) => {
                          const outlier = isOutlierEntry(entry, entries);
                          return (
                            <View
                              key={entry.id}
                              style={[
                                styles.historyRecordRow,
                                outlier && styles.outlierRecordRow,
                                entry.ignored && styles.ignoredRecordRow,
                              ]}
                            >
                              <View style={styles.historyRecordTextArea}>
                                <Text style={styles.historyRecordDate}>{formatHistoryDate(entry.recordedAt)}</Text>
                                <Text style={styles.historyRecordDuration}>{formatMinutes(entry.seconds)}</Text>
                              </View>
                              {entry.ignored ? (
                                <Text style={styles.ignoredRecordText}>평균 제외됨</Text>
                              ) : outlier ? (
                                <Pressable
                                  style={styles.removeOutlierButton}
                                  onPress={() => excludeHistoryEntry(paceType, taskName, entry.id)}
                                >
                                  <Text style={styles.removeOutlierButtonText}>이상치 제거</Text>
                                </Pressable>
                              ) : (
                                <Text style={styles.normalRecordText}>정상 기록</Text>
                              )}
                            </View>
                          );
                        })}
                      </View>

                      <View style={styles.appliedDurationRow}>
                        <Text style={styles.appliedDurationLabel}>다음 루틴 적용 시간</Text>
                        <Text style={styles.appliedDurationValue}>
                          {learnedMinutes !== null
                            ? `${learnedMinutes}분`
                            : routineDuration !== undefined
                              ? `${routineDuration}분 (기본값)`
                              : '단계가 현재 루틴에 없음'}
                        </Text>
                      </View>
                      {samples.length > 0 && samples.length < MIN_LEARNING_SAMPLES && (
                        <Text style={styles.learningNeedMore}>
                          {MIN_LEARNING_SAMPLES - samples.length}회 더 완료하면 평균이 자동 반영돼요.
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  if (isSetup && !selectedPaceType) {
    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaView style={styles.container}>
          <ScrollView contentContainerStyle={styles.paceSelectionContent}>
            <Text style={styles.logo}>PACE MAKER</Text>
            <Text style={styles.setupTitle}>어떤 준비 페이스가{`\n`}필요한가요?</Text>
            <Text style={styles.setupDescription}>
              유형을 선택하면 그 상황에 맞는 기본 루틴을 불러와요.
            </Text>

            {(Object.keys(paceOptions) as PaceType[]).map((paceType) => {
              const option = paceOptions[paceType];
              return (
                <Pressable
                  key={paceType}
                  style={styles.paceTypeCard}
                  onPress={() => choosePaceType(paceType)}
                  disabled={!isRoutinesReady}
                >
                  <Text style={styles.paceTypeIcon}>{option.icon}</Text>
                  <View style={styles.paceTypeTextArea}>
                    <Text style={styles.paceTypeTitle}>{option.title}</Text>
                    <Text style={styles.paceTypeDescription}>{option.description}</Text>
                  </View>
                  <Text style={styles.paceTypeArrow}>›</Text>
                </Pressable>
              );
            })}

            {!isRoutinesReady && <Text style={styles.loadingText}>내 루틴을 불러오는 중이에요.</Text>}
          </ScrollView>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  if (isSetup) {
    if (Platform.OS === 'web') {
      return (
        <GestureHandlerRootView style={styles.gestureRoot}>
          <KeyboardAvoidingView style={styles.keyboardAvoiding}>
            <SafeAreaView style={styles.container}>
              <ScrollView
                contentContainerStyle={styles.setupContent}
                keyboardShouldPersistTaps="handled"
              >
                {renderSetupHeader()}

                {draftTasks.map((item, index) => (
                  <View key={item.id} style={styles.routineItem}>
                    <Text style={styles.routineNumber}>{index + 1}</Text>

                    <View style={styles.routineInputs}>
                      <TextInput
                        value={item.name}
                        onChangeText={(value) => updateDraftTask(item.id, 'name', value)}
                        style={styles.taskNameInput}
                        placeholder="준비 단계"
                      />

                      <View style={styles.durationRow}>
                        <TextInput
                          value={String(item.duration)}
                          onChangeText={(value) => updateDraftTask(item.id, 'duration', value)}
                          style={styles.durationInput}
                          keyboardType="decimal-pad"
                        />
                        <Text style={styles.minuteText}>분</Text>
                      </View>
                    </View>

                    <View style={styles.webOrderButtons}>
                      <Pressable
                        style={[styles.webOrderButton, index === 0 && styles.disabledOrderButton]}
                        onPress={() => moveDraftTask(item.id, -1)}
                        disabled={index === 0}
                      >
                        <Text style={styles.webOrderButtonText}>↑</Text>
                      </Pressable>

                      <Pressable
                        style={[styles.webOrderButton, index === draftTasks.length - 1 && styles.disabledOrderButton]}
                        onPress={() => moveDraftTask(item.id, 1)}
                        disabled={index === draftTasks.length - 1}
                      >
                        <Text style={styles.webOrderButtonText}>↓</Text>
                      </Pressable>
                    </View>

                    <Pressable style={styles.deleteTaskButton} onPress={() => removeDraftTask(item.id)}>
                      <Text style={styles.deleteTaskText}>삭제</Text>
                    </Pressable>
                  </View>
                ))}

                {renderSetupFooter()}
              </ScrollView>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </GestureHandlerRootView>
      );
    }

    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <KeyboardAvoidingView
          style={styles.keyboardAvoiding}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <SafeAreaView style={styles.container}>
            <DraggableFlatList
              ref={routineListRef}
              data={draftTasks}
              renderItem={renderRoutineItem}
              keyExtractor={(item) => String(item.id)}
              onDragEnd={({ data }) => setDraftTasks(data)}
              activationDistance={12}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.setupContent}
              ListHeaderComponent={renderSetupHeader}
              ListFooterComponent={renderSetupFooter}
            />
          </SafeAreaView>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    );
  }

  if (isWaiting && planStartAt && leaveAt) {
    const startInSeconds = (planStartAt.getTime() - now.getTime()) / 1000;

    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaView style={styles.container}>
          <View style={styles.waitingContent}>
            <Text style={styles.logo}>PACE MAKER</Text>
            <Text style={styles.waitingTitle}>아직 준비를{`\n`}시작할 시간이 아니에요</Text>
            <Text style={styles.waitingDescription}>
              {formatClock(planStartAt)}부터 첫 단계가 자동으로 시작돼요.
            </Text>

            <View style={styles.waitingTimerCard}>
              <Text style={styles.waitingTimer}>{formatCountdown(startInSeconds)}</Text>
              <Text style={styles.waitingTimerLabel}>준비 시작까지</Text>
            </View>

            <View style={styles.scheduleCard}>
              <Text style={styles.scheduleLabel}>집에서 나갈 목표</Text>
              <Text style={styles.scheduleValue}>{formatClock(leaveAt)}</Text>
              <Text style={styles.scheduleDescription}>
                약속 {appointmentTime} · 이동 {travelMinutes}분
              </Text>
            </View>

            <View style={styles.waitingActionRow}>
              <Pressable style={styles.waitingBackButton} onPress={returnToSetup}>
                <Text style={styles.waitingBackButtonText}>뒤로가기</Text>
              </Pressable>
              <Pressable style={styles.waitingStartButton} onPress={forceStart}>
                <Text style={styles.waitingStartButtonText}>지금 시작</Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  if (isFinished) {
    const departureDifferenceSeconds = leaveAt && finishedAt
      ? (leaveAt.getTime() - finishedAt.getTime()) / 1000
      : 0;

    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaView style={styles.container}>
          <View style={styles.finishedContent}>
            <Text style={styles.finishedEmoji}>🎉</Text>
            <Text style={styles.finishedTitle}>오늘의 준비 완료!</Text>
            <Text style={styles.finishedDescription}>
              {departureDifferenceSeconds >= 0
                ? `${formatDuration(departureDifferenceSeconds)} 일찍 집을 나갈 수 있어요.`
                : `${formatDuration(Math.abs(departureDifferenceSeconds))} 늦어졌어요.`}
              {`\n`}{appointmentPlace} 약속까지 이동 시간은 {travelMinutes}분이에요.
            </Text>
            <Pressable style={styles.startButton} onPress={restart}>
              <Text style={styles.startButtonText}>새 약속 만들기</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.date}>{selectedPaceType ? paceOptions[selectedPaceType].title : '오늘의 준비'}</Text>
        <View style={styles.appointmentCard}>
          <Text style={styles.smallLabel}>{selectedPaceType ? `${paceOptions[selectedPaceType].title} 목표` : '오늘의 약속'}</Text>
          <Text style={styles.appointment}>{appointmentTitle}</Text>
          <Text style={styles.subText}>{appointmentTime} · {appointmentPlace}</Text>
          {leaveAt && <Text style={styles.leaveText}>집에서 나갈 목표 · {formatClock(leaveAt)}</Text>}
        </View>

        <Text style={styles.sectionTitle}>지금 해야 할 일</Text>
        <View style={[styles.currentCard, isOvertime && styles.overtimeCard]}>
          <Text style={[styles.nowLabel, isOvertime && styles.overtimeText]}>NOW</Text>
          <Text style={styles.taskName}>{task.name}</Text>
          <Text style={styles.instruction}>
            기본 {task.duration}분 · 이번 단계 시간 {Math.max(0, Math.round(plannedSeconds / 60))}분
          </Text>

          <View style={styles.timerContainer}>
            {isOvertime ? (
              <>
                <Text style={styles.overtimeLabel}>예정 시간 초과</Text>
                <Text style={styles.overtimeTimer}>+{String(overtimeMinutes).padStart(2, '0')}:{String(overtimeSecs).padStart(2, '0')}</Text>
                <Text style={styles.timerLabel}>현재 단계에서 늦어지고 있어요</Text>
              </>
            ) : (
              <>
                <Text style={styles.timer}>{String(remainingMinutes).padStart(2, '0')}:{String(remainingSecs).padStart(2, '0')}</Text>
                <Text style={styles.timerLabel}>남은 시간</Text>
              </>
            )}
          </View>

          <View style={styles.progressBackground}>
            <View style={[styles.progressBar, isOvertime && styles.overtimeProgressBar, { width: `${plannedSeconds > 0 ? Math.max(0, (remainingSeconds / plannedSeconds) * 100) : 0}%` }]} />
          </View>

          <View style={[styles.bufferCard, bufferSeconds < 0 && styles.lateBufferCard]}>
            <Text style={[styles.bufferLabel, bufferSeconds < 0 && styles.lateBufferText]}>
              {bufferSeconds >= 0 ? '여유 시간' : '일정 지연'}
            </Text>
            <Text style={[styles.bufferValue, bufferSeconds < 0 && styles.lateBufferText]}>
              {bufferSeconds >= 0 ? '+' : '-'}{formatDuration(Math.abs(bufferSeconds))}
            </Text>
          </View>

          <View style={styles.actionRow}>
            <Pressable style={[styles.actionButton, styles.skipButton]} onPress={() => finishTask('skipped')}><Text style={styles.skipButtonText}>건너뛰기</Text></Pressable>
            <Pressable
              style={[styles.actionButton, styles.extendButton]}
              onPress={() => {
                setAddedSeconds((previous) => previous + 300);
                setBufferSeconds((previous) => previous - 300);
              }}
            ><Text style={styles.extendButtonText}>+5분</Text></Pressable>
            <Pressable style={[styles.actionButton, styles.completeButton]} onPress={() => finishTask('done')}><Text style={styles.completeButtonText}>완료</Text></Pressable>
          </View>
        </View>

        <View style={styles.progressSummary}>
          <Text style={styles.progressTitle}>오늘의 페이스</Text>
          <Text style={styles.progressPercent}>{Math.round(progress)}%</Text>
        </View>

        <View style={styles.timeline}>
          {tasks.map((item, index) => {
            const result = results[item.id];
            const isCurrent = index === currentTask;
            return (
              <View key={item.id} style={styles.timelineItem}>
                <View style={[styles.dot, result === 'done' && styles.doneDot, result === 'skipped' && styles.skippedDot, isCurrent && styles.currentDot]} />
                <View style={styles.timelineText}>
                  <Text style={[styles.timelineTask, result === 'done' && styles.doneText, result === 'skipped' && styles.skippedText, isCurrent && styles.currentText]}>{item.name}</Text>
                  <Text style={styles.timelineTime}>
                    {leaveAt ? `${formatClock(plannedTaskStart(tasks, index, leaveAt))} 시작 · ` : ''}기본 {item.duration}분
                  </Text>
                </View>
                {result === 'done' && <Text style={styles.resultText}>완료</Text>}
                {result === 'skipped' && <Text style={styles.resultText}>건너뜀</Text>}
              </View>
            );
          })}
        </View>
        </ScrollView>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: { flex: 1 },
  keyboardAvoiding: { flex: 1 },
  container: { flex: 1, backgroundColor: '#F7F8FC' },
  content: { padding: 20, paddingBottom: 40 },
  setupContent: { padding: 24, paddingTop: 60, paddingBottom: 180 },
  paceSelectionContent: { padding: 24, paddingTop: 76, paddingBottom: 48 },
  setupTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logo: { color: '#5A7D32', fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  learningRecordsButton: { backgroundColor: '#EAF4DE', borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8 },
  learningRecordsButtonText: { color: '#375A1F', fontSize: 12, fontWeight: '800' },
  paceBackButton: { alignSelf: 'flex-start', paddingVertical: 8, marginBottom: 10 },
  paceBackButtonText: { color: '#3C6B20', fontSize: 13, fontWeight: '800' },
  currentPaceCard: { alignSelf: 'flex-start', backgroundColor: '#EAF4DE', borderRadius: 13, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6 },
  currentPaceLabel: { color: '#527133', fontSize: 11, fontWeight: '700' },
  currentPaceValue: { color: '#294B17', fontSize: 14, fontWeight: '800', marginTop: 3 },
  calendarCard: { backgroundColor: '#FFF', borderRadius: 18, padding: 16, marginTop: 14, marginBottom: 4, borderWidth: 1, borderColor: '#E4E6EB' },
  calendarCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  calendarCardTextArea: { flex: 1 },
  calendarCardTitle: { color: '#171717', fontSize: 16, fontWeight: '800' },
  calendarCardDescription: { color: '#777', fontSize: 12, lineHeight: 18, marginTop: 4 },
  calendarButton: { backgroundColor: '#171717', borderRadius: 11, paddingHorizontal: 13, paddingVertical: 11 },
  calendarButtonDisabled: { opacity: 0.55 },
  calendarButtonText: { color: '#FFF', fontSize: 12, fontWeight: '800' },
  calendarError: { color: '#C44', fontSize: 12, lineHeight: 18, marginTop: 12 },
  calendarEventList: { marginTop: 12 },
  calendarEventItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F7F8FC', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, marginTop: 7 },
  calendarEventTextArea: { flex: 1 },
  calendarEventTitle: { color: '#171717', fontSize: 14, fontWeight: '800' },
  calendarEventMeta: { color: '#777', fontSize: 12, marginTop: 4 },
  calendarEventArrow: { color: '#829B68', fontSize: 24, marginLeft: 8 },
  setupTitle: { fontSize: 31, fontWeight: '800', color: '#171717', marginTop: 16 },
  setupDescription: { color: '#777', fontSize: 15, lineHeight: 22, marginTop: 12, marginBottom: 20 },
  paceTypeCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 20, padding: 18, marginBottom: 12 },
  paceTypeIcon: { fontSize: 28, marginRight: 14 },
  paceTypeTextArea: { flex: 1 },
  paceTypeTitle: { color: '#171717', fontSize: 17, fontWeight: '800' },
  paceTypeDescription: { color: '#777', fontSize: 13, marginTop: 5 },
  paceTypeArrow: { color: '#829B68', fontSize: 30, fontWeight: '300' },
  loadingText: { color: '#777', fontSize: 13, textAlign: 'center', marginTop: 12 },
  inputLabel: { color: '#333', fontSize: 14, fontWeight: '700', marginBottom: 8, marginTop: 16 },
  input: { backgroundColor: '#FFF', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 15, fontSize: 16, borderWidth: 1, borderColor: '#E4E6EB' },
  travelInputRow: { flexDirection: 'row', alignItems: 'center' },
  travelInput: { width: 100, textAlign: 'center' },
  travelUnit: { marginLeft: 10, color: '#555', fontSize: 15, fontWeight: '700' },
  travelHint: { color: '#888', fontSize: 12, lineHeight: 18, marginTop: 8 },
  startButton: { backgroundColor: '#171717', borderRadius: 15, alignItems: 'center', paddingVertical: 17, marginTop: 28 },
  startButtonText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  routineHeader: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 8, marginTop: 28 },
  routineFooter: { backgroundColor: '#FFF', borderBottomLeftRadius: 20, borderBottomRightRadius: 20, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 18 },
  routineTitle: { fontSize: 18, fontWeight: '800', color: '#171717' },
  routineDescription: { fontSize: 13, color: '#777', marginTop: 6, marginBottom: 16 },
  dragHint: { fontSize: 12, color: '#999', marginTop: -10, marginBottom: 16 },
  routineItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', paddingHorizontal: 18, paddingVertical: 6 },
  draggingItem: { backgroundColor: '#EAF4DE', opacity: 0.96, elevation: 6, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  dragHandle: { width: 30, alignItems: 'center', justifyContent: 'center', paddingVertical: 18, marginRight: 2 },
  dragHandleText: { fontSize: 19, color: '#8A8A8A', fontWeight: '700' },
  routineNumber: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#EAF4DE', color: '#375A1F', fontSize: 12, fontWeight: '800', textAlign: 'center', lineHeight: 24, marginRight: 9 },
  routineInputs: { flex: 1 },
  taskNameInput: { backgroundColor: '#F4F5F7', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 10, fontSize: 14 },
  durationRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  durationInput: { width: 58, backgroundColor: '#F4F5F7', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13, textAlign: 'center' },
  minuteText: { fontSize: 13, color: '#777', marginLeft: 6 },
  learnedBadge: { fontSize: 11, color: '#3C6B20', fontWeight: '800', marginLeft: 10, backgroundColor: '#EAF4DE', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8 },
  learningInfo: { fontSize: 11, color: '#888', marginTop: 6 },
  learningScreenContent: { padding: 24, paddingTop: 24, paddingBottom: 48 },
  guideScreenContent: { padding: 24, paddingTop: 24, paddingBottom: 48 },
  backButton: { alignSelf: 'flex-start', paddingVertical: 8, paddingRight: 12 },
  backButtonText: { color: '#3C6B20', fontSize: 14, fontWeight: '800' },
  learningScreenTitle: { color: '#171717', fontSize: 28, fontWeight: '800', marginTop: 18 },
  learningScreenDescription: { color: '#777', fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 24 },
  learningPaceSection: { marginBottom: 24 },
  learningPaceTitle: { color: '#171717', fontSize: 18, fontWeight: '800', marginBottom: 10 },
  learningRecordCard: { backgroundColor: '#FFF', borderRadius: 18, padding: 18, marginBottom: 12 },
  learningRecordName: { color: '#171717', fontSize: 18, fontWeight: '800' },
  learningMetrics: { flexDirection: 'row', gap: 42, marginTop: 16 },
  learningMetricLabel: { color: '#888', fontSize: 12 },
  learningMetricValue: { color: '#171717', fontSize: 18, fontWeight: '800', marginTop: 5 },
  appliedDurationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F1F7EA', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, marginTop: 16 },
  appliedDurationLabel: { color: '#527133', fontSize: 12, fontWeight: '700' },
  appliedDurationValue: { color: '#294B17', fontSize: 14, fontWeight: '800' },
  learningNeedMore: { color: '#888', fontSize: 12, marginTop: 11 },
  learningRecordHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  outlierBadge: { color: '#B85C00', backgroundColor: '#FFF1D7', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '800' },
  noHistoryText: { color: '#999', fontSize: 12, marginTop: 14 },
  historyChart: { position: 'relative', backgroundColor: '#F7F8FC', borderRadius: 16, marginTop: 16, overflow: 'hidden' },
  historyLine: { position: 'absolute', height: 2, backgroundColor: '#8BAE63' },
  historyPoint: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: '#5A7D32', alignItems: 'center', justifyContent: 'center' },
  outlierPoint: { backgroundColor: '#FF9C3A', width: 18, height: 18, borderRadius: 9 },
  ignoredPoint: { backgroundColor: '#BBB', opacity: 0.55 },
  historyPointText: { color: '#FFF', fontSize: 8, fontWeight: '800' },
  historyChartLabels: { width: 280, flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  historyChartLabel: { color: '#999', fontSize: 10 },
  historyRecordList: { marginTop: 12, gap: 7 },
  historyRecordRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F7F8FC', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  outlierRecordRow: { backgroundColor: '#FFF4E5', borderWidth: 1, borderColor: '#FFD59B' },
  ignoredRecordRow: { opacity: 0.55 },
  historyRecordTextArea: { flex: 1 },
  historyRecordDate: { color: '#777', fontSize: 12 },
  historyRecordDuration: { color: '#171717', fontSize: 15, fontWeight: '800', marginTop: 3 },
  removeOutlierButton: { backgroundColor: '#171717', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  removeOutlierButtonText: { color: '#FFF', fontSize: 11, fontWeight: '800' },
  normalRecordText: { color: '#888', fontSize: 11, fontWeight: '700' },
  ignoredRecordText: { color: '#888', fontSize: 11, fontWeight: '800' },
  guideCard: { flexDirection: 'row', backgroundColor: '#FFF', borderRadius: 18, padding: 18, marginBottom: 12 },
  guideNumber: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#EAF4DE', color: '#375A1F', fontSize: 13, lineHeight: 28, textAlign: 'center', fontWeight: '800', marginRight: 12 },
  guideTextArea: { flex: 1 },
  guideTitle: { color: '#171717', fontSize: 16, fontWeight: '800' },
  guideText: { color: '#777', fontSize: 13, lineHeight: 20, marginTop: 6 },
  deleteTaskButton: { marginLeft: 8, paddingHorizontal: 8, paddingVertical: 8 },
  deleteTaskText: { fontSize: 12, color: '#D85A5A', fontWeight: '700' },
  webOrderButtons: { marginLeft: 8, gap: 5 },
  webOrderButton: { width: 28, height: 28, borderRadius: 8, backgroundColor: '#EAF4DE', alignItems: 'center', justifyContent: 'center' },
  webOrderButtonText: { color: '#294B17', fontSize: 15, fontWeight: '800' },
  disabledOrderButton: { opacity: 0.35 },
  addTaskButton: { alignItems: 'center', paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: '#B9D89F', borderStyle: 'dashed', marginTop: 4 },
  addTaskText: { color: '#3C6B20', fontSize: 14, fontWeight: '800' },
  date: { fontSize: 15, color: '#666', marginBottom: 12 },
  appointmentCard: { backgroundColor: '#FFF', borderRadius: 20, padding: 20, marginBottom: 28 },
  smallLabel: { fontSize: 13, color: '#777', marginBottom: 6 },
  appointment: { fontSize: 24, fontWeight: '700', color: '#171717' },
  subText: { marginTop: 8, fontSize: 13, color: '#777' },
  leaveText: { marginTop: 13, color: '#3C6B20', fontSize: 13, fontWeight: '800' },
  sectionTitle: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  currentCard: { backgroundColor: '#171717', borderRadius: 24, padding: 24, marginBottom: 24 },
  overtimeCard: { backgroundColor: '#342121' },
  nowLabel: { color: '#A9F36B', fontWeight: '800', fontSize: 13, marginBottom: 8 },
  overtimeText: { color: '#FF9C9C' },
  taskName: { color: '#FFF', fontSize: 32, fontWeight: '800' },
  instruction: { color: '#BDBDBD', fontSize: 14, marginTop: 8 },
  timerContainer: { alignItems: 'center', marginVertical: 28 },
  timer: { color: '#FFF', fontSize: 52, fontWeight: '700', letterSpacing: 2 },
  overtimeLabel: { color: '#FF9C9C', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  overtimeTimer: { color: '#FF9C9C', fontSize: 52, fontWeight: '700', letterSpacing: 2 },
  timerLabel: { color: '#AAA', fontSize: 12, marginTop: 4 },
  progressBackground: { height: 6, backgroundColor: '#444', borderRadius: 3, overflow: 'hidden' },
  progressBar: { height: 6, backgroundColor: '#A9F36B' },
  overtimeProgressBar: { backgroundColor: '#FF8A8A' },
  bufferCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#253020', borderRadius: 14, padding: 14, marginTop: 16 },
  lateBufferCard: { backgroundColor: '#422828' },
  bufferLabel: { color: '#B7EE8B', fontSize: 13, fontWeight: '800' },
  bufferValue: { color: '#B7EE8B', fontSize: 18, fontWeight: '800' },
  lateBufferText: { color: '#FF9C9C' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 22 },
  actionButton: { flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 13 },
  skipButton: { backgroundColor: '#4A4A4A' },
  extendButton: { backgroundColor: '#DCEFCB' },
  completeButton: { backgroundColor: '#FFF' },
  skipButtonText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  extendButtonText: { color: '#294B17', fontSize: 14, fontWeight: '800' },
  completeButtonText: { color: '#171717', fontSize: 14, fontWeight: '800' },
  progressSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  progressTitle: { fontSize: 18, fontWeight: '700' },
  progressPercent: { fontSize: 18, fontWeight: '700' },
  timeline: { backgroundColor: '#FFF', borderRadius: 20, padding: 20 },
  timelineItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#D9D9D9', marginRight: 14 },
  currentDot: { backgroundColor: '#A9F36B' },
  doneDot: { backgroundColor: '#333' },
  skippedDot: { backgroundColor: '#FFB0B0' },
  timelineText: { flex: 1 },
  timelineTask: { fontSize: 15, fontWeight: '600', color: '#777' },
  currentText: { color: '#111' },
  doneText: { color: '#333', textDecorationLine: 'line-through' },
  skippedText: { color: '#999', textDecorationLine: 'line-through' },
  timelineTime: { fontSize: 12, color: '#999', marginTop: 3 },
  resultText: { fontSize: 12, color: '#777', fontWeight: '700' },
  finishedContent: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  finishedEmoji: { fontSize: 56, marginBottom: 16 },
  finishedTitle: { fontSize: 28, fontWeight: '800', color: '#171717' },
  finishedDescription: { textAlign: 'center', color: '#777', fontSize: 15, lineHeight: 23, marginTop: 14 },
  waitingContent: { flex: 1, padding: 28, paddingTop: 72 },
  waitingTitle: { color: '#171717', fontSize: 30, fontWeight: '800', marginTop: 16 },
  waitingDescription: { color: '#777', fontSize: 15, lineHeight: 22, marginTop: 14 },
  waitingTimerCard: { backgroundColor: '#171717', borderRadius: 24, alignItems: 'center', paddingVertical: 34, marginTop: 34 },
  waitingTimer: { color: '#FFF', fontSize: 43, fontWeight: '800', letterSpacing: 2 },
  waitingTimerLabel: { color: '#A9F36B', fontSize: 13, fontWeight: '800', marginTop: 8 },
  scheduleCard: { backgroundColor: '#FFF', borderRadius: 18, padding: 20, marginTop: 18 },
  scheduleLabel: { color: '#777', fontSize: 13 },
  scheduleValue: { color: '#171717', fontSize: 24, fontWeight: '800', marginTop: 6 },
  scheduleDescription: { color: '#777', fontSize: 13, marginTop: 8 },
  waitingActionRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  waitingBackButton: { flex: 1, alignItems: 'center', borderRadius: 14, backgroundColor: '#E5E7EA', paddingVertical: 15 },
  waitingBackButtonText: { color: '#444', fontSize: 15, fontWeight: '800' },
  waitingStartButton: { flex: 1, alignItems: 'center', borderRadius: 14, backgroundColor: '#171717', paddingVertical: 15 },
  waitingStartButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' },
});