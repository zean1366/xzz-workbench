/**
 * 构建脚本：生成用于公开部署的版本
 * 输出到 dist/ 目录
 * 
 * 注意：所有敏感密钥（DeepSeek Key 等）
 * 都从 app-config.js 读取，该文件不提交到代码仓库。
 * 飞书密钥（APP_ID/APP_SECRET）只存在 sync-config.js（本地）和
 * Netlify 环境变量（线上）中，绝不进入前端代码。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// 清空 dist 目录
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });

// 处理 HTML 文件
function processHTML(srcPath, dstPath) {
  let html = fs.readFileSync(srcPath, 'utf-8');
  fs.writeFileSync(dstPath, html, 'utf-8');
  
  const originalSize = fs.statSync(srcPath).size;
  const newSize = fs.statSync(dstPath).size;
  console.log(`  ${path.basename(srcPath)}: ${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB`);
}

// ============================================================
// 主流程
// ============================================================

console.log('🚀 开始构建部署版本...\n');

console.log('📄 处理桌面版...');
processHTML(
  path.join(ROOT, 'workbench-desktop.html'),
  path.join(DIST, 'workbench-desktop.html')
);

console.log('📱 处理手机版...');
processHTML(
  path.join(ROOT, 'workbench-mobile.html'),
  path.join(DIST, 'workbench-mobile.html')
);

console.log('📋 复制入口页面...');
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));

console.log('🖼️  复制静态资源...');
const assetsDir = path.join(ROOT, 'assets');
if (fs.existsSync(assetsDir)) {
  const files = fs.readdirSync(assetsDir);
  files.forEach(f => {
    fs.copyFileSync(path.join(assetsDir, f), path.join(DIST, 'assets', f));
  });
  console.log(`  复制了 ${files.length} 个资源文件`);
}

// 验证语法
console.log('\n🔍 验证 JS 语法...');
let hasError = false;
['workbench-desktop.html', 'workbench-mobile.html'].forEach(file => {
  const html = fs.readFileSync(path.join(DIST, file), 'utf-8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/g);
  if (m) {
    m.forEach((scriptTag, idx) => {
      const code = scriptTag.replace(/^<script>/, '').replace(/<\/script>$/, '');
      if (code.trim().length < 100) return;
      try {
        new Function(code);
      } catch (e) {
        console.log(`  ❌ ${file} 第${idx+1}个script: ${e.message}`);
        hasError = true;
      }
    });
  }
});
if (!hasError) console.log('  ✅ 所有 JS 语法检查通过');

console.log('\n✅ 构建完成！输出目录：dist/');
console.log('⚠️  提醒：部署前请在 dist/ 目录创建 app-config.js 并填入你的密钥配置');
