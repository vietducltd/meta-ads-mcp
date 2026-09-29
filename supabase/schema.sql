-- Bảng lưu dữ liệu Meta Ads. Chạy 1 lần trong Supabase > SQL Editor.
-- Tiền (spend, budget, purchase_value...) lưu theo đơn vị thường của tiền tệ tài khoản (VND = đồng, USD = đô).

create table if not exists public.meta_ad_accounts (
  id             text primary key,          -- act_...
  name           text,
  currency       text,
  timezone_name  text,
  account_status text,
  amount_spent   numeric,
  balance        numeric,
  synced_at      timestamptz not null default now()
);

create table if not exists public.meta_campaigns (
  id               text primary key,
  account_id       text not null,
  name             text,
  objective        text,
  status           text,
  effective_status text,
  daily_budget     numeric,
  lifetime_budget  numeric,
  bid_strategy     text,
  created_time     timestamptz,
  start_time       timestamptz,
  stop_time        timestamptz,
  synced_at        timestamptz not null default now()
);

create table if not exists public.meta_adsets (
  id                text primary key,
  account_id        text not null,
  campaign_id       text,
  name              text,
  status            text,
  effective_status  text,
  daily_budget      numeric,
  lifetime_budget   numeric,
  optimization_goal text,
  billing_event     text,
  destination_type  text,
  bid_strategy      text,
  targeting         jsonb,
  start_time        timestamptz,
  end_time          timestamptz,
  synced_at         timestamptz not null default now()
);

create table if not exists public.meta_ads (
  id               text primary key,
  account_id       text not null,
  campaign_id      text,
  adset_id         text,
  name             text,
  status           text,
  effective_status text,
  creative_id      text,
  created_time     timestamptz,
  synced_at        timestamptz not null default now()
);

-- Số liệu theo ngày, cấp quảng cáo (cộng dồn lên adset / campaign / account khi báo cáo)
create table if not exists public.meta_insights_daily (
  ad_id              text not null,
  date               date not null,
  account_id         text not null,
  currency           text,
  campaign_id        text,
  campaign_name      text,
  adset_id           text,
  adset_name         text,
  ad_name            text,
  spend              numeric not null default 0,
  impressions        bigint  not null default 0,
  reach              bigint  not null default 0,
  frequency          numeric,
  clicks             bigint  not null default 0,
  link_clicks        bigint  not null default 0,
  landing_page_views bigint  not null default 0,
  messages           bigint  not null default 0,
  leads              bigint  not null default 0,
  add_to_cart        bigint  not null default 0,
  initiate_checkout  bigint  not null default 0,
  purchases          bigint  not null default 0,
  purchase_value     numeric not null default 0,
  actions            jsonb,
  action_values      jsonb,
  synced_at          timestamptz not null default now(),
  primary key (ad_id, date)
);
create index if not exists meta_insights_daily_account_date on public.meta_insights_daily (account_id, date);
create index if not exists meta_insights_daily_campaign_date on public.meta_insights_daily (campaign_id, date);

create table if not exists public.meta_sync_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  trigger     text,
  account_id  text,
  ok          boolean,
  detail      jsonb
);

-- Bật RLS, không tạo policy: chỉ service_role (Worker) đọc/ghi được, anon key không xem được dữ liệu.
alter table public.meta_ad_accounts    enable row level security;
alter table public.meta_campaigns      enable row level security;
alter table public.meta_adsets         enable row level security;
alter table public.meta_ads            enable row level security;
alter table public.meta_insights_daily enable row level security;
alter table public.meta_sync_runs      enable row level security;

-- Báo cáo tổng hợp. p_level: account | campaign | adset | ad | day
create or replace function public.meta_report(
  p_since date, p_until date, p_level text default 'campaign', p_account text default null
)
returns table (
  account_id text, currency text, level_id text, level_name text,
  spend numeric, impressions bigint, clicks bigint, link_clicks bigint,
  ctr numeric, cpc numeric, cpm numeric,
  landing_page_views bigint, messages bigint, leads bigint, add_to_cart bigint,
  initiate_checkout bigint, purchases bigint, purchase_value numeric,
  roas numeric, cost_per_message numeric, cost_per_lead numeric, cost_per_purchase numeric
)
language sql stable
set search_path = public
as $$
  with base as (
    select i.*,
      case p_level
        when 'account' then i.account_id
        when 'adset'   then i.adset_id
        when 'ad'      then i.ad_id
        when 'day'     then i.date::text
        else i.campaign_id
      end as k,
      case p_level
        when 'account' then i.account_id
        when 'adset'   then i.adset_name
        when 'ad'      then i.ad_name
        when 'day'     then i.date::text
        else i.campaign_name
      end as n
    from meta_insights_daily i
    where i.date between p_since and p_until
      and (p_account is null or i.account_id = p_account)
  )
  select
    b.account_id, max(b.currency), b.k, max(b.n),
    round(sum(b.spend), 2), sum(b.impressions)::bigint, sum(b.clicks)::bigint, sum(b.link_clicks)::bigint,
    round(100.0 * sum(b.link_clicks) / nullif(sum(b.impressions), 0), 2),
    round(sum(b.spend) / nullif(sum(b.link_clicks), 0), 2),
    round(1000.0 * sum(b.spend) / nullif(sum(b.impressions), 0), 2),
    sum(b.landing_page_views)::bigint, sum(b.messages)::bigint, sum(b.leads)::bigint, sum(b.add_to_cart)::bigint,
    sum(b.initiate_checkout)::bigint, sum(b.purchases)::bigint, round(sum(b.purchase_value), 2),
    round(sum(b.purchase_value) / nullif(sum(b.spend), 0), 2),
    round(sum(b.spend) / nullif(sum(b.messages), 0), 2),
    round(sum(b.spend) / nullif(sum(b.leads), 0), 2),
    round(sum(b.spend) / nullif(sum(b.purchases), 0), 2)
  from base b
  group by b.account_id, b.k
  order by case when p_level = 'day' then b.k end, sum(b.spend) desc;
$$;

revoke execute on function public.meta_report(date, date, text, text) from public, anon, authenticated;
grant execute on function public.meta_report(date, date, text, text) to service_role;
