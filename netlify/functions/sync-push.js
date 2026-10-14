// 推送数据到飞书（Netlify Function）
const {
  TABLE_CONFIG, batchCreate, batchUpdate, createRecord, updateRecord, deleteRecord,
  toSelect, toMultiSelect, toDate, toAttachment,
  splitRecords, assignRecordIds,
  jsonResponse
} = require('./sync-common.js');

// ========== 1. 每日待办 ==========
async function pushTodo(localRecords) {
  const cfg = TABLE_CONFIG.todo;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => ({
    '事项': rec.title || '',
    '备注': rec.note || '',
    '日期': toDate(rec.date),
    '优先级': toSelect(rec.priority === '高' ? '高（今天必须做）' :
                       rec.priority === '中' ? '中（尽量今天做）' : '低（有空再说）'),
    '状态': toSelect(rec.done ? '已完成' : '待办'),
    '分类': toSelect(rec.category || '其他'),
  }));

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 2. 一周主题 ==========
async function pushWeekly(localRecords) {
  const cfg = TABLE_CONFIG.weeklylearn;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => ({
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

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 3. 内容生产 ==========
// 工作台「阶段」→ 飞书「状态」映射（用飞书已有选项，避免自动新建选项污染表）
const CONTENT_STAGE_TO_FEISHU = {
  '选题池': '灵感池',
  '文案中': '已写文案',
  '待拍摄': '待制作',
  '已发布': '已发布',
};
async function pushContent(localRecords) {
  const cfg = TABLE_CONFIG.content;
  if (!cfg || !cfg.baseToken) {
    return { ok: true, created: 0, updated: 0, errors: [], records: localRecords };
  }
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => ({
    '选题简述': rec.title || '',
    '状态': toSelect(CONTENT_STAGE_TO_FEISHU[rec.stage] || rec.stage || '灵感池'),
    '优先级': toSelect(rec.priority),
    '目标平台': toMultiSelect(Array.isArray(rec.platform) ? rec.platform : [rec.platform].filter(Boolean)),
    '备注': rec.content || '',
    '计划发布日': toDate(rec.deadline || rec.date),
    '封面图': toAttachment(rec.photo),
  }));

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 4. 门店随手记（6张表）==========
async function pushQuickshop(localRecords) {
  const results = { created: 0, updated: 0, errors: [] };
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

    const { createBatch, updateBatch } = splitRecords(recs, rec => {
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
        } else if (localField === 'photo') {
          if (val && val.length) fields[feishuField] = toAttachment(val);
        } else {
          if (val != null) fields[feishuField] = val;
        }
      }
      return fields;
    });

    try {
      const up = await batchUpdate(tcfg.baseToken, tcfg.tableId, updateBatch);
      results.updated += up.count;
    } catch (e) {
      results.errors.push({ mood, step: 'update', error: e.message });
    }

    try {
      const cr = await batchCreate(tcfg.baseToken, tcfg.tableId, createBatch);
      results.created += cr.record_ids.length;
      assignRecordIds(recs, cr.record_ids);
    } catch (e) {
      results.errors.push({ mood, step: 'create', error: e.message });
    }
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 5. 碎片日记 ==========
async function pushDiary(localRecords) {
  const cfg = TABLE_CONFIG.diary;
  if (!cfg || !cfg.baseToken) {
    return { ok: true, created: 0, updated: 0, errors: [], records: localRecords };
  }
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => ({
    '标题': rec.title || '',
    '内容': rec.content || '',
    '分类': toSelect(rec.mood || '灵感'),
    '日期': toDate(rec.date),
    '照片': toAttachment(rec.photo),
  }));

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 6. 生活收支 ==========
async function pushMoney(localRecords) {
  const cfg = TABLE_CONFIG.money;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => {
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

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 7. 例假记录 ==========
async function pushPeriod(localRecords) {
  const cfg = TABLE_CONFIG.period;
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => ({
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

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

// ========== 8. 习惯打卡 ==========
async function pushCheckin(localRecords) {
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg || !cfg.baseToken) {
    return { ok: true, created: 0, updated: 0, errors: [], records: localRecords };
  }
  const results = { created: 0, updated: 0, errors: [] };

  const { createBatch, updateBatch } = splitRecords(localRecords, rec => ({
    '习惯名称': rec.title || '',
    '打卡记录': rec.log ? JSON.stringify(rec.log) : '',
    '自动关联模块': toSelect(rec.autoCheck || ''),
  }));

  try {
    const up = await batchUpdate(cfg.baseToken, cfg.tableId, updateBatch);
    results.updated = up.count;
  } catch (e) {
    results.errors.push({ step: 'update', error: e.message });
  }

  try {
    const cr = await batchCreate(cfg.baseToken, cfg.tableId, createBatch);
    results.created = cr.record_ids.length;
    assignRecordIds(localRecords, cr.record_ids);
  } catch (e) {
    results.errors.push({ step: 'create', error: e.message });
  }

  return { ok: true, ...results, records: localRecords };
}

const pushers = {
  todo: pushTodo,
  weeklylearn: pushWeekly,
  content: pushContent,
  quickshop: pushQuickshop,
  diary: pushDiary,
  money: pushMoney,
  period: pushPeriod,
  checkin: pushCheckin,
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  try {
    const module = event.path.split('/').pop();
    const fn = pushers[module];

    if (!fn) {
      return jsonResponse(400, { ok: false, error: `不支持的模块: ${module}` });
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return jsonResponse(400, { ok: false, error: '请求体格式错误' });
    }

    const localRecords = body.records || [];
    const result = await fn(localRecords);
    return jsonResponse(200, result);
  } catch (e) {
    console.error('Push error:', e);
    return jsonResponse(500, { ok: false, error: e.message });
  }
};
