const http = require('http');
const fs = require('fs');
const path = require('path');
const { pull, push } = require('./sync-service.js');

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

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // ===== API 接口 =====

  // 测试连通性
  if (urlPath === '/api/sync/test') {
    try {
      const result = pull('todo');
      if (result.ok) {
        sendJSON(res, 200, { ok: true, message: '飞书连接正常', count: result.records.length });
      } else {
        sendJSON(res, 500, { ok: false, error: result.error });
      }
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 从飞书拉取数据
  const pullMatch = urlPath.match(/^\/api\/sync\/pull\/(.+)$/);
  if (pullMatch && req.method === 'GET') {
    const module = pullMatch[1];
    try {
      console.log(`[SYNC] Pulling ${module} from Feishu...`);
      const result = pull(module);
      if (result.ok) {
        console.log(`[SYNC] Pulled ${result.records.length} records from ${module}`);
        sendJSON(res, 200, { ok: true, records: result.records });
      } else {
        console.error(`[SYNC] Pull failed:`, result.error);
        sendJSON(res, 500, { ok: false, error: result.error });
      }
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
    try {
      const body = await readBody(req);
      console.log(`[SYNC] Pushing ${body.records?.length || 0} records to ${module}...`);
      const result = push(module, body.records || []);
      if (result.ok) {
        console.log(`[SYNC] Push done: created=${result.created}, updated=${result.updated}, errors=${result.errors?.length || 0}`);
        sendJSON(res, 200, {
          ok: true,
          created: result.created,
          updated: result.updated,
          errors: result.errors || [],
          records: result.records,
        });
      } else {
        console.error(`[SYNC] Push failed:`, result.error);
        sendJSON(res, 500, { ok: false, error: result.error });
      }
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
    try {
      const body = await readBody(req);
      const localRecords = body.records || [];
      console.log(`[SYNC] Full sync for ${module}, local=${localRecords.length}`);

      // 1. 拉取飞书数据
      const pullResult = pull(module);
      if (!pullResult.ok) {
        sendJSON(res, 500, { ok: false, error: pullResult.error, step: 'pull' });
        return;
      }
      const feishuRecords = pullResult.records;
      console.log(`[SYNC] Feishu has ${feishuRecords.length} records`);

      // 2. 构建飞书记录索引
      const feishuMap = {};
      for (const r of feishuRecords) {
        feishuMap[r.record_id] = r;
      }

      // 3. 本地记录按 record_id 分类
      const toCreate = []; // 本地新建，没有 record_id
      const toUpdate = []; // 两边都有，本地更新的
      const localRecordIds = new Set();

      for (const local of localRecords) {
        if (local.record_id && feishuMap[local.record_id]) {
          localRecordIds.add(local.record_id);
          // 冲突：都有，以本地为准（用户刚在工作台改的）
          toUpdate.push(local);
        } else if (local.record_id) {
          // 本地有 record_id 但飞书没有（可能在飞书删了），忽略
          localRecordIds.add(local.record_id);
        } else {
          // 本地没有 record_id，是新增的
          toCreate.push(local);
        }
      }

      // 4. 飞书有但本地没有的记录，返回给前端让它加进去
      const toAddLocal = feishuRecords.filter(r => !localRecordIds.has(r.record_id));

      console.log(`[SYNC] toCreate=${toCreate.length}, toUpdate=${toUpdate.length}, toAddLocal=${toAddLocal.length}`);

      // 5. 推送新增和更新到飞书
      let created = 0, updated = 0, errors = [];

      if (toCreate.length + toUpdate.length > 0) {
        const allToPush = [...toCreate, ...toUpdate];
        const pushResult = push(module, allToPush);
        if (pushResult.ok) {
          created = pushResult.created;
          updated = pushResult.updated;
          errors = pushResult.errors || [];
        } else {
          errors.push({ error: pushResult.error });
        }
      }

      // 6. 返回同步结果：需要加到本地的新记录 + 推送结果
      const pushedRecordMap = {};
      const allPushed = [...toCreate, ...toUpdate];
      for (const r of allPushed) {
        if (r.record_id) pushedRecordMap[r.id] = r.record_id;
      }

      sendJSON(res, 200, {
        ok: true,
        created,
        updated,
        errors,
        toAddLocal,      // 飞书新增的，要加到本地
        pushedRecordMap, // 本地新增的，带 record_id
      });
    } catch (e) {
      console.error(`[SYNC] Full sync error:`, e);
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ===== 静态文件 =====

  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  // 安全检查：防止路径遍历
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
    // 禁止缓存，确保每次都是最新版本
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
  console.log('  飞书同步: 已启用');
  console.log('========================================');
  console.log('  按 Ctrl+C 停止服务器');
  console.log('========================================');
});
