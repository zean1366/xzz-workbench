-- 喜姿姿工作台数据库结构
-- 在 Supabase SQL Editor 中执行

-- 启用 UUID 扩展
create extension if not exists "uuid-ossp";

-- ============ 1. 每日待办 ============
create table if not exists todos (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  priority text default 'medium', -- high, medium, low
  status text default 'pending', -- pending, done
  category text default 'general', -- work, life, study, store, content
  note text,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 2. 内容生产 ============
create table if not exists content_production (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  status text default 'idea', -- idea, writing, filming, publishing, published
  platform text, -- xiaohongshu, douyin, wechat, all
  priority text default 'medium', -- high, medium, low
  category text, -- 祛湿, 鼻炎, 脾胃, etc.
  publish_date date,
  script text,
  filming_list text,
  publish_copy text,
  notes text,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 3. 学习周主题 ============
create table if not exists learning_weeks (
  id uuid primary key default uuid_generate_v4(),
  week_title text not null,
  week_start date,
  week_end date,
  status text default 'in_progress', -- planned, in_progress, completed
  progress integer default 0, -- 0-100
  focus text, -- 本周重点
  resources text, -- 学习资源
  summary text, -- 周总结
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 4. 碎片日记 ============
create table if not exists diary_notes (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  content text,
  category text default 'idea', -- idea, quote, daily, thought
  mood text,
  tags text,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 5. 生活收支 ============
create table if not exists living_expenses (
  id uuid primary key default uuid_generate_v4(),
  type text not null, -- expense, income
  category text not null, -- food, transport, shopping, home, entertainment, medical, learning, salary, other
  amount numeric(10,2) not null default 0,
  description text,
  expense_date date default current_date,
  payment_method text, -- wechat, alipay, cash, card
  notes text,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 6. 门店运营导航 ============
create table if not exists store_navigation (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  icon text default '📋',
  feishu_link text,
  description text,
  category text default 'member', -- member, finance, other
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 7. 门店随手记 ============
create table if not exists store_quick_notes (
  id uuid primary key default uuid_generate_v4(),
  type text default 'other', -- member_consume, member_recharge, walkin_consume, expense, gift, other
  amount numeric(10,2) default 0,
  customer_name text,
  details text,
  note_date date default current_date,
  synced boolean default false, -- 是否已同步到飞书
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============ 启用行级安全（RLS）============
alter table todos enable row level security;
alter table content_production enable row level security;
alter table learning_weeks enable row level security;
alter table diary_notes enable row level security;
alter table living_expenses enable row level security;
alter table store_navigation enable row level security;
alter table store_quick_notes enable row level security;

-- ============ 创建策略（允许所有操作，先简化，后续再加用户认证）============
create policy "Allow all on todos" on todos for all using (true) with check (true);
create policy "Allow all on content_production" on content_production for all using (true) with check (true);
create policy "Allow all on learning_weeks" on learning_weeks for all using (true) with check (true);
create policy "Allow all on diary_notes" on diary_notes for all using (true) with check (true);
create policy "Allow all on living_expenses" on living_expenses for all using (true) with check (true);
create policy "Allow all on store_navigation" on store_navigation for all using (true) with check (true);
create policy "Allow all on store_quick_notes" on store_quick_notes for all using (true) with check (true);

-- ============ 插入初始数据 ============
-- 门店运营导航初始数据
insert into store_navigation (title, icon, category, description, sort_order) values
('会员信息登记', '👤', 'member', '登记新会员基本信息', 1),
('会员调理档案', '📋', 'member', '会员调理记录和档案', 2),
('会员储值记录', '💰', 'member', '会员储值充值记录', 3),
('会员消费记录', '🛒', 'member', '会员消费明细', 4),
('散客消费记录', '🧾', 'finance', '散客到店消费记录', 5),
('门店成本支出', '💸', 'finance', '门店日常运营成本', 6),
('赠送礼品明细', '🎁', 'finance', '活动赠送礼品记录', 7),
('生活收支账本', '💰', 'finance', '个人生活收入支出记录', 8);
