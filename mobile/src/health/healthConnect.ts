/**
 * Health Connect 에서 하루 단위 지표를 읽어 온다.
 *
 * 이 파일이 앱에서 가장 불확실한 부분이다.
 * Health Connect 는 네이티브 모듈이라 Expo Go 에서는 동작하지 않고 development build 가 필요하다.
 * 그리고 기기에 Health Connect 앱이 설치돼 있어야 한다(Android 14 미만은 Play 스토어에서 설치).
 */
import {
  initialize,
  requestPermission,
  readRecords,
  getSdkStatus,
  SdkAvailabilityStatus,
  type Permission,
} from 'react-native-health-connect';

/** 읽기만 한다. 쓰기 권한은 요청하지 않는다. */
export const PERMISSIONS: Permission[] = [
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'SleepSession' },
  { accessType: 'read', recordType: 'Weight' },
];

export type DailyMetric = {
  /** YYYY-MM-DD, 기기 로컬 타임존 기준 */
  date: string;
  restingHr?: number;
  /** Android 는 RMSSD 로 준다. iOS 의 SDNN 과 서로 변환되지 않는다. */
  hrvRmssd?: number;
  sleepMinutes?: number;
  weightKg?: number;
};

export type SetupResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'update-required' | 'denied' };

/** 앱을 켤 때 한 번 부른다. */
export async function setUpHealthConnect(): Promise<SetupResult> {
  const status = await getSdkStatus();
  if (status === SdkAvailabilityStatus.SDK_UNAVAILABLE) {
    return { ok: false, reason: 'unavailable' };
  }
  if (status === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
    return { ok: false, reason: 'update-required' };
  }

  await initialize();

  const granted = await requestPermission(PERMISSIONS);
  // 사용자가 일부만 허용할 수 있다. 하나도 못 받으면 진행할 수 없다.
  if (granted.length === 0) return { ok: false, reason: 'denied' };

  return { ok: true };
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * [from, to) 구간의 지표를 날짜별로 접는다.
 *
 * 분 단위 원시 시계열은 서버로 보내지 않는다.
 * 민감정보(건강정보)라 최소한만 수집한다는 원칙 때문이다.
 */
export async function readDailyMetrics(from: Date, to: Date): Promise<DailyMetric[]> {
  const timeRangeFilter = {
    operator: 'between' as const,
    startTime: from.toISOString(),
    endTime: to.toISOString(),
  };

  const byDate = new Map<string, DailyMetric>();
  const slot = (iso: string): DailyMetric => {
    const key = dayKey(iso);
    const found = byDate.get(key);
    if (found) return found;
    const created: DailyMetric = { date: key };
    byDate.set(key, created);
    return created;
  };

  const resting = await readRecords('RestingHeartRate', { timeRangeFilter });
  for (const r of resting.records) {
    slot(r.time).restingHr = r.beatsPerMinute;
  }

  const hrv = await readRecords('HeartRateVariabilityRmssd', { timeRangeFilter });
  for (const r of hrv.records) {
    slot(r.time).hrvRmssd = r.heartRateVariabilityMillis;
  }

  const sleep = await readRecords('SleepSession', { timeRangeFilter });
  for (const r of sleep.records) {
    const minutes =
      (new Date(r.endTime).getTime() - new Date(r.startTime).getTime()) / 60000;
    const day = slot(r.startTime);
    day.sleepMinutes = (day.sleepMinutes ?? 0) + Math.round(minutes);
  }

  const weight = await readRecords('Weight', { timeRangeFilter });
  for (const r of weight.records) {
    slot(r.time).weightKg = r.weight.inKilograms;
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
