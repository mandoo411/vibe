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
