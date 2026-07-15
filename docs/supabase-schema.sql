-- ============================================================
-- TotalMoney AI — 회원가입/결제 DB 스키마 (Supabase)
-- ------------------------------------------------------------
-- 사용법: Supabase 프로젝트 생성 후 대시보드 좌측 메뉴
-- "SQL Editor" -> "New query" 에 이 파일 전체를 붙여넣고 Run.
-- ============================================================

-- 1) profiles: auth.users 1:1 확장 테이블 (표시 이름 등 부가정보)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 신규 가입 시 profiles 행 자동 생성 트리거
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2) subscriptions: 사용자별 현재 구독(요금제) 상태
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro', 'premium')),
  status text not null default 'active' check (status in ('active', 'canceled', 'expired', 'past_due')),
  started_at timestamptz not null default now(),
  current_period_end timestamptz,
  portone_billing_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- 3) orders: 결제(주문) 이력 — 포트원 결제 1건당 1행
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  payment_id text not null unique, -- 포트원 paymentId
  order_name text,
  plan text,
  amount integer not null,
  currency text not null default 'KRW',
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'canceled')),
  raw_response jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 4) RLS(Row Level Security) — 본인 데이터만 조회 가능
--    (쓰기는 서버(API, service_role 키)에서만 수행 → 클라이언트 쓰기 금지)
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.orders enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own" on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own" on public.orders
  for select using (auth.uid() = user_id);

-- 참고: subscriptions/orders 의 insert/update 는 클라이언트 정책을 만들지 않습니다.
-- 결제 검증 후 api/payment/complete.js 서버 함수가 SUPABASE_SERVICE_ROLE_KEY로
-- RLS를 우회해 기록합니다. (결제 위·변조 방지를 위해 반드시 서버에서만 기록)

-- 5) 신규 가입자 free 플랜 구독행 자동 생성
create or replace function public.handle_new_user_subscription()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_subscription on auth.users;
create trigger on_auth_user_created_subscription
  after insert on auth.users
  for each row execute procedure public.handle_new_user_subscription();

-- ------------------------------------------------------------
-- 6) analysis_usage: 무료 플랜 "AI 종목분석 월 N회 체험" 카운터
--    (레이스 컨디션 방지를 위해 서버가 RPC 함수로만 증가시킴)
-- ------------------------------------------------------------
create table if not exists public.analysis_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null, -- 'YYYY-MM' (Asia/Seoul 기준, api/analyze.js 에서 계산)
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.analysis_usage enable row level security;

drop policy if exists "usage_select_own" on public.analysis_usage;
create policy "usage_select_own" on public.analysis_usage
  for select using (auth.uid() = user_id);

-- p_limit 회를 초과하지 않았으면 카운트를 1 늘리고 true, 초과했으면 false 반환.
-- security definer 이므로 서버(service_role)에서 RPC로 호출.
create or replace function public.increment_analysis_usage(p_user_id uuid, p_month text, p_limit int)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  current_count int;
begin
  insert into public.analysis_usage (user_id, month, count)
  values (p_user_id, p_month, 0)
  on conflict (user_id, month) do nothing;

  select count into current_count from public.analysis_usage
    where user_id = p_user_id and month = p_month
    for update;

  if current_count >= p_limit then
    return false;
  end if;

  update public.analysis_usage set count = count + 1, updated_at = now()
    where user_id = p_user_id and month = p_month;
  return true;
end;
$$;

-- ------------------------------------------------------------
-- 7) public_ai_feed: 홈 화면 "실시간 AI 분석" 위젯용 공개 피드
--    (2026-07-10 추가) — 이전엔 이 위젯이 하드코딩된 더미 3개(항상 같은 시각·
--    같은 종목)를 보여주고 있었다. 이제는 api/analyze.js가 실제 사용자 요청으로
--    AI 종목분석을 생성할 때마다 그 결과 요약을 이 테이블에 한 줄 남기고,
--    홈 화면(home.js)은 이 테이블의 최신 3건을 그대로 읽어와 보여준다.
--    새 AI 호출이 추가로 발생하지 않으므로(이미 일어난 실제 분석 재사용) 비용 증가 없음.
-- ------------------------------------------------------------
create table if not exists public.public_ai_feed (
  id bigint generated always as identity primary key,
  stock_code text,
  stock_name text not null,
  direction text not null default '관망' check (direction in ('매수', '관망', '회피')),
  confidence int,
  summary text not null,
  created_at timestamptz not null default now()
);

alter table public.public_ai_feed enable row level security;

-- 홈 화면은 비로그인 방문자도 보는 공개 위젯이므로 누구나 읽기 가능.
drop policy if exists "public_ai_feed_select_all" on public.public_ai_feed;
create policy "public_ai_feed_select_all" on public.public_ai_feed
  for select using (true);

-- 쓰기는 api/analyze.js가 SUPABASE_SERVICE_ROLE_KEY로만 수행 (클라이언트 쓰기 정책 없음).

-- 오래된 행이 계속 쌓이는 걸 막기 위해, 최신 200건만 남기고 정리하는 함수.
-- (원하면 Supabase 대시보드에서 별도 스케줄로 주기적 호출해도 되고, 안 돌려도
-- 홈 화면은 어차피 최신 3건만 보여주므로 기능상 문제는 없음 — 저장공간 정리 목적.)
create or replace function public.trim_public_ai_feed()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.public_ai_feed
  where id in (
    select id from public.public_ai_feed
    order by created_at desc
    offset 200
  );
end;
$$;

-- ------------------------------------------------------------
-- 8) trade_signal_strategies / trade_signal_events — 매매 시그널(유료 기능)
--    (2026-07-15 추가) — 사용자가 자연어로 "삼성전자 20일선이 60일선 상향
--    돌파하면 매수 알려줘" 같은 조건을 입력하면 AI(api/trade-signal-parse.js)가
--    구조화 조건(jsonb)으로 변환해 저장한다. 실제 판정은 이 jsonb 조건만 보고
--    돌아가므로(자연어 재해석 없음) 스캔 비용이 안 든다.
--    condition 예시: {"logic":"AND","clauses":[{"type":"ma_cross","fast":20,"slow":60,"direction":"up"}]}
--    지원 clause type: ma_cross, price_cross_ma, rsi, volume_ratio,
--                       high52w_breakout, low52w_breakdown, price_change_pct
-- ------------------------------------------------------------
create table if not exists public.trade_signal_strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  market text not null default 'KR' check (market in ('KR')),
  stock_code text not null,
  stock_name text not null,
  raw_text text not null,
  alert_type text not null default 'buy' check (alert_type in ('buy', 'sell')),
  condition jsonb not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists trade_signal_strategies_user_idx on public.trade_signal_strategies (user_id);
create index if not exists trade_signal_strategies_active_idx on public.trade_signal_strategies (status) where status = 'active';

alter table public.trade_signal_strategies enable row level security;

drop policy if exists "trade_signal_strategies_select_own" on public.trade_signal_strategies;
create policy "trade_signal_strategies_select_own" on public.trade_signal_strategies
  for select using (auth.uid() = user_id);

-- insert/update/delete는 클라이언트 정책을 만들지 않는다. api/trade-signal-strategies.js가
-- 로그인 토큰으로 본인 확인 + Pro/Premium 등급 확인 후 SUPABASE_SERVICE_ROLE_KEY로만 기록한다
-- (subscriptions/orders와 동일한 패턴 — 위조 방지를 위해 서버에서만 씀).

create table if not exists public.trade_signal_events (
  id bigint generated always as identity primary key,
  strategy_id uuid not null references public.trade_signal_strategies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null,
  triggered_at timestamptz not null default now()
);

create index if not exists trade_signal_events_user_idx on public.trade_signal_events (user_id, triggered_at desc);

alter table public.trade_signal_events enable row level security;

drop policy if exists "trade_signal_events_select_own" on public.trade_signal_events;
create policy "trade_signal_events_select_own" on public.trade_signal_events
  for select using (auth.uid() = user_id);

-- 쓰기는 scripts/trade-signal-scan.mjs가 SUPABASE_SERVICE_ROLE_KEY로만 수행.

-- 사용자당 활성 전략 개수 제한(스캔 비용 통제용, 기본 20개) — 서버가 생성 전에
-- 이 함수로 현재 개수를 확인한다.
create or replace function public.count_active_trade_signal_strategies(p_user_id uuid)
returns integer
language sql
security definer set search_path = public
as $$
  select count(*)::int from public.trade_signal_strategies
  where user_id = p_user_id and status = 'active';
$$;
