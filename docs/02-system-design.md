# System Design

GLP-1 투약 전후의 몸 변화를 워치 데이터로 보여 주는 앱. 이 문서는 무엇을 어떤 순서로, 어떤 제약 아래 만들지를 정한다. 피치는 [01-pitch.md](01-pitch.md).

---

## 1. 범위를 규제가 먼저 정한다

기능을 정하기 전에 법이 정하는 선을 긋는다. 이 선이 아키텍처를 바꾸기 때문이다.

| 영역 | 근거 | 한다 | 하지 않는다 |
| --- | --- | --- | --- |
| 의료기기 해당 여부 | 식약처 「의료기기와 개인용 건강관리(웰니스) 제품 판단기준」 | 일상적 건강관리 목적의 기록·시각화·개인 변화 표시 | 질병의 진단·치료·예방 목적 표현, 약 선택 지시 |
| 전문의약품 | 약사법 제68조 (전문의약품 대중광고 금지) | 사용자가 입력한 자기 투약 기록의 표시 | 약 이름을 내세운 광고, 약 간 우열·추천, 구매 유도 |
| 민감정보 | 개인정보보호법 제23조 (건강정보는 민감정보) | 다른 동의와 **분리된 별도 동의**, 목적·보존기간·파기 고지, 안전성 확보 조치 | 동의 없는 수집, 광고 식별자와 결합, 원시 건강데이터 외부 제공 |

**설계에 미치는 결과 세 가지.**

1. 앱은 "이 약이 맞다", "용량을 바꿔라"를 절대 출력하지 않는다. 그래서 LLM이 판단을 하지 못하도록 **숫자 생성 경로와 문장 생성 경로를 물리적으로 분리**한다(§6, §7).
2. 약 이름은 사용자가 입력한 값을 그대로 되비출 뿐, 앱이 제시하거나 비교하지 않는다. 약 목록은 검색용 사전이지 추천 목록이 아니다.
3. 별도 동의가 필요하므로 온보딩에서 동의 화면이 독립 단계로 들어간다. 동의 이전에는 HealthKit / Health Connect 권한 요청 자체를 하지 않는다.

---

## 2. 아키텍처

```
┌─────────────────────────────┐
│  앱 (Expo / React Native)    │
│                             │
│  HealthKit    Health Connect│  ← 기기에서 읽기
│      ↓              ↓       │
│   일 단위 집계 (온디바이스)   │  ← 원시 시계열은 올리지 않는다
│      ↓                      │
│   투약·증상 입력             │
└──────────┬──────────────────┘
           │ HTTPS (JWT)
┌──────────▼──────────────────┐
│  Supabase                   │
│  Postgres (RLS)  Auth       │
│  Edge Functions (Deno/TS)   │
│    ├ /metrics  수집          │
│    ├ /report   리포트 생성    │
│    └ /share    이미지 렌더    │
│         ↓                   │
│   통계 엔진 (순수 TS 모듈)    │  ← 숫자는 여기서만 나온다
│         ↓                   │
│   LLM (Claude Fable 5.1)    │  ← 문장만. 숫자 입력 불가
└─────────────────────────────┘
```

**원칙 하나.** 통계 엔진이 계산한 값은 구조화된 객체로 고정되고, LLM에는 그 객체를 문장으로 옮기는 일만 맡긴다. LLM 출력에 새 숫자가 등장하면 후처리에서 버린다(§7).

---

## 3. 클라이언트

### 3.1 스택

| 선택 | 이유 | 버린 대안 |
| --- | --- | --- |
| Expo (React Native) + TypeScript | HealthKit과 Health Connect를 한 코드베이스로. EAS Build로 두 스토어 CI/CD가 한 번에 붙는다 | 네이티브 2벌: 6주에 두 앱을 심사까지 넣을 수 없다 |
| `@kingstinct/react-native-healthkit` (iOS) | 백그라운드 전달과 anchored query를 지원하고 TypeScript 타입이 있다 | `react-native-health`: 유지보수 느림 |
| `react-native-health-connect` v4 (Android) | v4부터 Expo config plugin이 패키지 안에 포함되어 별도 플러그인이 필요 없다 | 삼성헬스 SDK: 파트너 승인 대기가 6주를 넘긴다 |

### 3.2 iOS — HealthKit

읽는 타입은 넷으로 고정한다.

| 지표 | HealthKit 타입 |
| --- | --- |
| 안정시 심박 | `HKQuantityTypeIdentifierRestingHeartRate` |
| HRV | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` |
| 수면 | `HKCategoryTypeIdentifierSleepAnalysis` |
| 체중 | `HKQuantityTypeIdentifierBodyMass` |

- 증분 동기화는 `HKAnchoredObjectQuery`의 anchor를 로컬에 저장해서 한다. 매번 전체를 다시 읽지 않는다.
- 백그라운드 수집은 `HKObserverQuery` + `enableBackgroundDelivery`. **필요한 것은 `com.apple.developer.healthkit.background-delivery` 엔타이틀먼트이고, `UIBackgroundModes`에 `healthkit`을 넣으면 App Store 업로드가 90112로 거부된다.** config plugin이 이걸 잘못 넣는 사례가 알려져 있어 빌드 후 `Info.plist`를 검증하는 CI 단계를 둔다.
- 백그라운드 깨어남 1회당 약 30초가 주어진다. 그 안에 끝나도록 집계는 증분만 처리한다.
- 쓰기 권한은 요청하지 않는다. 읽기 전용이면 심사에서 설명할 것이 줄어든다.

### 3.3 Android — Health Connect

| 지표 | Health Connect 레코드 |
| --- | --- |
| 안정시 심박 | `RestingHeartRateRecord` |
| HRV | `HeartRateVariabilityRmssdRecord` |
| 수면 | `SleepSessionRecord` |
| 체중 | `WeightRecord` |

- **HRV 단위가 다르다.** iOS는 SDNN, Android는 RMSSD다. 서로 변환되지 않으므로 DB에 `hrv_metric` 컬럼으로 어느 쪽인지 남기고, 기준선 비교는 **같은 지표끼리만** 한다. 기기를 바꾼 사용자는 그 지점에서 시계열을 끊는다.
- 기본값으로 Health Connect 읽기는 앱이 포그라운드일 때만 된다. 백그라운드 수집에는 `READ_HEALTH_DATA_IN_BACKGROUND` 권한이 별도로 필요하고, 사용자 기기의 Health Connect 버전이 이를 지원해야 한다.
- 30일보다 오래된 데이터를 읽으려면 `READ_HEALTH_DATA_HISTORY`가 추가로 필요하다. 온보딩에서 과거 투약 이력을 받을 때 기준선을 만들려면 이 권한이 있어야 한다.
- 두 권한 모두 Play Console의 건강 권한 선언과 심사 대상이다. **심사에 시간이 걸리므로 1주차에 신청한다**(§11).

### 3.4 온디바이스 집계

기기에서 하루 단위로 접어서 올린다. 분 단위 심박 시계열은 서버로 보내지 않는다. 민감정보 최소 수집 원칙에 맞고, 통신량과 저장 비용도 줄어든다.

```ts
type DailyMetric = {
  date: string;          // YYYY-MM-DD, 기기 로컬 타임존 기준
  restingHr?: number;    // bpm
  hrv?: number;          // ms
  hrvMetric?: 'SDNN' | 'RMSSD';
  sleepMinutes?: number;
  sleepEfficiency?: number;
  weightKg?: number;
  wearMinutes: number;   // 착용 시간. 결측 판정에 쓴다
  source: 'healthkit' | 'health_connect';
};
```

---

## 4. 데이터 모델

Postgres. 모든 테이블에 RLS를 걸고 `user_id = auth.uid()`만 통과시킨다.

```sql
-- 사용자 프로필. 건강정보 동의 상태를 여기서 관리한다.
create table profiles (
  id                uuid primary key references auth.users on delete cascade,
  display_name      text,
  sensitive_consent_at   timestamptz,          -- 민감정보 별도 동의 시각
  sensitive_consent_ver  text,                 -- 동의서 버전
  retention_until   date,                      -- 보존기간 만료일
  created_at        timestamptz not null default now()
);

-- 투약 사건. 이 테이블이 없으면 제품이 성립하지 않는다.
create table medication_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users on delete cascade,
  drug_code   text not null,                   -- 내부 사전 코드. 표시명은 클라이언트가 매핑
  dose_mg     numeric(6,3) not null check (dose_mg > 0),
  taken_on    date not null,
  kind        text not null check (kind in ('START','DOSE_UP','DOSE_DOWN','MAINTAIN','STOP')),
  note        text,
  created_at  timestamptz not null default now(),
  unique (user_id, taken_on, drug_code)
);

-- 일 단위 지표. 기기에서 접어서 올라온 것.
create table daily_metrics (
  user_id          uuid not null references auth.users on delete cascade,
  date             date not null,
  resting_hr       numeric(5,2),
  hrv              numeric(6,2),
  hrv_metric       text check (hrv_metric in ('SDNN','RMSSD')),
  sleep_minutes    int,
  sleep_efficiency numeric(4,3),
  weight_kg        numeric(5,2),
  wear_minutes     int not null default 0,
  source           text not null,
  updated_at       timestamptz not null default now(),
  primary key (user_id, date)
);

-- 증상 메모. 자유 입력과 LLM이 뽑은 구조를 함께 둔다.
create table symptom_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users on delete cascade,
  logged_on   date not null,
  raw_text    text not null,
  tags        text[],                          -- LLM 파싱 결과. 원문은 항상 보존
  parsed_by   text,                            -- 모델 버전
  created_at  timestamptz not null default now()
);

-- 생성된 리포트. 재현을 위해 입력 스냅샷과 규칙 버전을 박아 둔다.
create table reports (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users on delete cascade,
  event_id       bigint not null references medication_events on delete cascade,
  window_days    int not null check (window_days in (7,14,28)),
  engine_version text not null,                -- 통계 규칙 버전
  ruleset_hash   text not null,                -- 사전등록 해시
  findings       jsonb not null,               -- 엔진 산출물. 숫자는 여기에만 있다
  narrative      text,                         -- LLM 문장
  llm_model      text,
  created_at     timestamptz not null default now(),
  unique (user_id, event_id, window_days, engine_version)
);
```

`reports.findings`가 이 설계의 핵심이다. 숫자는 여기에만 존재하고, `narrative`는 이것을 읽어 만든 파생물이다. 나중에 문장 생성을 바꿔도 숫자는 재현된다.

---

## 5. API

Supabase Edge Function. 전부 JWT 필수.

| 메서드·경로 | 하는 일 |
| --- | --- |
| `POST /v1/metrics/batch` | 일 단위 지표 upsert. `(user_id, date)` 충돌 시 `wear_minutes`가 큰 쪽을 남긴다 |
| `POST /v1/medications` | 투약 사건 등록. 같은 날 같은 약 중복은 409 |
| `GET /v1/medications` | 투약 이력 |
| `POST /v1/symptoms` | 증상 메모. 원문 저장 후 파싱은 비동기 |
| `POST /v1/reports` | 리포트 생성. 이미 있으면 캐시 반환 |
| `GET /v1/reports/:id` | 리포트 조회 |
| `POST /v1/reports/:id/share` | 상담용 이미지 렌더. 서명 URL 15분 만료 |
| `DELETE /v1/me` | 계정과 데이터 하드 삭제 |

---

## 6. 통계 엔진

이 제품에서 가장 조심해야 하는 부분이다. **추론을 하지 않는다.** 개인 기준선 대비 변화를 개인의 평소 변동폭으로 나눠 보여 주는 것까지가 전부다.

### 6.1 정의

- **개입 이벤트** = `kind in ('START','DOSE_UP','DOSE_DOWN')`인 투약 기록. 유지 투약은 이벤트가 아니다.
- **기준선 창** = 이벤트 직전 14일.
- **비교 창** = 이벤트 이후 7일, 14일, 28일.
- **유효일** = `wear_minutes >= 240` 이고 해당 지표가 결측이 아닌 날.

### 6.2 산식

평균과 표준편차 대신 중앙값과 MAD를 쓴다. 착용 하루를 빼먹거나 운동을 심하게 한 하루가 결과를 흔들지 않게 하기 위해서다.

```
baseline  = median(기준선 창의 유효일 값)
spread    = 1.4826 × MAD(기준선 창의 유효일 값)
after     = median(비교 창의 유효일 값)

delta     = after − baseline
ratio     = delta / spread          ← "평소 흔들림의 몇 배"
```

`1.4826`은 정규분포에서 MAD를 표준편차와 같은 눈금으로 맞추는 상수다. `spread`가 0에 가까우면(변동이 거의 없던 사용자) 비율이 발산하므로 `spread`에 지표별 하한을 둔다(안정시 심박 1.0 bpm, HRV 2.0 ms, 수면 10분, 체중 0.2 kg).

### 6.3 표시 규칙

| `|ratio|` | 화면 문구 |
| --- | --- |
| < 1.0 | "평소 범위 안" |
| 1.0 ~ 2.0 | "평소보다 큰 변화" |
| ≥ 2.0 | "평소 흔들림의 N배" (강조) |

숫자와 이 문구 외에는 아무 말도 붙이지 않는다. 좋다, 나쁘다, 위험하다를 쓰지 않는다.

### 6.4 데이터가 모자랄 때

| 조건 | 결과 |
| --- | --- |
| 기준선 유효일 < 10일 | 해당 지표 **"아직 모름"**. 계산하지 않는다 |
| 비교 창 유효일 < 창 길이의 70% | 같음 |
| 기준선 창에 다른 개입 이벤트가 겹침 | 해당 이벤트 리포트 생략. 겹친 사실을 화면에 표시 |
| 기기 변경으로 `hrv_metric`이 바뀜 | HRV만 "아직 모름". 나머지 지표는 계속 |

"아직 모름"을 성실하게 내는 것이 이 제품의 신뢰다. 데이터가 없는데 숫자를 만들어 내면 첫 사용자에게 틀린 값을 보여 주게 된다.

### 6.5 재현성

분석 규칙(창 길이, 유효일 기준, 하한, 구간 문구)을 하나의 JSON으로 두고 SHA-256 해시를 `reports.ruleset_hash`에 박는다. 규칙을 바꾸면 해시가 바뀌고 새 버전의 리포트가 따로 생성된다. **결과를 보고 규칙을 고쳐 말을 바꾸는 일**을 구조적으로 막는다.

테스트는 골든 파일로 한다. 합성 사용자 12명분의 일 단위 데이터와 기대 출력을 고정해 두고, 엔진을 고칠 때마다 diff를 본다.

---

## 7. LLM

모델은 `claude-fable-5-1`, reasoning effort는 `xhigh`. 키는 기기에 두지 않고 Edge Function에서만 쓴다.

### 7.1 역할 두 가지뿐

| 역할 | 입력 | 출력 |
| --- | --- | --- |
| 리포트 문장화 | `findings` 객체 (숫자 포함) | 2~3문장. 새 숫자 금지 |
| 증상 파싱 | 자유 입력 원문 | 태그 배열 (`nausea`, `insomnia`, …) |

허가사항 Q&A는 6주 범위에서 뺀다. 약 정보를 다루는 순간 약사법 검토가 하나 더 붙는다.

### 7.2 판정을 막는 장치 넷

1. **숫자 생성 경로 차단.** 프롬프트에 들어가는 것은 엔진이 만든 `findings`뿐이고, 출력은 구조화된 스키마(`output_config.format`)로 받는다.
2. **후처리 검증.** 출력 문장에서 숫자를 전부 뽑아 `findings`에 있는 값과 대조한다. 없는 숫자가 하나라도 있으면 그 응답을 버리고 템플릿 문장으로 대체한다.
3. **금칙 표현 필터.** "바꾸세요", "권합니다", "효과가 있습니다", "맞습니다", "좋아졌습니다" 등을 정규식으로 막는다. 걸리면 마찬가지로 템플릿으로 떨어진다.
4. **폴백이 항상 존재한다.** LLM이 죽어도 제품은 동작한다. 템플릿 문장이 기본이고 LLM은 그것을 다듬는 층이다.

### 7.3 품질 점검

주간으로 합성 케이스 30건을 돌려 세 모델(Fable 5.1 / Opus 5 / Sonnet 5)의 출력 일치도를 본다. 일치도가 떨어지는 케이스는 템플릿으로 고정한다. 이건 출시 전 오프라인 작업이고 런타임 비용이 아니다.

---

## 8. 개인정보와 보안

| 항목 | 설계 |
| --- | --- |
| 별도 동의 | 온보딩 2단계. 서비스 이용약관과 **분리된 화면**에서 건강정보 수집 동의를 받는다. 목적, 항목, 보존기간, 파기 방법, 동의 거부 시 불이익을 한 화면에 적는다 |
| 동의 철회 | 설정에서 언제든. 철회 시 수집 중단 + 기존 데이터 삭제 선택지 제공 |
| 최소 수집 | 일 단위 집계만 서버로. 분 단위 원시 시계열은 기기에 남는다 |
| 접근 통제 | Postgres RLS로 행 단위. 서비스 키는 Edge Function 런타임에만 |
| 저장 | Supabase 저장 시 암호화. 체중·투약 같은 열은 애플리케이션 레벨 암호화를 P2에서 검토 |
| 공유 링크 | 서명 URL 15분 만료, 이미지 한 장. 원본 데이터 링크는 만들지 않는다 |
| 삭제 | 계정 삭제 시 `on delete cascade`로 즉시 하드 삭제. 백업 롤오프 30일 |
| 로그 | 건강 수치를 애플리케이션 로그에 남기지 않는다. 사용자 ID는 해시로 |
| 광고 | SDK를 붙이지 않는다. 광고 식별자와 건강정보 결합은 금지 |

---

## 9. 관측과 품질

- **수집률**이 첫 번째 지표다. 사용자별 일 데이터 수집률이 80% 밑이면 엔진이 "아직 모름"만 내게 되고 제품이 죽는다. 대시보드 1번 항목으로 둔다.
- 크래시는 Sentry. 이벤트 페이로드에서 건강 수치를 스크러빙한다.
- 재방문 정의를 코드에 고정한다. **주간 리포트를 연 사용자 / 그 주 활성 사용자**. 정의를 나중에 바꾸면 숫자가 의미를 잃는다.
- 엔진 골든 테스트와 스키마 마이그레이션 테스트는 CI 필수 통과 조건.

---

## 10. 배포

| 단계 | 도구 |
| --- | --- |
| PR | GitHub Actions: 타입 체크, 린트, 엔진 골든 테스트, `Info.plist` 검증 |
| 프리뷰 | EAS Build (development profile), 내부 배포 |
| 베타 | TestFlight (iOS), Play Internal Testing (Android) |
| 마이그레이션 | Supabase CLI. 롤백 스크립트를 같은 PR에 넣는다 |

스토어 심사가 일정의 가장 큰 불확실성이다. HealthKit 사용 앱은 목적 설명을 까다롭게 본다. Play는 건강 권한 선언 심사가 따로 있다. 그래서 **빈 껍데기 앱을 1주차에 양쪽 스토어에 한 번 올려 심사 경로를 뚫어 둔다.**

---

## 11. 6주 실행 계획

세미나 일정에 맞춘다.

| 주차 | 만드는 것 | 통과 기준 |
| --- | --- | --- |
| 1 (~10/5) | Expo 프로젝트, Supabase 스키마, **Play 건강 권한 선언 신청**, 빈 앱 스토어 업로드 | 두 스토어에 빌드가 올라간다 |
| 2 (~10/12) | HealthKit·Health Connect 읽기, 온디바이스 집계, `/metrics/batch` | 내 워치 데이터가 DB에 하루치 들어온다 |
| 3 (~10/19) | 투약 입력 화면, 동의 화면, 통계 엔진 v0 + 골든 테스트 | 합성 데이터로 리포트 JSON이 나온다 |
| 4 (~10/26) | 리포트 화면, LLM 문장화 + 가드 4종 | 실제 내 데이터로 리포트가 보인다 |
| 5 (~11/9) | 상담용 한 장, 공유, 백그라운드 동기화 | 이미지가 나오고 앱을 안 열어도 데이터가 쌓인다 |
| 6 (~11/16) | 베타 배포, 관측, 버그 | TestFlight·Play 내부 테스트로 5명이 쓴다 |

마감: 시스템 설계 10/30, E2E 11/6, MVP 11/13, 베타 배포 11/20, 발표 11/21.

---

## 12. 위험

| 위험 | 크기 | 대응 |
| --- | --- | --- |
| 스토어 심사 지연 | 높음 | 1주차에 빈 앱으로 경로를 뚫는다. Play 건강 권한은 신청이 먼저 |
| 내 데이터가 6주 안에 안 쌓인다 | 높음 | 합성 데이터 생성기를 3주차에 먼저 만든다. 엔진 개발이 실데이터를 기다리지 않게 |
| HRV 단위 불일치 | 중간 | 기기별로 시계열을 끊는다. 교차 비교를 아예 막는다 |
| 백그라운드 동기화가 OS별로 다르게 동작 | 중간 | 포그라운드 동기화를 먼저 완성하고 백그라운드는 5주차 |
| 규제 해석이 바뀐다 | 중간 | 판정 기능이 처음부터 없으므로 범위가 줄어도 제품은 그대로 |
| 투약 입력을 안 한다 | 높음 | 온보딩에서 과거 이력을 한 번에 받고, 증량 예정일에 알림 |
