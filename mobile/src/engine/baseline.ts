/**
 * 개인 기준선 대비 변화를 계산한다.
 *
 * 추론하지 않는다. "유의하다", "좋아졌다" 같은 판단을 내리지 않고,
 * 투약 전 14일의 내 값과 비교해 "평소 흔들림의 몇 배"인지만 낸다.
 *
 * 평균과 표준편차 대신 중앙값과 MAD 를 쓴다.
 * 착용을 하루 빼먹거나 운동을 심하게 한 하루가 결과를 흔들면 안 되기 때문이다.
 */

export const RULESET_VERSION = 'v1';

/** 규칙을 바꾸면 이 값도 바뀐다. 결과를 보고 규칙을 고치는 것을 막기 위한 기록이다. */
export const RULES = {
  baselineDays: 14,
  windows: [7, 14, 28] as const,
  /** 기준선에 최소 이만큼의 유효일이 있어야 계산한다. */
  minBaselineDays: 10,
  /** 비교 창은 창 길이의 이 비율만큼 유효일이 있어야 한다. */
  minWindowRatio: 0.7,
  /** 변동이 거의 없던 사용자에게서 비율이 발산하지 않도록 두는 하한 */
  spreadFloor: {
    restingHr: 1.0,
    hrvRmssd: 2.0,
    sleepMinutes: 10,
    weightKg: 0.2,
  },
} as const;

export type MetricKey = keyof typeof RULES.spreadFloor;

export type Finding =
  | {
      metric: MetricKey;
      known: true;
      baseline: number;
      after: number;
      delta: number;
      /** delta 를 개인의 평소 변동폭으로 나눈 값 */
      ratio: number;
      band: 'usual' | 'larger' | 'much-larger';
      baselineDays: number;
      windowDays: number;
    }
  | {
      metric: MetricKey;
      known: false;
      /** 왜 계산하지 않았는지 */
      reason: 'not-enough-baseline' | 'not-enough-window';
      baselineDays: number;
      windowDays: number;
    };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * MAD 에 1.4826 을 곱하면 정규분포에서 표준편차와 같은 눈금이 된다.
 * 이상치 하나에 끌려가지 않으면서 "평소 흔들림"을 재는 자가 된다.
 */
function scaledMad(values: number[]): number {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

function band(ratio: number): 'usual' | 'larger' | 'much-larger' {
  const abs = Math.abs(ratio);
  if (abs < 1) return 'usual';
  if (abs < 2) return 'larger';
  return 'much-larger';
}

/**
 * @param baselineValues 투약 직전 14일 중 유효한 값들
 * @param afterValues    투약 이후 창 안의 유효한 값들
 */
export function compare(
  metric: MetricKey,
  baselineValues: number[],
  afterValues: number[],
  windowDays: number,
): Finding {
  const baselineDays = baselineValues.length;
  const observedDays = afterValues.length;

  if (baselineDays < RULES.minBaselineDays) {
    return { metric, known: false, reason: 'not-enough-baseline', baselineDays, windowDays };
  }
  if (observedDays < windowDays * RULES.minWindowRatio) {
    return { metric, known: false, reason: 'not-enough-window', baselineDays, windowDays };
  }

  const baseline = median(baselineValues);
  const after = median(afterValues);
  const spread = Math.max(scaledMad(baselineValues), RULES.spreadFloor[metric]);
  const delta = after - baseline;
  const ratio = delta / spread;

  return {
    metric,
    known: true,
    baseline,
    after,
    delta,
    ratio,
    band: band(ratio),
    baselineDays,
    windowDays,
  };
}
