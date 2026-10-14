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
function toAttachment(fileTokens) {
  if (!fileTokens || !fileTokens.length) return null;
  return fileTokens.map(token => ({ file_token: token }));
}
function fromAttachment(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => v.file_token || v).filter(Boolean);
  return [];
}
function toCheckinLog(log) {
  if (!log || typeof log !== 'object') return '';
  return JSON.stringify(log);
}
function fromCheckinLog(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (e) { return {}; }
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
      rec.record_id = ids[idx];
      rec.id = ids[idx];
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
    '会员消费': { customer: '客户姓名', date: '消费日期', amount: '消费金额', project: '调理项目', gift: '赠送项目', therapist: '实际调理人', feedback: '调理效果', note: '备注', photo: '客户实拍' },
    '会员储值': { customer: '会员姓名', date: '充值日期', principal: '储值本金', giftAmount: '赠送金额', payMethod: '到账去向', firstTime: '是否首次储值', note: '备注', photo: '充值凭证' },
    '散客消费': { date: '消费日期', amount: '消费金额', project: '消费项目', payMethod: '支付方式', channel: '来源渠道', level: '客户分层', nickname: '微信标识/称呼', note: '备注' },
    '门店支出': { date: '支出日期', amount: '支出金额', category: '支出类别', payMethod: '支出方式', detail: '支出详情', note: '备注' },
    '赠送礼品': { date: '日期', customer: '姓名', category: '赠送类别', note: '备注' },
    '会员调理': { customer: '会员姓名', date: '调理日期', sessionNum: '第几次调理', project: '调理项目', focus: '本次调理重点', beforeState: '调理前状态', effect: '调理效果', feedbackWord: '客户反馈原话', giftProject: '赠送项目', note: '备注' },
  };
  for (const [mood, tcfg] of Object.entries(moodCfgs)) {
    if (!tcfg || !tcfg.baseToken) continue;
    try {
      const records = await fetchAllRecords(tcfg.baseToken, tcfg.tableId);
      const fieldMap = fieldMaps[mood];
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
          } else {
            rec[localField] = val || '';
          }
        }
        if (mood === '会员消费') rec.title = `${rec.customer || '客户'} ${(rec.project && rec.project[0]) || '消费'}`;
        else if (mood === '会员储值') rec.title = `${rec.customer || '会员'} 储值${rec.principal || 0}元`;
        else if (mood === '散客消费') rec.title = `散客 ${(rec.project && rec.project[0]) || '消费'} ${rec.amount || 0}元`;
        else if (mood === '门店支出') rec.title = `${rec.category || '支出'} - ${rec.detail || ''}`;
        else if (mood === '赠送礼品') rec.title = `${rec.customer || '赠送'} ${(rec.category && rec.category[0]) || '礼品'}`;
        else if (mood === '会员调理') rec.title = `${rec.customer || '会员'} ${(rec.project && rec.project[0]) || '调理'}`;
        allRecords.push(rec);
      }
    } catch (e) {
      console.error(`拉取 ${mood} 失败:`, e.message);
    }
  }
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

async function pullCheckin() {
  const TABLE_CONFIG = requireTableConfig();
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg || !cfg.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['习惯名称'] || '',
      log: fromCheckinLog(f['打卡记录']),
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
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '事项': rec.title || '', '备注': rec.note || '',
    '日期': toDate(rec.date),
    '优先级': toSelect(rec.priority === '高' ? '高（今天必须做）' : rec.priority === '中' ? '中（尽量今天做）' : '低（有空再说）'),
    '状态': toSelect(rec.done ? '已完成' : '待办'),
    '分类': toSelect(rec.category || '其他'),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
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
  const moodCfgs = TABLE_CONFIG.quickshop?.moodToTable || {};
  const fieldMaps = {
    '会员消费': { customer: '客户姓名', date: '消费日期', amount: '消费金额', project: '调理项目', gift: '赠送项目', therapist: '实际调理人', feedback: '调理效果', note: '备注', photo: '客户实拍' },
    '会员储值': { customer: '会员姓名', date: '充值日期', principal: '储值本金', giftAmount: '赠送金额', payMethod: '到账去向', firstTime: '是否首次储值', note: '备注', photo: '充值凭证' },
    '散客消费': { date: '消费日期', amount: '消费金额', project: '消费项目', payMethod: '支付方式', channel: '来源渠道', level: '客户分层', nickname: '微信标识/称呼', note: '备注' },
    '门店支出': { date: '支出日期', amount: '支出金额', category: '支出类别', payMethod: '支出方式', detail: '支出详情', note: '备注' },
    '赠送礼品': { date: '日期', customer: '姓名', category: '赠送类别', note: '备注' },
    '会员调理': { customer: '会员姓名', date: '调理日期', sessionNum: '第几次调理', project: '调理项目', focus: '本次调理重点', beforeState: '调理前状态', effect: '调理效果', feedbackWord: '客户反馈原话', giftProject: '赠送项目', note: '备注' },
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
    const { createBatch, updateBatch } = splitRecords(recs, rec => {
      const fields = {};
      for (const [localField, feishuField] of Object.entries(fieldMap)) {
        if (!feishuField) continue;
        const val = rec[localField];
        if (['project', 'gift', 'giftProject', 'category'].includes(localField)) {
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
  return { created, updated, records };
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
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '习惯名称': rec.title || '',
    '打卡记录': toCheckinLog(rec.log),
    '自动关联模块': toSelect(rec.autoCheck || ''),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
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
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('请求体 JSON 格式错误')); }
    });
    req.on('error', reject);
  });
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

  return sendJSON(res, 400, {
    ok: false,
    error: `未知请求: action=${action}, module=${module}`,
    hint: '支持 ?action=pull&module=todo / ?action=push&module=todo / ?action=status',
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[SCF Web 函数] 监听 ${HOST}:${PORT}（应用身份 tenant_access_token 模式）`);
  console.log(`[SCF Web 函数] APP_ID: ${FEISHU_APP_ID ? '已配置' : '未配置'}`);
  console.log(`[SCF Web 函数] TABLE_CONFIG: ${process.env.FEISHU_TABLE_CONFIG ? `已配置（${process.env.FEISHU_TABLE_CONFIG.length} 字节）` : '未配置'}`);
});

module.exports = { server, pullers, pushers };
