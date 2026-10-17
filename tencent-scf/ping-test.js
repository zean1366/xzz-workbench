/**
 * ping 测试 · Web 函数格式（与 index.js 相同架构）
 * 用途：验证函数 URL / 网络 / CORS 是否正常，与业务代码隔离
 * 部署：腾讯云 SCF → 函数代码 → 在线编辑 index.js 全选替换为本文件内容 → 部署
 * 验证：浏览器打开 https://1505420925-1b0zb10qzb.ap-guangzhou.tencentscf.com/?action=ping
 *       若返回 {"code":0,"msg":"ping成功！..."} → 基础设施正常，问题在业务代码
 */
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    code: 0,
    msg: 'ping成功！Web函数9000端口正常',
    url: req.url,
    time: new Date().toISOString(),
  }));
});

server.listen(9000, '0.0.0.0', () => {
  console.log('[PING] Web 函数已监听 0.0.0.0:9000');
});
