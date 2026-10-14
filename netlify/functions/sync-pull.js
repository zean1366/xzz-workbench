// 从飞书拉取数据（Netlify Function）
const {
  TABLE_CONFIG, fetchAllRecords,
  fromSelect, fromMultiSelect, fromDate, fromAttachment,
  jsonResponse
} = require('./sync-common.js');

// ========== 1. 每日待办 ==========
function pullTodo() {
  const cfg = TABLE_CONFIG.todo;
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      const status = fromSelect(f['状态']);
      const done = status === '已完成';
      const priorityRaw = fromSelect(f['优先级']);
      let priority = '低';
      if (priorityRaw && priorityRaw.startsWith('高')) priority = '高';
      else if (priorityRaw && priorityRaw.startsWith('中')) priority = '中';

      return {
        id: r.record_id,
        record_id: r.record_id,
        title: f['事项'] || '',
        note: f['备注'] || '',
        date: fromDate(f['日期']),
        priority,
        done,
        category: fromSelect(f['分类']) || '',
        updated_at: Date.now(),
      };
    })
  }));
}

// ========== 2. 一周主题 ==========
function pullWeekly() {
  const cfg = TABLE_CONFIG.weeklylearn;
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      return {
        id: r.record_id,
        record_id: r.record_id,
        title: f['重点内容'] || '',
        category: fromSelect(f['分类']) || '',
        priority: fromSelect(f['优先级']) || '',
        goalType: fromSelect(f['目标类型']) || '',
        stage: fromSelect(f['进展阶段']) || '未开始',
        note: f['备注'] || '',
        startDate: fromDate(f['开始日期']),
        endDate: fromDate(f['结束日期']),
        quantifiedTarget: f['量化目标'] || 0,
        week: f['周次'] || '',
        updated_at: Date.now(),
      };
    })
  }));
}

// ========== 3. 内容生产 ==========
// 飞书「状态」与工作台「阶段」的双向映射（保持飞书选项整洁，不新建选项）
const CONTENT_STAGE_FROM_FEISHU = {
  '灵感池': '选题池', '待评估': '选题池',
  '已写文案': '文案中',
  '待制作': '待拍摄', '制作中': '待拍摄', '已剪辑': '待拍摄',
  '已发布': '已发布',
};
function pullContent() {
  const cfg = TABLE_CONFIG.content;
  if (!cfg || !cfg.baseToken) {
    return Promise.resolve({ ok: true, records: [] });
  }
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      const rawStage = fromSelect(f['状态']) || '';
      return {
        id: r.record_id,
        record_id: r.record_id,
        title: f['选题简述'] || f['选题标题'] || '',
        stage: CONTENT_STAGE_FROM_FEISHU[rawStage] || rawStage || '选题池',
        platform: fromMultiSelect(f['目标平台']) || [],
        priority: fromSelect(f['优先级']) || '中',
        content: f['备注'] || '',
        date: fromDate(f['发布日期']) || fromDate(f['计划发布日']),
        deadline: fromDate(f['计划发布日']),
        photo: fromAttachment(f['封面图']),
        updated_at: Date.now(),
      };
    })
  }));
}

// ========== 4. 门店随手记（6张表）==========
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
    if (!tcfg || !tcfg.baseToken) continue;
    try {
      const records = await fetchAllRecords(tcfg.baseToken, tcfg.tableId);
      const fieldMap = fieldMaps[mood];

      for (const r of records) {
        const f = r.fields || {};
        const rec = {
          id: r.record_id,
          record_id: r.record_id,
          mood,
          updated_at: Date.now(),
        };

        for (const [localField, feishuField] of Object.entries(fieldMap)) {
          if (!feishuField) continue;
          const val = f[feishuField];
          if (['project', 'gift', 'giftProject', 'category'].includes(localField)) {
            rec[localField] = fromMultiSelect(val) || [];
          } else if (['amount', 'principal', 'giftAmount', 'sessionNum'].includes(localField)) {
            rec[localField] = val || 0;
          } else if (['payMethod', 'firstTime', 'level', 'status', 'type'].includes(localField)) {
            rec[localField] = fromSelect(val) || '';
          } else if (['date', 'startDate', 'endDate'].includes(localField)) {
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

  return { ok: true, records: allRecords };
}

// ========== 5. 碎片日记 ==========
function pullDiary() {
  const cfg = TABLE_CONFIG.diary;
  if (!cfg || !cfg.baseToken) {
    return Promise.resolve({ ok: true, records: [] });
  }
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      return {
        id: r.record_id,
        record_id: r.record_id,
        title: f['标题'] || '',
        content: f['内容'] || '',
        mood: fromSelect(f['分类']) || '灵感',
        date: fromDate(f['日期']),
        photo: fromAttachment(f['照片']),
        updated_at: Date.now(),
      };
    })
  }));
}

// ========== 6. 生活收支 ==========
function pullMoney() {
  const cfg = TABLE_CONFIG.money;
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      const typeRaw = fromSelect(f['收支类型']);
      let type = 'expense';
      if (typeRaw === '收入') type = 'income';
      else if (typeRaw === '往来') type = 'transfer';

      const bigCategory = fromSelect(f['支出用途大分类']) || '';
      const smallCategory = fromSelect(f['支出用途类别小分类']) || '';
      const incomeCategory = fromSelect(f['收入分类']) || '';
      const transferCategory = fromSelect(f['往来分类']) || '';

      let title = '';
      if (type === 'expense') title = smallCategory || bigCategory || '支出';
      else if (type === 'income') title = incomeCategory || '收入';
      else title = transferCategory || '往来';

      return {
        id: r.record_id,
        record_id: r.record_id,
        title, type,
        amount: f['金额'] || 0,
        bigCategory, smallCategory, incomeCategory, transferCategory,
        payMethod: fromSelect(f['支付方式']) || '',
        date: fromDate(f['日期']),
        note: f['备注'] || '',
        updated_at: Date.now(),
      };
    })
  }));
}

// ========== 7. 例假记录 ==========
function pullPeriod() {
  const cfg = TABLE_CONFIG.period;
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      return {
        id: r.record_id,
        record_id: r.record_id,
        startDate: fromDate(f['开始日期']),
        endDate: fromDate(f['结束日期']),
        status: fromSelect(f['状态']) || '经期中',
        flowAmount: fromSelect(f['经量']) || '',
        painLevel: fromSelect(f['痛经']) || '',
        color: fromSelect(f['颜色']) || '',
        texture: fromSelect(f['质地']) || '',
        symptoms: fromMultiSelect(f['身体症状']) || [],
        emotions: fromMultiSelect(f['情绪']) || [],
        note: f['备注'] || '',
        updated_at: Date.now(),
      };
    })
  }));
}

// ========== 8. 习惯打卡 ==========
function pullCheckin() {
  const cfg = TABLE_CONFIG.checkin;
  if (!cfg || !cfg.baseToken) {
    return Promise.resolve({ ok: true, records: [] });
  }
  return fetchAllRecords(cfg.baseToken, cfg.tableId).then(records => ({
    ok: true,
    records: records.map(r => {
      const f = r.fields || {};
      // 「打卡记录」字段在飞书里是文本（JSON 字符串），需要解析为对象
      let log = {};
      const rawLog = f['打卡记录'];
      if (rawLog) {
        if (typeof rawLog === 'object') log = rawLog;
        else { try { log = JSON.parse(rawLog); } catch (e) { log = {}; } }
      }
      return {
        id: r.record_id,
        record_id: r.record_id,
        title: f['习惯名称'] || '',
        log,
        autoCheck: fromSelect(f['自动关联模块']) || '',
        updated_at: Date.now(),
      };
    })
  }));
}

const pullers = {
  todo: pullTodo,
  weeklylearn: pullWeekly,
  content: pullContent,
  quickshop: pullQuickshop,
  diary: pullDiary,
  money: pullMoney,
  period: pullPeriod,
  checkin: pullCheckin,
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  try {
    const module = event.path.split('/').pop();
    const fn = pullers[module];

    if (!fn) {
      return jsonResponse(400, { ok: false, error: `不支持的模块: ${module}` });
    }

    const result = await fn();
    return jsonResponse(200, result);
  } catch (e) {
    console.error('Pull error:', e);
    return jsonResponse(500, { ok: false, error: e.message });
  }
};
