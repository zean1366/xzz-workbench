// 飞书同步公共工具（Netlify Functions 版本）
// 直接调用飞书开放平台 API，不依赖 lark-cli

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

// 各模块的飞书表配置（与 sync-config.js 保持一致）
const TABLE_CONFIG = {
  todo: {
    baseToken: '***REMOVED***',
    tableId: 'tblk9ZmG5gZ6GzAp',
  },
  weeklylearn: {
    baseToken: '***REMOVED***',
    tableId: 'tblmOCrN9uBGg6j6',
  },
  money: {
    baseToken: '***REMOVED***',
    tableId: 'tbll92KhuL7rv0Ei',
  },
  period: {
    baseToken: '***REMOVED***',
    tableId: 'tbl0Zeqld4vYxGLw',
  },
  quickshop: {
    moodToTable: {
      '会员消费': { baseToken: '***REMOVED***', tableId: 'tblcMmuUPotPNlRx' },
      '会员储值': { baseToken: '***REMOVED***', tableId: 'tblXnlsb3uyFUUT5' },
      '散客消费': { baseToken: '***REMOVED***', tableId: 'tblTEVLqh7T35Qwx' },
      '门店支出': { baseToken: '***REMOVED***', tableId: 'tblNfD83KujasBDN' },
      '赠送礼品': { baseToken: '***REMOVED***', tableId: 'tbl8WnCrcbKLI2YF' },
      '会员调理': { baseToken: '***REMOVED***', tableId: 'tbl3gNN3XcLQ0OVf' },
    },
  },
};

// 内存缓存 tenant_access_token
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60000) {
    return tokenCache.token;
  }
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error('飞书应用凭证未配置，请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量');
  }
  
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg || JSON.stringify(data)}`);
  }
  tokenCache.token = data.tenant_access_token;
  tokenCache.expiresAt = now + data.expire * 1000;
  return tokenCache.token;
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

// 拉取一张表的所有记录（自动分页）
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

// 批量创建记录
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
  };
}

// 批量更新记录
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

// 字段格式转换工具
function toSelect(val) {
  if (!val) return null;
  return val;
}
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

// 分类本地记录为"需要更新"和"需要创建"
function splitRecords(localRecords, buildFieldsFn) {
  const createBatch = [];
  const updateBatch = [];
  for (const rec of localRecords) {
    const fields = buildFieldsFn(rec);
    // 清理 null 字段
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

// 回填 record_id 到本地新建的记录
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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

module.exports = {
  TABLE_CONFIG,
  feishuApi,
  fetchAllRecords,
  batchCreate,
  batchUpdate,
  toSelect,
  fromSelect,
  toMultiSelect,
  fromMultiSelect,
  toDate,
  fromDate,
  splitRecords,
  assignRecordIds,
  jsonResponse,
};
