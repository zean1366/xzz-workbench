/**
 * 喜姿姿工作台 · 腾讯云 SCF Web 函数入口
 * ------------------------------------------------------------
 * 部署方式：腾讯云 SCF → 新建函数 → 选「Web 函数」→ 上传 zip
 * 腾讯云 Web 函数约定：必须监听 0.0.0.0:9000
 * 腾讯云会自动给一个 API 网关 URL，前端直接调这个 URL
 *
 * 调用：
 *   GET  ${URL}/?action=status
 *   GET  ${URL}/?action=pull&module=todo
 *   POST ${URL}/?action=push&module=todo  (body: { records: [...] })
 *
 * 环境变量（在腾讯云 SCF 后台「函数配置 → 环境变量」配置）：
 *   FEISHU_APP_ID          飞书自建应用 App ID
 *   FEISHU_APP_SECRET      飞书自建应用 App Secret（禁止暴露到前端）
 *   FEISHU_TABLE_CONFIG    JSON 字符串，8 个模块的 baseToken + tableId
 *
 * Token 管理（应用身份模式，2026-10-14 起）：
 *   - 使用 tenant_access_token（应用身份），需在飞书开放平台开通
 *     bitable:app 和 wiki 权限，并把各多维表格添加应用为协作者
 *   - token 有效期约 2 小时，过期自动重新获取，无轮换、无作废问题
 *   - 永久免授权：不需要 user_access_token，不再有 refresh_token 断链风险
 */

const http = require('http');
const url = require('url');

// ========== 配置加载 ==========
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

// 延迟加载 + 容错：环境变量配置错误时不能让整个函数启动失败，
// 否则 9000 端口不会监听，浏览器无法访问 ?action=status 也就无法暴露错误信息
let _TABLE_CONFIG = null;
let _TABLE_CONFIG_ERROR = null;
function getTableConfig() {
  if (_TABLE_CONFIG || _TABLE_CONFIG_ERROR) return { config: _TABLE_CONFIG, error: _TABLE_CONFIG_ERROR };
  const raw = process.env.FEISHU_TABLE_CONFIG;
  if (!raw) {
    _TABLE_CONFIG_ERROR = '环境变量 FEISHU_TABLE_CONFIG 未配置';
    return { config: null, error: _TABLE_CONFIG_ERROR };
  }
  try {
    _TABLE_CONFIG = JSON.parse(raw);
    console.log('[CONFIG] TABLE_CONFIG 加载成功，模块:', Object.keys(_TABLE_CONFIG).join(', '));
    return { config: _TABLE_CONFIG, error: null };
  } catch (e) {
    _TABLE_CONFIG_ERROR = `FEISHU_TABLE_CONFIG 解析失败: ${e.message}（请检查是否单行 JSON、是否含中文标点/换行；字节长度=${raw.length}）`;
    console.error('[CONFIG]', _TABLE_CONFIG_ERROR);
    return { config: null, error: _TABLE_CONFIG_ERROR };
  }
}

// 各 pull/push 函数里通过 getTableConfig().config 拿 TABLE_CONFIG
function requireTableConfig() {
  const { config, error } = getTableConfig();
  if (error) throw new Error(error);
  return config;
}

// ========== tenant_access_token 管理（应用身份，无轮换） ==========
let _tenantToken = { token: null, expires_at: 0 };

async function getTenantAccessToken() {
  if (_tenantToken.token && _tenantToken.expires_at > Date.now() + 300000) {
    return _tenantToken.token;
  }
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error('NOT_AUTHORIZED: 腾讯云 SCF 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，请在函数环境变量中填写');
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.code} ${data.msg}`);
  }
  _tenantToken = {
    token: data.tenant_access_token,
    expires_at: Date.now() + (data.expire || 7200) * 1000,
  };
  console.log('[AUTH] tenant_access_token 已获取，有效期至:', new Date(_tenantToken.expires_at).toISOString());
  return _tenantToken.token;
}

async function feishuApi(method, path, body = null) {
  const token = await getTenantAccessToken();
  const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return data;
}

// ========== 记录 CRUD ==========
async function fetchAllRecords(baseToken, tableId) {
  const allRecords = [];
  let pageToken = null;
  const pageSize = 200;
  while (true) {
    let urlPath = `/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=${pageSize}`;
    if (pageToken) urlPath += `&page_token=${encodeURIComponent(pageToken)}`;
    const data = await feishuApi('GET', urlPath);
    if (data.code !== 0) {
      throw new Error(`拉取记录失败: ${data.msg || JSON.stringify(data)}`);
    }
    const items = data.data?.items || [];
    allRecords.push(...items);
    if (!data.data?.has_more || items.length < pageSize) break;
    pageToken = data.data.page_token;
  }
  return allRecords;
}

async function batchCreate(baseToken, tableId, records) {
  if (records.length === 0) return { record_ids: [] };
  const data = await feishuApi('POST', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_create`, {
    records: records.map(fields => ({ fields })),
  });
  if (data.code !== 0) {
    throw new Error(`批量创建失败: ${data.msg || JSON.stringify(data)}`);
  }
  return { record_ids: (data.data?.records || []).map(r => r.record_id) };
}

async function batchUpdate(baseToken, tableId, records) {
  if (records.length === 0) return { count: 0 };
  const data = await feishuApi('POST', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_update`, {
    records: records.map(r => ({ record_id: r.record_id, fields: r.fields })),
  });
  if (data.code !== 0) {
    throw new Error(`批量更新失败: ${data.msg || JSON.stringify(data)}`);
  }
  return { count: records.length };
}

async function batchDelete(baseToken, tableId, recordIds) {
  if (recordIds.length === 0) return { count: 0 };
  let count = 0;
  for (let i = 0; i < recordIds.length; i += 500) {
    const chunk = recordIds.slice(i, i + 500);
    const data = await feishuApi('POST', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_delete`, { records: chunk });
    if (data.code !== 0) {
      throw new Error(`批量删除失败: ${data.msg || JSON.stringify(data)}`);
    }
    count += chunk.length;
  }
  return { count };
}

// ========== 会员缓存与查询（客户姓名 -> record_id） ==========
const _customerCache = {}; // { customerName: { record_id, expires_at } }
const CUSTOMER_CACHE_TTL = 30 * 60 * 1000; // 30分钟缓存

async function findCustomerRecordId(baseToken, tableId, customerName) {
  // 先查缓存
  const cached = _customerCache[customerName];
  if (cached && cached.expires_at > Date.now()) {
    console.log('[CUSTOMER_CACHE] 命中缓存:', customerName);
    return cached.record_id;
  }

  // 查会员基础信息表
  const records = await fetchAllRecords(baseToken, tableId);
  const match = records.find(r => {
    const name = r.fields?.['会员姓名'];
    const nameStr = typeof name === 'string' ? name : (name?.text || name?.[0]?.text || '');
    return nameStr === customerName;
  });

  if (match) {
    _customerCache[customerName] = {
      record_id: match.record_id,
      expires_at: Date.now() + CUSTOMER_CACHE_TTL,
    };
    console.log('[CUSTOMER] 找到会员:', customerName, '->', match.record_id);
    return match.record_id;
  }

  // 没找到，自动新建会员
  console.log('[CUSTOMER] 未找到会员，自动新建:', customerName);
  const newRecord = await feishuApi('POST', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`, {
    fields: { '会员姓名': customerName },
  });
  if (newRecord.code !== 0) {
    throw new Error(`新建会员失败: ${newRecord.msg || JSON.stringify(newRecord)}`);
  }
  const newRecordId = newRecord.data?.record?.record_id;
  if (newRecordId) {
    _customerCache[customerName] = {
      record_id: newRecordId,
      expires_at: Date.now() + CUSTOMER_CACHE_TTL,
    };
  }
  return newRecordId;
}

// ========== 字段类型查询（用于判断哪些字段是关联字段） ==========
const _fieldTypeCache = {}; // { "baseToken:tableId": { 字段名: type } }
const LINK_FIELD_TYPES = [18, 21]; // 18=单向关联, 21=双向关联

async function getFieldTypes(baseToken, tableId) {
  const cacheKey = `${baseToken}:${tableId}`;
  if (_fieldTypeCache[cacheKey]) return _fieldTypeCache[cacheKey];
  const data = await feishuApi('GET', `/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?page_size=200`);
  if (data.code !== 0) throw new Error(`获取字段列表失败: ${data.msg || JSON.stringify(data)}`);
  const map = {};
  for (const f of (data.data?.items || [])) map[f.field_name] = f.type;
  _fieldTypeCache[cacheKey] = map;
  console.log('[FIELDS]', cacheKey, JSON.stringify(map));
  return map;
}

// ========== 字段格式转换工具 ==========
function toSelect(val) { return val || null; }
function fromSelect(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && val.length > 0) return val[0]?.text || val[0] || '';
  if (val.text) return val.text;
  return '';
}
function toMultiSelect(arr) {
  if (!arr || !arr.length) return null;
  return arr;
}
function fromMultiSelect(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => v.text || v).filter(Boolean);
  return [];
}
function toDate(iso) {
  if (!iso) return null;
  return new Date(iso + 'T00:00:00+08:00').getTime();
}
function fromDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// 东八区当天日期 YYYY-MM-DD（用于自动补完成时间）
function todayCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function toAttachment(fileTokens) {
  if (!fileTokens || !fileTokens.length) return null;
  return fileTokens.map(token => ({ file_token: token }));
}
function fromAttachment(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => v.file_token || v).filter(Boolean);
  return [];
}
// 飞书人员字段（[{id, name, ...}] 或单个对象）→ 姓名字符串，避免拼成 [object Object]
function fromPerson(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(v => (v && (v.name || v.text || (v.text_arr && v.text_arr[0]))) || '').filter(Boolean).join('、');
  if (typeof val === 'object') return val.name || val.text || (val.text_arr && val.text_arr[0]) || '';
  return '';
}
function fromCheckinLog(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return {};
    if (s.startsWith('{')) { try { return JSON.parse(s); } catch (e) { return {}; } }
    // 可读格式解析：「2026-10-13、2026-10-14」→ { '2026-10-13': true, ... }
    const out = {};
    s.split(/[、,，;；\s]+/).filter(Boolean).forEach(d => { out[d.trim()] = true; });
    return out;
  }
  return {};
}
// 由打卡日期表算出三个统计值：总天数、连续天数（昨天或今天还在打才算连续中）、最近打卡时间戳
function checkinStats(log) {
  const days = Object.keys(log || {}).filter(d => log[d]).sort();
  const count = days.length;
  const last = count ? days[count - 1] : null;
  let streak = 0;
  if (last) {
    const t = new Date(Date.now() + 8 * 3600 * 1000);
    const tmd = t.toISOString().slice(0, 10);
    const ymd = new Date(t.getTime() - 86400000).toISOString().slice(0, 10);
    if (last === tmd || last === ymd) {
      streak = 1;
      for (let i = days.length - 2; i >= 0; i--) {
        const diff = (new Date(days[i + 1] + 'T00:00:00+08:00') - new Date(days[i] + 'T00:00:00+08:00')) / 86400000;
        if (diff === 1) streak++; else break;
      }
    }
  }
  return { count, streak, lastTs: last ? new Date(last + 'T00:00:00+08:00').getTime() : null };
}

function splitRecords(localRecords, buildFieldsFn) {
  const createBatch = [];
  const updateBatch = [];
  for (const rec of localRecords) {
    const fields = buildFieldsFn(rec);
    Object.keys(fields).forEach(k => {
      if (fields[k] === null || fields[k] === undefined) delete fields[k];
    });
    if (rec.record_id) {
      updateBatch.push({ record_id: rec.record_id, fields });
    } else {
      createBatch.push(fields);
    }
  }
  return { createBatch, updateBatch };
}

function assignRecordIds(localRecords, ids) {
  let idx = 0;
  for (const rec of localRecords) {
    if (!rec.record_id && idx < ids.length) {
      // 只补写 record_id，保留本地 id，前端才能按 id 建立 本地记录 ↔ 飞书记录 的映射
      rec.record_id = ids[idx];
      idx++;
    }
  }
}

// ========== 拉取逻辑（8 个模块）==========
async function pullTodo() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.todo;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    const status = fromSelect(f['状态']);
    const priorityRaw = fromSelect(f['优先级']);
    let priority = '低';
    if (priorityRaw && priorityRaw.startsWith('高')) priority = '高';
    else if (priorityRaw && priorityRaw.startsWith('中')) priority = '中';
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['事项'] || '', note: f['备注'] || '',
      date: fromDate(f['日期']),
      priority, done: status === '已完成',
      doneAt: fromDate(f['完成时间']),
      category: fromSelect(f['分类']) || '',
      updated_at: Date.now(),
    };
  });
}

async function pullWeekly() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.weeklylearn;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['重点内容'] || '', category: fromSelect(f['分类']) || '',
      priority: fromSelect(f['优先级']) || '', goalType: fromSelect(f['目标类型']) || '',
      stage: fromSelect(f['进展阶段']) || '未开始', note: f['备注'] || '',
      startDate: fromDate(f['开始日期']), endDate: fromDate(f['结束日期']),
      quantifiedTarget: f['量化目标'] || 0, week: f['周次'] || '',
      updated_at: Date.now(),
    };
  });
}

async function pullContent() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.content;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  const stageMap = { '灵感池': '选题池', '待评估': '选题池', '已写文案': '文案中', '待制作': '待拍摄', '制作中': '待拍摄', '已剪辑': '待拍摄', '已发布': '已发布' };
  return records.map(r => {
    const f = r.fields || {};
    const rawStage = fromSelect(f['状态']) || '';
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['选题简述'] || f['选题标题'] || '',
      stage: stageMap[rawStage] || rawStage || '选题池',
      platform: fromMultiSelect(f['目标平台']) || [],
      priority: fromSelect(f['优先级']) || '中',
      content: f['备注'] || '',
      date: fromDate(f['发布日期']) || fromDate(f['计划发布日']),
      deadline: fromDate(f['计划发布日']),
      photo: fromAttachment(f['封面图']),
      updated_at: Date.now(),
    };
  });
}

async function pullQuickshop() {
  const TABLE_CONFIG = requireTableConfig();
  const allRecords = [];
  const moodCfgs = TABLE_CONFIG.quickshop?.moodToTable || {};
  const fieldMaps = {
    '会员消费': { customer: '客户姓名', date: '消费日期', amount: '消费金额', project: '调理项目', gift: '赠送项目', therapist: '实际调理人', feedback: '调理效果', note: '备注' },
    '会员储值': { customer: '会员姓名', date: '充值日期', principal: '储值本金', giftAmount: '赠送金额', payMethod: '到账去向', firstTime: '是否首次储值', note: '备注', photo: '充值凭证' },
    '散客消费': { date: '消费日期', amount: '消费金额', project: '消费项目', payMethod: '支付方式', channel: '来源渠道', level: '客户分层', nickname: '微信标识/称呼', note: '备注', photo: '散客调理实拍' },
    '门店支出': { date: '支出日期', amount: '支出金额', category: '支出类别', payMethod: '支出方式', detail: '支出详情', note: '备注' },
    '赠送礼品': { date: '日期', customer: '姓名', category: '赠送类别', note: '备注' },
    '会员调理': { customer: '会员姓名', date: '调理日期', sessionNum: '第几次调理', project: '调理项目', focus: '本次调理重点', beforeState: '调理前状态', effect: '调理效果', feedbackWord: '客户反馈原话', giftProject: '赠送项目', note: '备注', photo: '客户实拍' },
  };
  // 6 张子表并行拉取（串行要 40+ 秒会超时，并行 ~8 秒）
  const moodEntries = Object.entries(moodCfgs).filter(([, tcfg]) => tcfg && tcfg.baseToken);
  const perMood = await Promise.all(moodEntries.map(async ([mood, tcfg]) => {
    try {
      const records = await fetchAllRecords(tcfg.baseToken, tcfg.tableId);
      const fieldMap = fieldMaps[mood];
      const out = [];
      for (const r of records) {
        const f = r.fields || {};
        const rec = { id: r.record_id, record_id: r.record_id, mood, updated_at: Date.now() };
        for (const [localField, feishuField] of Object.entries(fieldMap)) {
          if (!feishuField) continue;
          const val = f[feishuField];
          if (['project', 'gift', 'giftProject', 'category'].includes(localField)) {
            rec[localField] = fromMultiSelect(val) || [];
          } else if (['amount', 'principal', 'giftAmount', 'sessionNum'].includes(localField)) {
            rec[localField] = val || 0;
          } else if (['payMethod', 'firstTime', 'level'].includes(localField)) {
            rec[localField] = fromSelect(val) || '';
          } else if (localField === 'date') {
            rec[localField] = fromDate(val);
          } else if (localField === 'photo') {
            rec[localField] = fromAttachment(val);
          } else if (localField === 'customer' || localField === 'therapist') {
            rec[localField] = fromPerson(val);
          } else {
            rec[localField] = val || '';
          }
        }
        if (mood === '会员消费') rec.title = `${rec.customer || '客户'} ${(rec.project && rec.project[0]) || '消费'}`;
        else if (mood === '会员储值') rec.title = `${rec.customer || '会员'} 储值${rec.principal || 0}元`;
        else if (mood === '散客消费') rec.title = `散客 ${(rec.project && rec.project[0]) || '消费'} ${rec.amount || 0}元`;
        else if (mood === '门店支出') rec.title = `${(rec.category && rec.category[0]) || '支出'} - ${rec.detail || ''}`;
        else if (mood === '赠送礼品') rec.title = `${rec.customer || '赠送'} ${(rec.category && rec.category[0]) || '礼品'}`;
        else if (mood === '会员调理') rec.title = `${rec.customer || '会员'} ${(rec.project && rec.project[0]) || '调理'}`;
        out.push(rec);
      }
      return out;
    } catch (e) {
      console.error(`拉取 ${mood} 失败:`, e.message);
      return [];
    }
  }));
  for (const arr of perMood) allRecords.push(...arr);
  return allRecords;
}

async function pullDiary() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.diary;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['标题'] || '', content: f['内容'] || '',
      mood: fromSelect(f['分类']) || '灵感',
      date: fromDate(f['日期']),
      photo: fromAttachment(f['照片']),
      updated_at: Date.now(),
    };
  });
}

async function pullMoney() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.money;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    const typeRaw = fromSelect(f['收支类型']);
    const type = typeRaw === '收入' ? 'income' : typeRaw === '往来' ? 'transfer' : 'expense';
    const bigCategory = fromSelect(f['支出用途大分类']) || '';
    const smallCategory = fromSelect(f['支出用途类别小分类']) || '';
    const incomeCategory = fromSelect(f['收入分类']) || '';
    const transferCategory = fromSelect(f['往来分类']) || '';
    let title = type === 'expense' ? (smallCategory || bigCategory || '支出')
              : type === 'income' ? (incomeCategory || '收入')
              : (transferCategory || '往来');
    return {
      id: r.record_id, record_id: r.record_id, title, type,
      amount: f['金额'] || 0,
      bigCategory, smallCategory, incomeCategory, transferCategory,
      payMethod: fromSelect(f['支付方式']) || '',
      date: fromDate(f['日期']), note: f['备注'] || '',
      updated_at: Date.now(),
    };
  });
}

async function pullPeriod() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.period;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    return {
      id: r.record_id, record_id: r.record_id,
      startDate: fromDate(f['开始日期']), endDate: fromDate(f['结束日期']),
      status: fromSelect(f['状态']) || '经期中',
      flowAmount: fromSelect(f['经量']) || '', painLevel: fromSelect(f['痛经']) || '',
      color: fromSelect(f['颜色']) || '', texture: fromSelect(f['质地']) || '',
      symptoms: fromMultiSelect(f['身体症状']) || [], emotions: fromMultiSelect(f['情绪']) || [],
      note: f['备注'] || '',
      updated_at: Date.now(),
    };
  });
}

// 打卡明细表（与习惯主表同 base）：一行 = 某天打了某个习惯，飞书里用日历视图按月翻看。
// 表 ID 写死兜底，环境变量无需新增配置；若环境变量里配了 checkinDetail 则优先用配置
const CHECKIN_DETAIL_TABLE_ID = 'tbl06opr4nCwgg9N';
function checkinDetailCfg(TABLE_CONFIG) {
  const cfg = TABLE_CONFIG.checkin;
  return (TABLE_CONFIG.checkinDetail && TABLE_CONFIG.checkinDetail.tableId)
    ? TABLE_CONFIG.checkinDetail
    : { baseToken: cfg.baseToken, tableId: CHECKIN_DETAIL_TABLE_ID };
}
// 明细行日期字段（毫秒时间戳）→ 东八区 YYYY-MM-DD
function detailDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function pullCheckin() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg || !cfg.baseToken) return [];
  // 习惯清单来自主表；打卡明细从明细表按行聚合成 { 习惯: { 日期: true } }
  let detailOk = true;
  const [records, detailRows] = await Promise.all([
    fetchAllRecords(cfg.baseToken, cfg.tableId),
    fetchAllRecords(cfg.baseToken, checkinDetailCfg(TABLE_CONFIG).tableId).catch(() => { detailOk = false; return []; }),
  ]);
  const logMap = {};
  for (const r of detailRows) {
    const f = r.fields || {};
    const title = fromSelect(f['习惯名称']).trim();
    const ms = f['打卡日期'];
    if (!title || !ms) continue;
    (logMap[title] = logMap[title] || {})[detailDay(ms)] = true;
  }
  return records.map(r => {
    const f = r.fields || {};
    const title = String(f['习惯名称'] || '').trim();
    return {
      id: r.record_id, record_id: r.record_id,
      title,
      // 明细表拿不到时才回退旧的长文本列；明细表正常时它就是唯一事实来源（空=没打）
      log: detailOk ? (logMap[title] || {}) : fromCheckinLog(f['打卡记录']),
      autoCheck: fromSelect(f['自动关联模块']) || '',
      updated_at: Date.now(),
    };
  });
}

const pullers = {
  todo: pullTodo, weeklylearn: pullWeekly, content: pullContent, quickshop: pullQuickshop,
  diary: pullDiary, money: pullMoney, period: pullPeriod, checkin: pullCheckin,
};

// ========== 推送逻辑（8 个模块）==========
async function pushTodo(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.todo;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  // 以「事项+日期」为业务主键 upsert：同名同日期只更新不新建，根治重复推送产生的副本；
  // 注意同名不同日期是合法任务（如每日例行），不能只按事项匹配
  const remote = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  const remoteIds = new Set(remote.map(r => r.record_id));
  const byKey = new Map();
  for (const r of remote) {
    const f = r.fields || {};
    const key = `${f['事项'] || ''}|${fromDate(f['日期'])}`;
    if (!byKey.has(key)) byKey.set(key, r.record_id);
  }
  const prioLabel = p => p === '高' ? '高（今天必须做）' : p === '中' ? '中（尽量今天做）' : '低（有空再说）';
  const buildFields = rec => {
    const fields = {
      '事项': rec.title || '', '备注': rec.note || '',
      '日期': toDate(rec.date),
      '优先级': toSelect(prioLabel(rec.priority)),
      '状态': toSelect(rec.done ? '已完成' : '待办'),
      '分类': toSelect(rec.category || '其他'),
      // 完成时间：勾选完成时写实际完成日期；取消勾选时显式 null 清空
      '完成时间': rec.done ? toDate(rec.doneAt || todayCN()) : null,
    };
    return fields;
  };
  const createBatch = [];
  const updateBatch = [];
  const updatedRefs = [];
  for (const rec of records) {
    const title = (rec.title || '').trim();
    if (!title) continue; // 空标题不入库
    const key = `${title}|${rec.date || ''}`;
    let rid = byKey.get(key);
    if (!rid && rec.record_id && remoteIds.has(rec.record_id)) rid = rec.record_id;
    if (rid) {
      updateBatch.push({ record_id: rid, fields: buildFields(rec) });
      updatedRefs.push({ rec, record_id: rid });
    } else {
      createBatch.push(buildFields(rec));
    }
  }
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  for (const { rec, record_id } of updatedRefs) rec.record_id = record_id;
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

async function pushWeekly(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.weeklylearn;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '重点内容': rec.title || '', '分类': toSelect(rec.category),
    '优先级': toSelect(rec.priority), '目标类型': toSelect(rec.goalType),
    '进展阶段': toSelect(rec.stage || '未开始'), '备注': rec.note || '',
    '开始日期': toDate(rec.startDate), '结束日期': toDate(rec.endDate),
    '量化目标': rec.quantifiedTarget ? Number(rec.quantifiedTarget) : null,
    '周次': rec.week || '',
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

async function pushContent(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.content;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  const stageMap = { '选题池': '灵感池', '文案中': '已写文案', '待拍摄': '待制作', '已发布': '已发布' };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '选题简述': rec.title || '',
    '状态': toSelect(stageMap[rec.stage] || rec.stage || '灵感池'),
    '优先级': toSelect(rec.priority),
    '目标平台': toMultiSelect(Array.isArray(rec.platform) ? rec.platform : [rec.platform].filter(Boolean)),
    '备注': rec.content || '',
    '计划发布日': toDate(rec.deadline || rec.date),
    '封面图': toAttachment(rec.photo),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

async function pushQuickshop(records) {
  const TABLE_CONFIG = requireTableConfig();
  let created = 0, updated = 0;
  const warnings = [];
  const moodCfgs = TABLE_CONFIG.quickshop?.moodToTable || {};

  // 定位「会员基础信息」表（用于「客户姓名」单向关联字段）
  // 该表与各消费子表同库，故优先从 quickshop 子表取 baseToken，避免额外改环境变量
  const customerCfg = TABLE_CONFIG.customerBase || {};
  const firstSubCfg = Object.values(moodCfgs).find(c => c && c.baseToken) || {};
  const memberBaseToken = customerCfg.baseToken || firstSubCfg.baseToken || '';
  const memberTableId = customerCfg.tableId || 'tblUR8LahmsWXFfy';

  const fieldMaps = {
    '会员消费': { customer: '客户姓名', date: '消费日期', amount: '消费金额', project: '调理项目', gift: '赠送项目', therapist: '实际调理人', feedback: '调理效果', note: '备注' },
    '会员储值': { customer: '会员姓名', date: '充值日期', principal: '储值本金', giftAmount: '赠送金额', payMethod: '到账去向', firstTime: '是否首次储值', note: '备注', photo: '充值凭证' },
    '散客消费': { date: '消费日期', amount: '消费金额', project: '消费项目', payMethod: '支付方式', channel: '来源渠道', level: '客户分层', nickname: '微信标识/称呼', note: '备注', photo: '散客调理实拍' },
    '门店支出': { date: '支出日期', amount: '支出金额', category: '支出类别', payMethod: '支出方式', detail: '支出详情', note: '备注' },
    '赠送礼品': { date: '日期', customer: '姓名', category: '赠送类别', note: '备注' },
    '会员调理': { customer: '会员姓名', date: '调理日期', sessionNum: '第几次调理', project: '调理项目', focus: '本次调理重点', beforeState: '调理前状态', effect: '调理效果', feedbackWord: '客户反馈原话', giftProject: '赠送项目', note: '备注', photo: '客户实拍' },
  };

  const byMood = {};
  for (const rec of records) {
    const mood = rec.mood || '会员消费';
    if (!byMood[mood]) byMood[mood] = [];
    byMood[mood].push(rec);
  }

  for (const [mood, recs] of Object.entries(byMood)) {
    const tcfg = moodCfgs[mood];
    const fieldMap = fieldMaps[mood];
    if (!tcfg || !fieldMap) continue;

    // 1) 取该表字段类型，判断「客户姓名」是否为关联字段
    let fieldTypes = {};
    try {
      fieldTypes = await getFieldTypes(tcfg.baseToken, tcfg.tableId);
    } catch (e) {
      console.error('[FIELDS] 获取字段类型失败，按文本处理:', e.message);
    }
    const customerFeishuField = fieldMap.customer;
    const isCustomerLink = customerFeishuField && LINK_FIELD_TYPES.includes(fieldTypes[customerFeishuField]);

    // 2) 关联字段：必须在 splitRecords 之前把 record_id 解析好（splitRecords 是同步的）
    if (isCustomerLink && memberBaseToken && memberTableId) {
      for (const rec of recs) {
        if (rec.customer && !rec._customerRecordId) {
          try {
            rec._customerRecordId = await findCustomerRecordId(memberBaseToken, memberTableId, rec.customer);
          } catch (e) {
            console.error('[CUSTOMER] 解析客户关联失败:', rec.customer, e.message);
            warnings.push(`${mood} 客户「${rec.customer}」关联解析失败: ${e.message}`);
          }
        }
      }
    }

    // 3) 构造字段
    const { createBatch, updateBatch } = splitRecords(recs, rec => {
      const fields = {};
      for (const [localField, feishuField] of Object.entries(fieldMap)) {
        if (!feishuField) continue;
        const val = rec[localField];
        if (localField === 'customer') {
          // 关联字段写 record_id 数组；文本字段写名字；解析失败则跳过该字段（避免整批写入失败）
          if (val) {
            if (isCustomerLink) {
              if (rec._customerRecordId) fields[feishuField] = [rec._customerRecordId];
            } else {
              fields[feishuField] = val;
            }
          }
        } else if (['project', 'gift', 'giftProject', 'category'].includes(localField)) {
          if (val && val.length) fields[feishuField] = toMultiSelect(val);
        } else if (['amount', 'principal', 'giftAmount', 'sessionNum'].includes(localField)) {
          if (val != null) fields[feishuField] = Number(val) || 0;
        } else if (['payMethod', 'firstTime', 'level'].includes(localField)) {
          if (val) fields[feishuField] = toSelect(val);
        } else if (localField === 'date') {
          if (val) fields[feishuField] = toDate(val);
        } else if (localField === 'photo') {
          if (val && val.length) fields[feishuField] = toAttachment(val);
        } else {
          if (val != null) fields[feishuField] = val;
        }
      }
      return fields;
    });

    const up = await batchUpdate(tcfg.baseToken, tcfg.tableId, updateBatch);
    const cr = await batchCreate(tcfg.baseToken, tcfg.tableId, createBatch);
    assignRecordIds(recs, cr.record_ids);
    created += cr.record_ids.length;
    updated += up.count;
  }
  return { created, updated, records, warnings };
}

async function pushDiary(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.diary;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '标题': rec.title || '', '内容': rec.content || '',
    '分类': toSelect(rec.mood || '灵感'), '日期': toDate(rec.date),
    '照片': toAttachment(rec.photo),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

async function pushMoney(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.money;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  const { createBatch, updateBatch } = splitRecords(records, rec => {
    let typeLabel = '支出';
    if (rec.type === 'income') typeLabel = '收入';
    else if (rec.type === 'transfer') typeLabel = '往来';
    const fields = {
      '日期': toDate(rec.date), '金额': Number(rec.amount) || 0,
      '收支类型': toSelect(typeLabel), '支付方式': toSelect(rec.payMethod),
      '备注': rec.note || '',
    };
    if (rec.type === 'expense') {
      if (rec.bigCategory) fields['支出用途大分类'] = toSelect(rec.bigCategory);
      if (rec.smallCategory) fields['支出用途类别小分类'] = toSelect(rec.smallCategory);
    } else if (rec.type === 'income') {
      if (rec.incomeCategory) fields['收入分类'] = toSelect(rec.incomeCategory);
    } else if (rec.type === 'transfer') {
      if (rec.transferCategory) fields['往来分类'] = toSelect(rec.transferCategory);
    }
    return fields;
  });
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

async function pushPeriod(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.period;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '开始日期': toDate(rec.startDate), '结束日期': toDate(rec.endDate),
    '状态': toSelect(rec.status || '经期中'),
    '经量': toSelect(rec.flowAmount), '痛经': toSelect(rec.painLevel),
    '颜色': toSelect(rec.color), '质地': toSelect(rec.texture),
    '身体症状': toMultiSelect(rec.symptoms || []), '情绪': toMultiSelect(rec.emotions || []),
    '备注': rec.note || '',
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

async function pushCheckin(records) {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg || !cfg.baseToken) return { created: 0, updated: 0, records };
  // 主表：以「习惯名称」为业务主键 upsert，只维护清单和统计列；
  // 长文本「打卡记录」列停用，按月明细由「打卡明细」表承担（一行=某天某习惯）
  const remote = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  const byTitle = new Map();
  for (const r of remote) {
    const t = (r.fields || {})['习惯名称'];
    if (t && !byTitle.has(t)) byTitle.set(t, r.record_id);
  }
  // 明细表对账：现有行按「习惯|日期」建索引，目标缺行则补建，多出的行（取消勾选）删除
  const detailCfg = checkinDetailCfg(TABLE_CONFIG);
  const detailRows = await fetchAllRecords(detailCfg.baseToken, detailCfg.tableId).catch(() => []);
  const detailByKey = new Map(); // '习惯|YYYY-MM-DD' -> record_id
  for (const r of detailRows) {
    const f = r.fields || {};
    const t = fromSelect(f['习惯名称']).trim();
    const ms = f['打卡日期'];
    if (t && ms) detailByKey.set(t + '|' + detailDay(ms), r.record_id);
  }
  const createBatch = [];
  const updateBatch = [];
  const updatedRefs = []; // [{ rec, record_id }] 更新成功后回填本地
  const detailCreate = [];
  const detailDelete = [];
  const targetKeys = new Set();
  const syncedTitles = new Set();
  for (const rec of records) {
    const title = (rec.title || '').trim();
    if (!title) continue; // 空标题不入库，避免云端出现空白行
    syncedTitles.add(title);
    const st = checkinStats(rec.log);
    const fields = {
      '习惯名称': title,
      '自动关联模块': toSelect(rec.autoCheck || ''),
      '打卡天数': st.count,
      '连续打卡': st.streak,
      '最近打卡': st.lastTs,
    };
    const rid = byTitle.has(title) ? byTitle.get(title) : (rec.record_id || null);
    if (rid) {
      updateBatch.push({ record_id: rid, fields });
      updatedRefs.push({ rec, record_id: rid });
    } else {
      createBatch.push(fields);
    }
    for (const day of Object.keys(rec.log || {})) {
      if (!rec.log[day]) continue;
      const key = title + '|' + day;
      targetKeys.add(key);
      if (!detailByKey.has(key)) {
        detailCreate.push({ '习惯名称': title, '打卡日期': new Date(day + 'T00:00:00+08:00').getTime() });
      }
    }
  }
  for (const [key, rid] of detailByKey) {
    const t = key.slice(0, key.lastIndexOf('|'));
    if (rid && syncedTitles.has(t) && !targetKeys.has(key)) detailDelete.push(rid);
  }
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  await batchCreate(detailCfg.baseToken, detailCfg.tableId, detailCreate).catch(e => {
    console.error('[checkin] 明细补建失败(不影响主表):', e.message);
  });
  if (detailDelete.length) {
    await batchDelete(detailCfg.baseToken, detailCfg.tableId, detailDelete).catch(e => {
      console.error('[checkin] 明细清理失败(不影响主表):', e.message);
    });
  }
  for (const { rec, record_id } of updatedRefs) {
    rec.record_id = record_id;
  }
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count, records };
}

const pushers = {
  todo: pushTodo, weeklylearn: pushWeekly, content: pushContent, quickshop: pushQuickshop,
  diary: pushDiary, money: pushMoney, period: pushPeriod, checkin: pushCheckin,
};

// ========== HTTP 响应封装 ==========
function sendJSON(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 15 * 1024 * 1024) { reject(new Error('请求体超过 15MB 限制')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('请求体 JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

// ========== 附件上传 / 图片代理 ==========
// 根据模块找到对应 baseToken（quickshop 按记录类型分表）
function baseTokenOfModule(moduleKey, mood) {
  const TABLE_CONFIG = requireTableConfig();
  if (moduleKey === 'quickshop') {
    const tcfg = TABLE_CONFIG.quickshop?.moodToTable?.[mood];
    return tcfg?.baseToken || null;
  }
  return TABLE_CONFIG[moduleKey]?.baseToken || null;
}

// 上传图片到飞书素材库（bitable_file），返回 file_token
// 前端先压缩成 JPEG base64 再传，避免大文件超限
async function uploadBitableFile(baseToken, fileName, buf) {
  const boundary = '----xzzboundary' + Date.now() + Math.random().toString(16).slice(2);
  const enc = s => Buffer.from(s, 'utf8');
  const parts = [
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n`),
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file\r\n`),
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${baseToken}\r\n`),
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${buf.length}\r\n`),
    Buffer.concat([
      enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`),
      buf,
      enc('\r\n'),
    ]),
    enc(`--${boundary}--\r\n`),
  ];
  const token = await getTenantAccessToken();
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`上传飞书素材失败: ${data.code} ${data.msg}`);
  return data.data.file_token;
}

// 代理下载飞书素材（<img> 标签无法带 Authorization，必须由云函数中转）
async function downloadMedia(res, fileToken) {
  const token = await getTenantAccessToken();
  const r = await fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    res.writeHead(r.status, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': r.headers.get('content-type') || 'image/jpeg',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

// ========== HTTP Server（腾讯云 Web 函数约定监听 0.0.0.0:9000）==========
const PORT = Number(process.env.PORT) || 9000;
const HOST = '0.0.0.0';

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    return sendJSON(res, 200, { ok: true });
  }

  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query || {};
  const action = query.action || '';
  const module = query.module || '';

  // 健康检查（暴露所有配置加载错误，便于排查）
  if (action === 'status') {
    const { config, error } = getTableConfig();
    return sendJSON(res, 200, {
      ok: true,
      message: '腾讯云 SCF Web 函数运行正常',
      time: Date.now(),
      authMode: 'tenant_access_token（应用身份，永久免授权）',
      hasAppId: !!FEISHU_APP_ID,
      hasAppSecret: !!FEISHU_APP_SECRET,
      hasTableConfig: !!config,
      tableConfigError: error,
      tableConfigModules: config ? Object.keys(config).join(', ') : null,
      tableConfigRawLength: process.env.FEISHU_TABLE_CONFIG ? process.env.FEISHU_TABLE_CONFIG.length : 0,
    });
  }

  // 清理指定月份的记录（用于清除重复推送产生的垃圾数据；&dry=1 只预览不删除）
  if (action === 'clearMonth' && module) {
    const month = query.month || '';
    if (!/^\d{4}-\d{2}$/.test(month)) return sendJSON(res, 400, { ok: false, error: 'month 参数格式应为 YYYY-MM' });
    const TABLE_CONFIG = requireTableConfig();
    const cfg = TABLE_CONFIG[module];
    if (!cfg || !cfg.baseToken) return sendJSON(res, 400, { ok: false, error: `未配置的模块: ${module}` });
    try {
      const all = await fetchAllRecords(cfg.baseToken, cfg.tableId);
      const target = all.filter(r => {
        const f = r.fields || {};
        const d = fromDate(f['日期'] || f['打卡日期'] || f['开始日期']);
        return d.startsWith(month);
      });
      const ids = target.map(r => r.record_id);
      if (query.dry === '1') {
        return sendJSON(res, 200, { ok: true, dry: true, month, wouldDelete: ids.length,
          preview: target.slice(0, 8).map(r => ({ id: r.record_id, date: fromDate((r.fields || {})['日期']) })) });
      }
      const { count } = await batchDelete(cfg.baseToken, cfg.tableId, ids);
      console.log(`[CLEAR] ${module} ${month}: 删除 ${count} 条`);
      return sendJSON(res, 200, { ok: true, month, deleted: count });
    } catch (e) {
      console.error('[CLEAR] error:', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 诊断接口（只读，绝不写入）：查看 quickshop 各表字段类型、会员表可读性
  // 用法：?action=diag  /  ?action=diag&name=丁蓉
  if (action === 'diag') {
    try {
      const TABLE_CONFIG = requireTableConfig();
      const moodCfgs = TABLE_CONFIG.quickshop?.moodToTable || {};
      const out = { ok: true, quickshop: [], member: null };

      for (const [mood, cfg] of Object.entries(moodCfgs)) {
        if (!cfg || !cfg.baseToken) continue;
        const item = { mood, tableId: cfg.tableId };
        try {
          item.fields = await getFieldTypes(cfg.baseToken, cfg.tableId);
          item.customerFieldType = item.fields['客户姓名'] ?? item.fields['会员姓名'] ?? item.fields['姓名'] ?? null;
          item.customerFieldIsLink = LINK_FIELD_TYPES.includes(item.customerFieldType);
        } catch (e) { item.error = e.message; }
        out.quickshop.push(item);
      }

      const cfgBase = TABLE_CONFIG.customerBase || {};
      const firstSub = Object.values(moodCfgs).find(c => c && c.baseToken) || {};
      const mbt = cfgBase.baseToken || firstSub.baseToken;
      const mtid = cfgBase.tableId || 'tblUR8LahmsWXFfy';
      if (mbt && mtid) {
        const member = { tableId: mtid };
        try {
          member.fields = await getFieldTypes(mbt, mtid);
          const recs = await fetchAllRecords(mbt, mtid);
          member.count = recs.length;
          member.sample = recs.slice(0, 5).map(r => {
            const n = r.fields?.['会员姓名'];
            return typeof n === 'string' ? n : (n?.text || '');
          });
          if (query.name) {
            const wanted = query.name;
            const hit = recs.find(r => {
              const n = r.fields?.['会员姓名'];
              const s = typeof n === 'string' ? n : (n?.text || '');
              return s === wanted;
            });
            member.lookup = { name: wanted, record_id: hit ? hit.record_id : null, existed: !!hit };
          }
        } catch (e) { member.error = e.message; }
        out.member = member;
      }
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 通用删除接口：action=delete&module=xxx&record_id=xxx
  if (action === 'delete' && module) {
    const recordId = query.record_id || '';
    if (!recordId) return sendJSON(res, 400, { ok: false, error: '缺少 record_id 参数' });
    const TABLE_CONFIG = requireTableConfig();
    let cfg = TABLE_CONFIG[module];
    // quickshop 特殊处理：需要根据 mood 找子表
    if (module === 'quickshop') {
      const mood = query.mood || '';
      if (!mood) return sendJSON(res, 400, { ok: false, error: 'quickshop 模块需要 mood 参数' });
      cfg = TABLE_CONFIG.quickshop?.moodToTable?.[mood];
      if (!cfg) return sendJSON(res, 400, { ok: false, error: `未配置的记录类型: ${mood}` });
    }
    if (!cfg || !cfg.baseToken || !cfg.tableId) return sendJSON(res, 400, { ok: false, error: `未配置的模块: ${module}` });
    try {
      const { count } = await batchDelete(cfg.baseToken, cfg.tableId, [recordId]);
      console.log(`[DELETE] ${module} record_id=${recordId}: 删除 ${count} 条`);
      return sendJSON(res, 200, { ok: true, module, record_id: recordId, deleted: count });
    } catch (e) {
      console.error('[DELETE] error:', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 拉取
  if (action === 'pull' && module) {
    const puller = pullers[module];
    if (!puller) return sendJSON(res, 400, { ok: false, error: `不支持的模块: ${module}` });
    try {
      console.log(`[SYNC] Pulling ${module} from Feishu...`);
      const records = await puller();
      console.log(`[SYNC] Pulled ${records.length} records from ${module}`);
      return sendJSON(res, 200, { ok: true, records });
    } catch (e) {
      console.error('[SYNC] Pull error:', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 推送
  if (action === 'push' && module) {
    const pusher = pushers[module];
    if (!pusher) return sendJSON(res, 400, { ok: false, error: `不支持的模块: ${module}` });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
    const localRecords = body.records || [];
    try {
      console.log(`[SYNC] Pushing ${localRecords.length} records to ${module}...`);
      const result = await pusher(localRecords);
      console.log(`[SYNC] Push done: created=${result.created}, updated=${result.updated}`);
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error('[SYNC] Push error:', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 图片上传（前端压缩后 base64 传入）；quickshop 按记录类型(mood)选表，其余按模块选表
  if (action === 'upload' && module) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
    try {
      const mood = query.mood || body.mood || '';
      const baseToken = baseTokenOfModule(module, mood);
      if (!baseToken) return sendJSON(res, 400, { ok: false, error: `未配置的模块/记录类型: ${module} ${mood}` });
      const buf = Buffer.from(body.dataBase64 || '', 'base64');
      if (!buf.length) return sendJSON(res, 400, { ok: false, error: '图片数据为空' });
      const fileName = body.fileName || `photo-${Date.now()}.jpg`;
      const fileToken = await uploadBitableFile(baseToken, fileName, buf);
      console.log(`[UPLOAD] mood=${query.mood} bytes=${buf.length} token=${fileToken}`);
      return sendJSON(res, 200, { ok: true, file_token: fileToken });
    } catch (e) {
      console.error('[UPLOAD] error:', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // 图片代理下载（<img src> 直接引用）
  if (action === 'media' && query.token) {
    try {
      return await downloadMedia(res, query.token);
    } catch (e) {
      console.error('[MEDIA] error:', e.message);
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
  }

  return sendJSON(res, 400, {
    ok: false,
    error: `未知请求: action=${action}, module=${module}`,
    hint: '支持 ?action=pull&module=todo / ?action=push&module=todo / ?action=upload&module=quickshop / ?action=media&token=xxx / ?action=status',
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[SCF Web 函数] 监听 ${HOST}:${PORT}（应用身份 tenant_access_token 模式）`);
  console.log(`[SCF Web 函数] APP_ID: ${FEISHU_APP_ID ? '已配置' : '未配置'}`);
  console.log(`[SCF Web 函数] TABLE_CONFIG: ${process.env.FEISHU_TABLE_CONFIG ? `已配置（${process.env.FEISHU_TABLE_CONFIG.length} 字节）` : '未配置'}`);
});

module.exports = { server, pullers, pushers };
