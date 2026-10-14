// 文件上传 Function - 接收前端上传的文件，上传到飞书多维表格附件
const { getTenantAccessToken, TABLE_CONFIG, jsonResponse } = require('./sync-common.js');

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: '只支持 POST' });
  }

  try {
    // 解析 multipart form-data
    const boundary = event.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      return jsonResponse(400, { ok: false, error: '缺少 boundary' });
    }

    const body = Buffer.from(event.body, 'base64');
    const parts = parseMultipart(body, boundary);

    const filePart = parts.find(p => p.filename);
    if (!filePart) {
      return jsonResponse(400, { ok: false, error: '未找到文件' });
    }

    const meta = parseJsonPart(parts.find(p => p.name === 'metadata'));
    // 优先用 module(+mood) 从服务端配置解析 baseToken，避免前端接触表配置
    let baseToken = meta.baseToken;
    if (!baseToken && meta.module) {
      if (meta.module === 'quickshop' && meta.mood) {
        baseToken = TABLE_CONFIG.quickshop?.moodToTable?.[meta.mood]?.baseToken;
      } else {
        baseToken = TABLE_CONFIG[meta.module]?.baseToken;
      }
    }
    if (!baseToken) {
      return jsonResponse(400, { ok: false, error: `无法确定目标表格（module=${meta.module || '未传'}）` });
    }

    const token = await getTenantAccessToken();

    // 上传文件到飞书
    const formData = new FormData();
    formData.append('file', new Blob([filePart.data], { type: filePart.contentType || 'application/octet-stream' }), filePart.filename);
    formData.append('file_name', filePart.filename);
    formData.append('parent_type', 'bitable_file');
    formData.append('parent_node', baseToken);

    const uploadRes = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });

    const uploadData = await uploadRes.json();
    if (uploadData.code !== 0) {
      return jsonResponse(500, { ok: false, error: `飞书上传失败: ${uploadData.msg}` });
    }

    return jsonResponse(200, {
      ok: true,
      file_token: uploadData.data?.file_token,
      name: filePart.filename,
    });

  } catch (e) {
    console.error('Upload error:', e);
    return jsonResponse(500, { ok: false, error: e.message });
  }
};

// 简单的 multipart 解析器
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

function parseJsonPart(part) {
  if (!part || !part.data) return {};
  try {
    return JSON.parse(part.data.toString());
  } catch {
    return {};
  }
}
