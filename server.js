// 喜姿姿工作台 本地服务器
// 直接调用飞书开放平台 API，不依赖 lark-cli
// 需要配置：FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_TABLE_CONFIG

const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== 配置加载 ==========
// 优先级：sync-config.js（本地真实密钥，不提交） > 环境变量 > app-config.js
const SYNC_CONFIG_PATH = path.join(__dirname, 'sync-config.js');
let SYNC_CONFIG = {};
if (fs.existsSync(SYNC_CONFIG_PATH)) {
  try {
    SYNC_CONFIG = require(SYNC_CONFIG_PATH);
  } catch (e) {
    console.warn('加载 sync-config.js 失败:', e.message);
  }
}

const CONFIG_PATH = path.join(__dirname, 'app-config.js');
let APP_CONFIG = {};
if (fs.existsSync(CONFIG_PATH)) {
  // 读取 app-config.js 内容并提取 APP_CONFIG
  const content = fs.readFileSync(CONFIG_PATH, 'utf8');
  const match = content.match(/window\.APP_CONFIG\s*=\s*({[\s\S]*?});/);
  if (match) {
    try {
      APP_CONFIG = new Function('return (' + match[1] + ')')();
    } catch (e) {
      console.warn('解析 app-config.js 失败:', e.message);
    }
  }
}

const FEISHU_APP_ID = SYNC_CONFIG.FEISHU_APP_ID || process.env.FEISHU_APP_ID || APP_CONFIG.FEISHU_APP_ID;
const FEISHU_APP_SECRET = SYNC_CONFIG.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET || APP_CONFIG.FEISHU_APP_SECRET;
const TABLE_CONFIG = SYNC_CONFIG.TABLE_CONFIG || APP_CONFIG.FEISHU_TABLE_CONFIG || {};
const REDIRECT_URI = SYNC_CONFIG.REDIRECT_URI || process.env.FEISHU_REDIRECT_URI || 'http://localhost:8080/api/auth/callback';

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.warn('⚠️  警告：未配置 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
  console.warn('   请在 sync-config.js 中填写飞书应用凭证');
}

// ========== user_access_token 管理（OAuth 用户授权模式）==========
const TOKEN_CACHE_PATH = path.join(__dirname, '.token-cache.json');
let _memToken = null; // 内存缓存（文件写入可能被沙箱限制时的后备）

function loadTokenCache() {
  // 优先用内存缓存
  if (_memToken && _memToken.access_token) return _memToken;
  try {
    if (fs.existsSync(TOKEN_CACHE_PATH)) {
      const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
      _memToken = cache;
      return cache;
    }
  } catch (e) { console.warn('读取 token 缓存失败:', e.message); }
  return null;
}

function saveTokenCache(cache) {
  _memToken = cache; // 内存缓存一定生效
  try {
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) { console.warn('保存 token 缓存到文件失败（内存缓存仍有效）:', e.message); }
}

// v1 token 端点需要 app_access_token，先获取它
async function getAppAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取 app_access_token 失败: ${data.msg}`);
  return data.app_access_token;
}

async function refreshUserToken(refreshToken) {
  const appToken = await getAppAccessToken();
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/refresh_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${appToken}` },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`刷新 token 失败: ${data.msg || JSON.stringify(data)}`);
  }
  const cache = {
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token,
    expires_at: Date.now() + (data.data.expires_in || 7200) * 1000,
  };
  saveTokenCache(cache);
  return cache;
}

async function getUserAccessToken() {
  const cache = loadTokenCache();
  if (!cache || !cache.access_token) {
    throw new Error('NOT_AUTHORIZED: 尚未完成飞书授权，请先访问 /api/auth/login');
  }
  // token 有效（提前 5 分钟过期判定）
  if (cache.expires_at > Date.now() + 300000) {
    return cache.access_token;
  }
  // token 过期，用 refresh_token 刷新
  if (cache.refresh_token) {
    console.log('[AUTH] token 已过期，正在刷新...');
    const refreshed = await refreshUserToken(cache.refresh_token);
    return refreshed.access_token;
  }
  throw new Error('NOT_AUTHORIZED: token 已过期且无法刷新，请重新访问 /api/auth/login');
}

// 保留旧名兼容（Netlify Functions 仍用 tenant_access_token）
async function getTenantAccessToken() {
  return getUserAccessToken();
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

async function fetchAllRecords(baseToken, tableId) {
  const allRecords = [];
  let pageToken = null;
  const pageSize = 200;

  while (true) {
    let url = `/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=${pageSize}`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;

    const data = await feishuApi('GET', url);
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
  return {
    record_ids: (data.data?.records || []).map(r => r.record_id),
    records: data.data?.records || [],
  };
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

// ========== 字段转换工具 ==========
function toSelect(val) { return val || null; }
function fromSelect(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && val.length > 0) return val[0]?.text || val[0] || '';
  if (val.text) return val.text;
  return '';
}
function toMultiSelect(arr) { return arr && arr.length ? arr : null; }
function fromMultiSelect(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => v.text || v).filter(Boolean);
  return [];
}
function toDate(iso) { return iso ? new Date(iso + 'T00:00:00+08:00').getTime() : null; }
function fromDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toAttachment(fileTokens) { return fileTokens && fileTokens.length ? fileTokens.map(t => ({ file_token: t })) : null; }
function fromAttachment(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => v.file_token || v).filter(Boolean);
  return [];
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

// ========== 拉取逻辑（8个模块）==========
async function pullTodo() {
  const cfg = TABLE_CONFIG.todo;
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    const status = fromSelect(f['状态']);
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['事项'] || '', note: f['备注'] || '',
      date: fromDate(f['日期']),
      priority: fromSelect(f['优先级'])?.startsWith('高') ? '高' : fromSelect(f['优先级'])?.startsWith('中') ? '中' : '低',
      done: status === '已完成',
      category: fromSelect(f['分类']) || '',
      updated_at: Date.now(),
    };
  });
}

async function pullWeekly() {
  const cfg = TABLE_CONFIG.weeklylearn;
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
  const cfg = TABLE_CONFIG.content;
  if (!cfg?.baseToken) return [];
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
    if (!tcfg?.baseToken) continue;
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
  const cfg = TABLE_CONFIG.diary;
  if (!cfg?.baseToken) return [];
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
  const cfg = TABLE_CONFIG.money;
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    const typeRaw = fromSelect(f['收支类型']);
    const type = typeRaw === '收入' ? 'income' : typeRaw === '往来' ? 'transfer' : 'expense';
    const bigCategory = fromSelect(f['支出用途大分类']) || '';
    const smallCategory = fromSelect(f['支出用途类别小分类']) || '';
    const incomeCategory = fromSelect(f['收入分类']) || '';
    const transferCategory = fromSelect(f['往来分类']) || '';
    let title = type === 'expense' ? (smallCategory || bigCategory || '支出') : type === 'income' ? (incomeCategory || '收入') : (transferCategory || '往来');
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
  const cfg = TABLE_CONFIG.period;
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
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg?.baseToken) return [];
  const records = await fetchAllRecords(cfg.baseToken, cfg.tableId);
  return records.map(r => {
    const f = r.fields || {};
    // 「打卡记录」字段在飞书里是文本（JSON 字符串），需要解析为对象
    let log = {};
    const rawLog = f['打卡记录'];
    if (rawLog) {
      if (typeof rawLog === 'object') log = rawLog;
      else { try { log = JSON.parse(rawLog); } catch (e) { log = {}; } }
    }
    return {
      id: r.record_id, record_id: r.record_id,
      title: f['习惯名称'] || '',
      log,
      autoCheck: fromSelect(f['自动关联模块']) || '',
      updated_at: Date.now(),
    };
  });
}

const pullers = { todo: pullTodo, weeklylearn: pullWeekly, content: pullContent, quickshop: pullQuickshop, diary: pullDiary, money: pullMoney, period: pullPeriod, checkin: pullCheckin };

// ========== 推送逻辑（8个模块）==========
async function pushTodo(records) {
  const cfg = TABLE_CONFIG.todo;
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
  return { created: cr.record_ids.length, updated: up.count };
}

async function pushWeekly(records) {
  const cfg = TABLE_CONFIG.weeklylearn;
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
  return { created: cr.record_ids.length, updated: up.count };
}

async function pushContent(records) {
  const cfg = TABLE_CONFIG.content;
  if (!cfg?.baseToken) return { created: 0, updated: 0 };
  const stageMap = { '选题池': '灵感池', '文案中': '已写文案', '待拍摄': '待制作', '已发布': '已发布' };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '选题简述': rec.title || '', '状态': toSelect(stageMap[rec.stage] || rec.stage || '灵感池'),
    '优先级': toSelect(rec.priority),
    '目标平台': toMultiSelect(Array.isArray(rec.platform) ? rec.platform : [rec.platform].filter(Boolean)),
    '备注': rec.content || '',
    '计划发布日': toDate(rec.deadline || rec.date),
    '封面图': toAttachment(rec.photo),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count };
}

async function pushQuickshop(records) {
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
  return { created, updated };
}

async function pushDiary(records) {
  const cfg = TABLE_CONFIG.diary;
  if (!cfg?.baseToken) return { created: 0, updated: 0 };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '标题': rec.title || '', '内容': rec.content || '',
    '分类': toSelect(rec.mood || '灵感'), '日期': toDate(rec.date),
    '照片': toAttachment(rec.photo),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count };
}

async function pushMoney(records) {
  const cfg = TABLE_CONFIG.money;
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
  return { created: cr.record_ids.length, updated: up.count };
}

async function pushPeriod(records) {
  const cfg = TABLE_CONFIG.period;
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
  return { created: cr.record_ids.length, updated: up.count };
}

async function pushCheckin(records) {
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg?.baseToken) return { created: 0, updated: 0 };
  const { createBatch, updateBatch } = splitRecords(records, rec => ({
    '习惯名称': rec.title || '',
    '打卡记录': rec.log ? JSON.stringify(rec.log) : '',
    '自动关联模块': toSelect(rec.autoCheck || ''),
  }));
  const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
  const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  assignRecordIds(records, cr.record_ids);
  return { created: cr.record_ids.length, updated: up.count };
}

const pushers = { todo: pushTodo, weeklylearn: pushWeekly, content: pushContent, quickshop: pushQuickshop, diary: pushDiary, money: pushMoney, period: pushPeriod, checkin: pushCheckin };

// ========== HTTP 服务器 ==========
const PORT = 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// 读取原始二进制请求体（文件上传用）
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 简单的 multipart 解析器（与 netlify/functions/sync-upload.js 相同逻辑）
function parseMultipart(buffer, boundary) {
  const parts = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const endDelimiter = Buffer.from(`--${boundary}--`);
  let start = 0;
  while (true) {
    const nextStart = buffer.indexOf(delimiter, start);
    if (nextStart === -1) break;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), nextStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(nextStart + delimiter.length + 2, headerEnd).toString();
    const nextBoundary = buffer.indexOf(delimiter, headerEnd + 4);
    const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : buffer.length;
    const data = buffer.slice(headerEnd + 4, dataEnd);
    const dispositionMatch = headers.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/);
    const typeMatch = headers.match(/Content-Type: ([^\r\n]+)/);
    if (dispositionMatch) {
      parts.push({
        name: dispositionMatch[1],
        filename: dispositionMatch[2] || null,
        contentType: typeMatch ? typeMatch[1].trim() : null,
        data,
      });
    }
    start = nextBoundary;
    if (buffer.indexOf(endDelimiter, start) === start) break;
  }
  return parts;
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ===== API 接口 =====

  // ========== OAuth 用户授权流程 ==========

  // 授权状态检查
  if (urlPath === '/api/auth/status') {
    const cache = loadTokenCache();
    if (cache && cache.access_token && cache.expires_at > Date.now()) {
      sendJSON(res, 200, { ok: true, authorized: true, expires_at: cache.expires_at });
    } else if (cache && cache.refresh_token) {
      sendJSON(res, 200, { ok: true, authorized: true, expires_at: cache.expires_at });
    } else {
      sendJSON(res, 200, { ok: true, authorized: false });
    }
    return;
  }

  // 发起授权：重定向到飞书授权页
  if (urlPath === '/api/auth/login') {
    const state = Date.now().toString(36);
    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/index?app_id=${encodeURIComponent(FEISHU_APP_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  // 授权回调：接收 code，换取 token
  const callbackUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (urlPath === '/api/auth/callback') {
    const code = callbackUrl.searchParams.get('code');
    if (!code) {
      sendJSON(res, 400, { ok: false, error: '缺少授权码 code' });
      return;
    }
    try {
      console.log('[AUTH] 收到授权码，正在换取 token...');
      // v1 流程：先拿 app_access_token，再用它换取 user_access_token
      const appToken = await getAppAccessToken();
      const tokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${appToken}` },
        body: JSON.stringify({ grant_type: 'authorization_code', code }),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.code !== 0) {
        sendJSON(res, 500, { ok: false, error: `换取 token 失败: ${tokenData.msg || JSON.stringify(tokenData)}` });
        return;
      }
      const cache = {
        access_token: tokenData.data.access_token,
        refresh_token: tokenData.data.refresh_token,
        expires_at: Date.now() + (tokenData.data.expires_in || 7200) * 1000,
      };
      saveTokenCache(cache);
      console.log('[AUTH] 授权成功！token 已缓存');
      // 返回一个简单的成功页面
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>飞书授权成功</h2><p>可以关闭此页面，回到工作台继续操作</p><script>setTimeout(()=>window.close(),3000)</script></body></html>');
    } catch (e) {
      console.error('[AUTH] 回调失败:', e);
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 测试连通性
  if (urlPath === '/api/sync/test') {
    try {
      const records = await pullTodo();
      sendJSON(res, 200, { ok: true, message: '飞书连接正常', count: records.length });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 从飞书拉取数据
  const pullMatch = urlPath.match(/^\/api\/sync\/pull\/(.+)$/);
  if (pullMatch && req.method === 'GET') {
    const module = pullMatch[1];
    const puller = pullers[module];
    if (!puller) {
      sendJSON(res, 400, { ok: false, error: `不支持的模块: ${module}` });
      return;
    }
    try {
      console.log(`[SYNC] Pulling ${module} from Feishu...`);
      const records = await puller();
      console.log(`[SYNC] Pulled ${records.length} records from ${module}`);
      sendJSON(res, 200, { ok: true, records });
    } catch (e) {
      console.error(`[SYNC] Pull error:`, e);
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 推送数据到飞书
  const pushMatch = urlPath.match(/^\/api\/sync\/push\/(.+)$/);
  if (pushMatch && req.method === 'POST') {
    const module = pushMatch[1];
    const pusher = pushers[module];
    if (!pusher) {
      sendJSON(res, 400, { ok: false, error: `不支持的模块: ${module}` });
      return;
    }
    try {
      const body = await readBody(req);
      console.log(`[SYNC] Pushing ${body.records?.length || 0} records to ${module}...`);
      const result = await pusher(body.records || []);
      console.log(`[SYNC] Push done: created=${result.created}, updated=${result.updated}`);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error(`[SYNC] Push error:`, e);
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 全量双向同步
  const syncMatch = urlPath.match(/^\/api\/sync\/full\/(.+)$/);
  if (syncMatch && req.method === 'POST') {
    const module = syncMatch[1];
    const puller = pullers[module];
    const pusher = pushers[module];
    if (!puller || !pusher) {
      sendJSON(res, 400, { ok: false, error: `不支持的模块: ${module}` });
      return;
    }
    try {
      const body = await readBody(req);
      const localRecords = body.records || [];
      console.log(`[SYNC] Full sync for ${module}, local=${localRecords.length}`);

      // 1. 拉取飞书数据
      const feishuRecords = await puller();
      console.log(`[SYNC] Feishu has ${feishuRecords.length} records`);

      // 2. 构建飞书记录索引
      const feishuMap = {};
      for (const r of feishuRecords) {
        feishuMap[r.record_id] = r;
      }

      // 3. 本地记录按 record_id 分类
      const toCreate = [];
      const toUpdate = [];
      const localRecordIds = new Set();

      for (const local of localRecords) {
        if (local.record_id && feishuMap[local.record_id]) {
          localRecordIds.add(local.record_id);
          toUpdate.push(local);
        } else if (local.record_id) {
          localRecordIds.add(local.record_id);
        } else {
          toCreate.push(local);
        }
      }

      // 4. 飞书有但本地没有的记录，返回给前端让它加进去
      const toAddLocal = feishuRecords.filter(r => !localRecordIds.has(r.record_id));

      console.log(`[SYNC] toCreate=${toCreate.length}, toUpdate=${toUpdate.length}, toAddLocal=${toAddLocal.length}`);

      // 5. 推送新增和更新到飞书
      let created = 0, updated = 0;
      if (toCreate.length + toUpdate.length > 0) {
        const allToPush = [...toCreate, ...toUpdate];
        const result = await pusher(allToPush);
        created = result.created;
        updated = result.updated;
      }

      // 6. 返回同步结果
      const pushedRecordMap = {};
      const allPushed = [...toCreate, ...toUpdate];
      for (const r of allPushed) {
        if (r.record_id) pushedRecordMap[r.id] = r.record_id;
      }

      sendJSON(res, 200, {
        ok: true,
        created,
        updated,
        toAddLocal,
        pushedRecordMap,
      });
    } catch (e) {
      console.error(`[SYNC] Full sync error:`, e);
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ===== 文件上传（图片/附件 → 飞书多维表格附件字段）=====
  if (urlPath === '/api/sync/upload' && req.method === 'POST') {
    try {
      const boundary = req.headers['content-type']?.split('boundary=')[1];
      if (!boundary) { sendJSON(res, 400, { ok: false, error: '缺少 boundary' }); return; }

      const raw = await readRawBody(req);
      const parts = parseMultipart(raw, boundary);
      const filePart = parts.find(p => p.filename);
      if (!filePart) { sendJSON(res, 400, { ok: false, error: '未找到文件' }); return; }

      let meta = {};
      const metaPart = parts.find(p => p.name === 'metadata');
      if (metaPart) { try { meta = JSON.parse(metaPart.data.toString()); } catch (e) {} }

      // 优先用 module(+mood) 从服务端配置解析 baseToken
      let baseToken = meta.baseToken;
      if (!baseToken && meta.module) {
        if (meta.module === 'quickshop' && meta.mood) {
          baseToken = TABLE_CONFIG.quickshop?.moodToTable?.[meta.mood]?.baseToken;
        } else {
          baseToken = TABLE_CONFIG[meta.module]?.baseToken;
        }
      }
      if (!baseToken) { sendJSON(res, 400, { ok: false, error: `无法确定目标表格（module=${meta.module || '未传'}）` }); return; }

      console.log(`[UPLOAD] ${filePart.filename} (${filePart.data.length}B) → ${meta.module || '?'}${meta.mood ? '/' + meta.mood : ''}`);
      const token = await getTenantAccessToken();
      const formData = new FormData();
      formData.append('file', new Blob([filePart.data], { type: filePart.contentType || 'application/octet-stream' }), filePart.filename);
      formData.append('file_name', filePart.filename);
      formData.append('parent_type', 'bitable_file');
      formData.append('parent_node', baseToken);

      const uploadRes = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (uploadData.code !== 0) {
        sendJSON(res, 500, { ok: false, error: `飞书上传失败: ${uploadData.msg}` });
        return;
      }
      sendJSON(res, 200, { ok: true, file_token: uploadData.data?.file_token, name: filePart.filename });
    } catch (e) {
      console.error('[UPLOAD] error:', e);
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ===== 静态文件 =====

  // 禁止通过 HTTP 访问敏感文件（密钥配置）
  const BLOCKED_FILES = ['sync-config.js', 'sync-config.example.js'];
  if (BLOCKED_FILES.includes(path.basename(urlPath))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 该文件包含敏感配置，禁止访问');
    return;
  }

  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  喜姿姿工作台 本地服务器已启动');
  console.log('========================================');
  console.log('  本地访问: http://localhost:' + PORT);
  console.log('  桌面版: http://localhost:' + PORT + '/workbench-desktop.html');
  console.log('  手机版: http://localhost:' + PORT + '/workbench-mobile.html');
  console.log('  飞书同步: 已启用（直连飞书API）');
  console.log('========================================');
  console.log('  按 Ctrl+C 停止服务器');
  console.log('========================================');
});
