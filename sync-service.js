// 飞书同步服务
// 通过 lark-cli 调用飞书 API
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CONFIG = require('./sync-config.js');

let _tmpCounter = 0;

// Windows 下单引号传 JSON 会出错，用临时文件方式传递
function jsonTempFile(obj) {
  _tmpCounter++;
  const tmpFile = path.join(os.tmpdir(), `lark-sync-${process.pid}-${_tmpCounter}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(obj), 'utf8');
  return tmpFile;
}

function runLark(args) {
  try {
    const cmd = `lark-cli ${args} --as user --format json`;
    const result = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(result);
  } catch (e) {
    console.error('lark-cli error:', e.message);
    try {
      const stderr = e.stderr ? e.stderr.toString() : '';
      return { ok: false, error: stderr || e.message };
    } catch {
      return { ok: false, error: e.message };
    }
  }
}

// 带 JSON 参数的命令（用 @file 方式传，避免 Windows 引号问题）
function runLarkWithJson(argsBefore, jsonObj, argsAfter = '') {
  const tmpFile = jsonTempFile(jsonObj);
  try {
    const cmd = `lark-cli ${argsBefore} --json @${tmpFile} ${argsAfter} --as user --format json`;
    const result = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(result);
  } catch (e) {
    console.error('lark-cli error:', e.message);
    try {
      const stderr = e.stderr ? e.stderr.toString() : '';
      return { ok: false, error: stderr || e.message };
    } catch {
      return { ok: false, error: e.message };
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ========== 通用：从矩阵格式解析记录 ==========
function parseMatrix(result) {
  if (!result.ok) return result;
  const d = result.data;
  const fields = d.fields || [];
  const recordIds = d.record_id_list || [];
  const rows = d.data || [];

  const records = rows.map((row, i) => {
    const obj = { record_id: recordIds[i] || '' };
    for (let j = 0; j < fields.length; j++) {
      obj[fields[j]] = row[j];
    }
    return obj;
  });

  return { ok: true, records, fields };
}

// 拉取一张表的所有记录（自动分页）
function fetchAllRecords(baseToken, tableId) {
  let allRecords = [];
  let offset = 0;
  const pageSize = 200;

  while (true) {
    const result = runLark(
      `base +record-list --base-token ${baseToken} --table-id ${tableId} --limit ${pageSize} --offset ${offset}`
    );
    if (!result.ok) return { ok: false, error: result.error };

    const parsed = parseMatrix(result);
    if (!parsed.ok) return parsed;

    allRecords = allRecords.concat(parsed.records);

    if (!result.data.has_more || parsed.records.length < pageSize) break;
    offset += pageSize;
  }

  return { ok: true, records: allRecords };
}

// ========== 通用字段转换 ==========
function toSelect(val) { if (!val) return []; return [val]; }
function fromSelect(arr) { if (!arr || !arr.length) return ''; return arr[0]; }
function toMultiSelect(arr) { if (!arr || !arr.length) return []; return arr; }
function fromMultiSelect(arr) { if (!arr) return []; return arr; }
function toDate(iso) { if (!iso) return null; return `${iso}T00:00:00+08:00`; }
function fromDate(dt) { if (!dt) return ''; return dt.slice(0, 10); }

// ========== 通用：批量创建/更新 ==========
function batchUpdate(baseToken, tableId, updateMap) {
  if (Object.keys(updateMap).length === 0) return { ok: true, count: 0 };
  const r = runLarkWithJson(
    `base +record-batch-update --base-token ${baseToken} --table-id ${tableId}`,
    { update_records: updateMap }
  );
  if (r.ok) return { ok: true, count: Object.keys(updateMap).length };
  return { ok: false, error: r.error?.message || r.error || 'update failed' };
}

function batchCreate(baseToken, tableId, createBatch) {
  if (createBatch.length === 0) return { ok: true, ids: [] };
  const r = runLarkWithJson(
    `base +record-batch-create --base-token ${baseToken} --table-id ${tableId}`,
    { create_records: createBatch }
  );
  if (r.ok && r.data && r.data.record_id_list) {
    return { ok: true, ids: r.data.record_id_list };
  }
  return { ok: false, error: r.error?.message || r.error || 'create failed' };
}

// 分类本地记录为"需要更新"和"需要创建"
function splitRecords(localRecords, buildFieldsFn) {
  const createBatch = [];
  const updateMap = {};
  for (const rec of localRecords) {
    const fields = buildFieldsFn(rec);
    if (rec.record_id) {
      updateMap[rec.record_id] = fields;
    } else {
      createBatch.push(fields);
    }
  }
  return { createBatch, updateMap };
}

// 回填 record_id 到本地新建的记录
function assignRecordIds(localRecords, ids) {
  let idx = 0;
  for (const rec of localRecords) {
    if (!rec.record_id && idx < ids.length) {
      rec.record_id = ids[idx];
      idx++;
    }
  }
}

// ========== 每日待办 ==========
function pullTodo() {
  const cfg = CONFIG.todo;
  const result = fetchAllRecords(cfg.baseToken, cfg.tableId);
  if (!result.ok) return result;

  const records = result.records.map(r => {
    const status = fromSelect(r['状态']);
    const done = status === '已完成';
    const priorityRaw = fromSelect(r['优先级']);
    let priority = '低';
    if (priorityRaw && priorityRaw.startsWith('高')) priority = '高';
    else if (priorityRaw && priorityRaw.startsWith('中')) priority = '中';

    return {
      id: r.record_id,
      record_id: r.record_id,
      title: r['事项'] || '',
      note: r['备注'] || '',
      date: fromDate(r['日期']),
      priority: priority,
      done: done,
      category: fromSelect(r['分类']) || '',
      updated_at: Date.now(),
    };
  });

  return { ok: true, records };
}

function pushTodo(localRecords) {
  const cfg = CONFIG.todo;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateMap } = splitRecords(localRecords, rec => ({
    '事项': rec.title || '',
    '备注': rec.note || '',
    '日期': toDate(rec.date),
    '优先级': toSelect(rec.priority === '高' ? '高（今天必须做）' :
                       rec.priority === '中' ? '中（尽量今天做）' : '低（有空再说）'),
    '状态': toSelect(rec.done ? '已完成' : '待办'),
  }));

  const up = batchUpdate(cfg.baseToken, cfg.tableId, updateMap);
  if (up.ok) results.updated = up.count;
  else results.errors.push({ step: 'update', error: up.error });

  const cr = batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  if (cr.ok) {
    results.created = cr.ids.length;
    assignRecordIds(localRecords, cr.ids);
  } else {
    results.errors.push({ step: 'create', error: cr.error });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 一周主题 ==========
function pullWeekly() {
  const cfg = CONFIG.weeklylearn;
  const result = fetchAllRecords(cfg.baseToken, cfg.tableId);
  if (!result.ok) return result;

  const records = result.records.map(r => ({
    id: r.record_id,
    record_id: r.record_id,
    title: r['重点内容'] || '',
    category: fromSelect(r['分类']) || '',
    priority: fromSelect(r['优先级']) || '',
    goalType: fromSelect(r['目标类型']) || '',
    stage: fromSelect(r['进展阶段']) || '未开始',
    note: r['备注'] || '',
    startDate: fromDate(r['开始日期']),
    endDate: fromDate(r['结束日期']),
    quantifiedTarget: r['量化目标'] || 0,
    week: r['周次'] || '',
    updated_at: Date.now(),
  }));

  return { ok: true, records };
}

function pushWeekly(localRecords) {
  const cfg = CONFIG.weeklylearn;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateMap } = splitRecords(localRecords, rec => ({
    '重点内容': rec.title || '',
    '分类': toSelect(rec.category),
    '优先级': toSelect(rec.priority),
    '目标类型': toSelect(rec.goalType),
    '进展阶段': toSelect(rec.stage || '未开始'),
    '备注': rec.note || '',
    '开始日期': toDate(rec.startDate),
    '结束日期': toDate(rec.endDate),
    '量化目标': rec.quantifiedTarget ? Number(rec.quantifiedTarget) : null,
    '周次': rec.week || '',
  }));

  const up = batchUpdate(cfg.baseToken, cfg.tableId, updateMap);
  if (up.ok) results.updated = up.count;
  else results.errors.push({ step: 'update', error: up.error });

  const cr = batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  if (cr.ok) {
    results.created = cr.ids.length;
    assignRecordIds(localRecords, cr.ids);
  } else {
    results.errors.push({ step: 'create', error: cr.error });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 生活收支 ==========
function pullMoney() {
  const cfg = CONFIG.money;
  const result = fetchAllRecords(cfg.baseToken, cfg.tableId);
  if (!result.ok) return result;

  const records = result.records.map(r => {
    const typeRaw = fromSelect(r['收支类型']);
    let type = 'expense';
    if (typeRaw === '收入') type = 'income';
    else if (typeRaw === '往来') type = 'transfer';

    const bigCategory = fromSelect(r['支出用途大分类']) || '';
    const smallCategory = fromSelect(r['支出用途类别小分类']) || '';
    const incomeCategory = fromSelect(r['收入分类']) || '';
    const transferCategory = fromSelect(r['往来分类']) || '';

    let title = '';
    if (type === 'expense') title = smallCategory || bigCategory || '支出';
    else if (type === 'income') title = incomeCategory || '收入';
    else title = transferCategory || '往来';

    return {
      id: r.record_id,
      record_id: r.record_id,
      title, type,
      amount: r['金额'] || 0,
      bigCategory, smallCategory, incomeCategory, transferCategory,
      payMethod: fromSelect(r['支付方式']) || '',
      date: fromDate(r['日期']),
      note: r['备注'] || '',
      updated_at: Date.now(),
    };
  });

  return { ok: true, records };
}

function pushMoney(localRecords) {
  const cfg = CONFIG.money;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateMap } = splitRecords(localRecords, rec => {
    let typeLabel = '支出';
    if (rec.type === 'income') typeLabel = '收入';
    else if (rec.type === 'transfer') typeLabel = '往来';

    const fields = {
      '日期': toDate(rec.date),
      '金额': Number(rec.amount) || 0,
      '收支类型': toSelect(typeLabel),
      '支付方式': toSelect(rec.payMethod),
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

  const up = batchUpdate(cfg.baseToken, cfg.tableId, updateMap);
  if (up.ok) results.updated = up.count;
  else results.errors.push({ step: 'update', error: up.error });

  const cr = batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  if (cr.ok) {
    results.created = cr.ids.length;
    assignRecordIds(localRecords, cr.ids);
  } else {
    results.errors.push({ step: 'create', error: cr.error });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 例假记录 ==========
function pullPeriod() {
  const cfg = CONFIG.period;
  const result = fetchAllRecords(cfg.baseToken, cfg.tableId);
  if (!result.ok) return result;

  const records = result.records.map(r => ({
    id: r.record_id,
    record_id: r.record_id,
    startDate: fromDate(r['开始日期']),
    endDate: fromDate(r['结束日期']),
    status: fromSelect(r['状态']) || '经期中',
    flowAmount: fromSelect(r['经量']) || '',
    painLevel: fromSelect(r['痛经']) || '',
    color: fromSelect(r['颜色']) || '',
    texture: fromSelect(r['质地']) || '',
    symptoms: fromMultiSelect(r['身体症状']) || [],
    emotions: fromMultiSelect(r['情绪']) || [],
    note: r['备注'] || '',
    updated_at: Date.now(),
  }));

  return { ok: true, records };
}

function pushPeriod(localRecords) {
  const cfg = CONFIG.period;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateMap } = splitRecords(localRecords, rec => ({
    '开始日期': toDate(rec.startDate),
    '结束日期': toDate(rec.endDate),
    '状态': toSelect(rec.status || '经期中'),
    '经量': toSelect(rec.flowAmount),
    '痛经': toSelect(rec.painLevel),
    '颜色': toSelect(rec.color),
    '质地': toSelect(rec.texture),
    '身体症状': toMultiSelect(rec.symptoms || []),
    '情绪': toMultiSelect(rec.emotions || []),
    '备注': rec.note || '',
  }));

  const up = batchUpdate(cfg.baseToken, cfg.tableId, updateMap);
  if (up.ok) results.updated = up.count;
  else results.errors.push({ step: 'update', error: up.error });

  const cr = batchCreate(cfg.baseToken, cfg.tableId, createBatch);
  if (cr.ok) {
    results.created = cr.ids.length;
    assignRecordIds(localRecords, cr.ids);
  } else {
    results.errors.push({ step: 'create', error: cr.error });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 门店随手记（6张表）==========
function pullQuickshop() {
  const allRecords = [];
  const moodCfgs = CONFIG.quickshop.moodToTable;
  const fieldMaps = CONFIG.quickshop.fieldMaps;

  for (const [mood, tcfg] of Object.entries(moodCfgs)) {
    const result = fetchAllRecords(tcfg.baseToken, tcfg.tableId);
    if (!result.ok) continue;
    const fieldMap = fieldMaps[mood];

    for (const r of result.records) {
      const rec = {
        id: r.record_id,
        record_id: r.record_id,
        mood,
        updated_at: Date.now(),
      };

      for (const [localField, feishuField] of Object.entries(fieldMap)) {
        if (!feishuField) continue;
        const val = r[feishuField];
        if (['project', 'gift', 'giftProject', 'category'].includes(localField)) {
          rec[localField] = fromMultiSelect(val) || [];
        } else if (['amount', 'principal', 'giftAmount', 'sessionNum'].includes(localField)) {
          rec[localField] = val || 0;
        } else if (['payMethod', 'firstTime', 'level', 'status', 'type'].includes(localField)) {
          rec[localField] = fromSelect(val) || '';
        } else if (['date', 'startDate', 'endDate'].includes(localField)) {
          rec[localField] = fromDate(val);
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
  }

  return { ok: true, records: allRecords };
}

function pushQuickshop(localRecords) {
  const results = { created: 0, updated: 0, errors: [] };
  const moodCfgs = CONFIG.quickshop.moodToTable;
  const fieldMaps = CONFIG.quickshop.fieldMaps;

  // 按 mood 分组
  const byMood = {};
  for (const rec of localRecords) {
    const mood = rec.mood || '会员消费';
    if (!byMood[mood]) byMood[mood] = [];
    byMood[mood].push(rec);
  }

  for (const [mood, recs] of Object.entries(byMood)) {
    const tcfg = moodCfgs[mood];
    const fieldMap = fieldMaps[mood];
    if (!tcfg || !fieldMap) {
      results.errors.push({ mood, error: `未知类型: ${mood}` });
      continue;
    }

    const { createBatch, updateMap } = splitRecords(recs, rec => {
      const fields = {};
      for (const [localField, feishuField] of Object.entries(fieldMap)) {
        if (!feishuField) continue;
        const val = rec[localField];
        if (['project', 'gift', 'giftProject', 'category'].includes(localField)) {
          if (val && val.length) fields[feishuField] = toMultiSelect(val);
        } else if (['amount', 'principal', 'giftAmount', 'sessionNum'].includes(localField)) {
          if (val != null) fields[feishuField] = Number(val) || 0;
        } else if (['payMethod', 'firstTime', 'level', 'status', 'type'].includes(localField)) {
          if (val) fields[feishuField] = toSelect(val);
        } else if (['date', 'startDate', 'endDate'].includes(localField)) {
          if (val) fields[feishuField] = toDate(val);
        } else {
          if (val != null) fields[feishuField] = val;
        }
      }
      return fields;
    });

    const up = batchUpdate(tcfg.baseToken, tcfg.tableId, updateMap);
    if (up.ok) results.updated += up.count;
    else results.errors.push({ mood, step: 'update', error: up.error });

    const cr = batchCreate(tcfg.baseToken, tcfg.tableId, createBatch);
    if (cr.ok) {
      results.created += cr.ids.length;
      assignRecordIds(recs, cr.ids);
    } else {
      results.errors.push({ mood, step: 'create', error: cr.error });
    }
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 统一入口 ==========
const pullers = {
  todo: pullTodo,
  weeklylearn: pullWeekly,
  money: pullMoney,
  period: pullPeriod,
  quickshop: pullQuickshop,
};

const pushers = {
  todo: pushTodo,
  weeklylearn: pushWeekly,
  money: pushMoney,
  period: pushPeriod,
  quickshop: pushQuickshop,
};

function pull(module) {
  const fn = pullers[module];
  if (!fn) return { ok: false, error: `不支持的模块: ${module}` };
  try { return fn(); }
  catch (e) { console.error(`Pull ${module} error:`, e); return { ok: false, error: e.message }; }
}

function push(module, records) {
  const fn = pushers[module];
  if (!fn) return { ok: false, error: `不支持的模块: ${module}` };
  try { return fn(records); }
  catch (e) { console.error(`Push ${module} error:`, e); return { ok: false, error: e.message }; }
}

module.exports = { pull, push };
