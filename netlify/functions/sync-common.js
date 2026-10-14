// 飞书开放平台 API 封装（Netlify Functions + 本地 server.js 共用）
// 直接调用飞书开放平台 API，不依赖 lark-cli
//
// 环境变量配置：
//   FEISHU_APP_ID        - 飞书应用 ID
//   FEISHU_APP_SECRET    - 飞书应用 Secret
//   FEISHU_TABLE_CONFIG  - 各模块表配置（JSON 字符串格式）
//
// FEISHU_TABLE_CONFIG 示例：
// {
//   "todo": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "weeklylearn": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "money": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "period": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "diary": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "checkin": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "content": { "baseToken": "xxx", "tableId": "tblxxx" },
//   "quickshop": {
//     "moodToTable": {
//       "会员消费": { "baseToken": "xxx", "tableId": "tblxxx" },
//       "会员储值": { "baseToken": "xxx", "tableId": "tblxxx" },
//       "散客消费": { "baseToken": "xxx", "tableId": "tblxxx" },
//       "门店支出": { "baseToken": "xxx", "tableId": "tblxxx" },
//       "赠送礼品": { "baseToken": "xxx", "tableId": "tblxxx" },
//       "会员调理": { "baseToken": "xxx", "tableId": "tblxxx" }
//     }
//   }
// }

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

// 从环境变量读取表配置
function loadTableConfig() {
  const raw = process.env.FEISHU_TABLE_CONFIG;
  if (!raw) {
    throw new Error('缺少环境变量 FEISHU_TABLE_CONFIG，请在 Netlify 环境变量中配置');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`FEISHU_TABLE_CONFIG 解析失败: ${e.message}`);
  }
}

const TABLE_CONFIG = loadTableConfig();

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

// ========== 记录 CRUD ==========

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

// 创建单条记录
async function createRecord(baseToken, tableId, fields) {
  const data = await feishuApi('POST', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`, { fields });
  if (data.code !== 0) {
    throw new Error(`创建记录失败: ${data.msg || JSON.stringify(data)}`);
  }
  return data.data?.record;
}

// 更新单条记录
async function updateRecord(baseToken, tableId, recordId, fields) {
  const data = await feishuApi('PUT', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`, { fields });
  if (data.code !== 0) {
    throw new Error(`更新记录失败: ${data.msg || JSON.stringify(data)}`);
  }
  return data.data?.record;
}

// 删除单条记录
async function deleteRecord(baseToken, tableId, recordId) {
  const data = await feishuApi('DELETE', `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`);
  if (data.code !== 0) {
    throw new Error(`删除记录失败: ${data.msg || JSON.stringify(data)}`);
  }
  return true;
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
    records: data.data?.records || [],
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

// ========== 文件上传 ==========

// 上传文件到飞书多维表格附件字段
// 返回 file_token，用于写入记录的附件字段
async function uploadFile(baseToken, tableId, recordId, fieldId, fileName, fileBuffer, contentType) {
  const token = await getTenantAccessToken();

  // 第一步：获取上传预授权
  const prepareRes = await fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      file_name: fileName,
      parent_type: 'bitable_file',
      parent_node: baseToken,
      size: fileBuffer.length,
    }),
  });
  const prepareData = await prepareRes.json();
  if (prepareData.code !== 0) {
    throw new Error(`上传预授权失败: ${prepareData.msg || JSON.stringify(prepareData)}`);
  }
  const uploadId = prepareData.data?.upload_id;

  // 第二步：上传文件内容
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: contentType }), fileName);
  formData.append('upload_id', uploadId);
  formData.append('parent_type', 'bitable_file');
  formData.append('parent_node', baseToken);

  const uploadRes = await fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/upload_part`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.code !== 0) {
    throw new Error(`上传文件失败: ${uploadData.msg || JSON.stringify(uploadData)}`);
  }
  const fileToken = uploadData.data?.file_token;

  // 第三步：完成上传
  const finishRes = await fetch(`https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      upload_id: uploadId,
      file_token: fileToken,
    }),
  });
  const finishData = await finishRes.json();
  if (finishData.code !== 0) {
    throw new Error(`完成上传失败: ${finishData.msg || JSON.stringify(finishData)}`);
  }

  return fileToken;
}

// 将 file_token 写入记录的附件字段
async function attachFileToRecord(baseToken, tableId, recordId, fieldId, fileToken) {
  const fields = {};
  fields[fieldId] = [{ file_token: fileToken }];
  return updateRecord(baseToken, tableId, recordId, fields);
}

// ========== 字段格式转换工具 ==========

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

// 附件字段转换
function toAttachment(fileTokens) {
  if (!fileTokens || !fileTokens.length) return null;
  return fileTokens.map(token => ({ file_token: token }));
}

function fromAttachment(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => v.file_token || v).filter(Boolean);
  return [];
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
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

module.exports = {
  TABLE_CONFIG,
  getTenantAccessToken,
  feishuApi,
  fetchAllRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  batchCreate,
  batchUpdate,
  uploadFile,
  attachFileToRecord,
  toSelect,
  fromSelect,
  toMultiSelect,
  fromMultiSelect,
  toDate,
  fromDate,
  toAttachment,
  fromAttachment,
  splitRecords,
  assignRecordIds,
  jsonResponse,
};
