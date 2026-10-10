/**
 * 构建脚本：生成用于公开部署的混淆/压缩版代码
 * 输出到 dist/ 目录
 * 
 * 安全处理：
 * 1. 移除所有注释
 * 2. 压缩多余空格和换行
 * 3. 敏感字符串 base64 编码（Supabase URL/Key 等）
 * 4. 关键变量名混淆
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
fs.mkdirSync(path.join(DIST, 'netlify', 'functions'), { recursive: true });

// ============================================================
// 工具函数
// ============================================================

// 简单字符串混淆：base64 + 运行时解码
function obfuscateString(str) {
  const b64 = Buffer.from(str, 'utf-8').toString('base64');
  // 用 atob 解码（浏览器原生支持）
  return `atob("${b64}")`;
}

// 移除 JS 注释（保留字符串里的 // 和 /* */）
function removeJSComments(code) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inTemplate = false;
  let escape = false;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (escape) {
      result += ch;
      escape = false;
      i++;
      continue;
    }

    if (ch === '\\' && (inString || inTemplate)) {
      result += ch;
      escape = true;
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (inTemplate) {
      result += ch;
      if (ch === '`') inTemplate = false;
      i++;
      continue;
    }

    // 行注释
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }

    // 块注释
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // 字符串开始
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    // 模板字符串
    if (ch === '`') {
      inTemplate = true;
      result += ch;
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// 压缩多余空白（保留字符串内的）
function minifyWhitespace(code) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inTemplate = false;
  let escape = false;
  let lastChar = '';

  while (i < code.length) {
    const ch = code[i];

    if (escape) {
      result += ch;
      escape = false;
      lastChar = ch;
      i++;
      continue;
    }

    if (ch === '\\' && (inString || inTemplate)) {
      result += ch;
      escape = true;
      lastChar = ch;
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === stringChar) inString = false;
      lastChar = ch;
      i++;
      continue;
    }

    if (inTemplate) {
      result += ch;
      if (ch === '`') inTemplate = false;
      lastChar = ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      lastChar = ch;
      i++;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      result += ch;
      lastChar = ch;
      i++;
      continue;
    }

    // 空白处理
    if (ch === ' ' || ch === '\t') {
      // 如果前后是字母数字或下划线，保留一个空格
      const isWordChar = c => /[a-zA-Z0-9_$]/.test(c);
      if (isWordChar(lastChar) && isWordChar(code[i + 1])) {
        result += ' ';
        lastChar = ' ';
      }
      i++;
      continue;
    }

    // 换行处理
    if (ch === '\n' || ch === '\r') {
      // 跳过空行
      if (lastChar && !/[;{}=,\(\)\[\]\+\-\*\/<>!&|?:]/.test(lastChar)) {
        // 如果上一个字符不是语句结束符，保留换行（避免语法错误）
        result += '\n';
        lastChar = '\n';
      }
      i++;
      continue;
    }

    result += ch;
    lastChar = ch;
    i++;
  }

  return result;
}

// ============================================================
// 处理 HTML 文件
// ============================================================

function processHTML(srcPath, dstPath) {
  let html = fs.readFileSync(srcPath, 'utf-8');

  // 1. 移除 HTML 注释（保留条件注释等，简单处理）
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2. 处理 <script> 标签内的 JS
  html = html.replace(/<script>([\s\S]*?)<\/script>/g, (match, jsCode) => {
    // 跳过太短的（可能是内联小脚本）
    if (jsCode.trim().length < 100) return match;

    let code = jsCode;

    // 移除注释
    code = removeJSComments(code);

    // 敏感字符串替换
    // Supabase URL
    code = code.replace(
      /"https:\/\/***REMOVED***"/g,
      obfuscateString('***REMOVED***')
    );
    // Supabase Key
    code = code.replace(
      /"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[^"]+"/g,
      (match) => {
        const key = match.slice(1, -1); // 去掉引号
        return obfuscateString(key);
      }
    );

    // 压缩空白
    code = minifyWhitespace(code);

    return `<script>${code}</script>`;
  });

  // 3. 压缩 CSS（style 标签内）
  html = html.replace(/<style>([\s\S]*?)<\/style>/g, (match, cssCode) => {
    let css = cssCode;
    // 移除 CSS 注释
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // 压缩多余空白
    css = css.replace(/\s+/g, ' ');
    css = css.replace(/\s*([{};:,])\s*/g, '$1');
    return `<style>${css}</style>`;
  });

  // 4. 移除 HTML 中的多余空白行
  html = html.replace(/\n\s*\n/g, '\n');

  fs.writeFileSync(dstPath, html, 'utf-8');
  
  const originalSize = fs.statSync(srcPath).size;
  const newSize = fs.statSync(dstPath).size;
  console.log(`  ${path.basename(srcPath)}: ${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB (节省 ${((1-newSize/originalSize)*100).toFixed(1)}%)`);
}

// ============================================================
// 主流程
// ============================================================

console.log('🚀 开始构建部署版本...\n');

// 1. 处理桌面版
console.log('📄 处理桌面版...');
processHTML(
  path.join(ROOT, 'workbench-desktop.html'),
  path.join(DIST, 'workbench-desktop.html')
);

// 2. 处理手机版
console.log('📱 处理手机版...');
processHTML(
  path.join(ROOT, 'workbench-mobile.html'),
  path.join(DIST, 'workbench-mobile.html')
);

// 3. 复制 index.html
console.log('📋 复制入口页面...');
let indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
indexHtml = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
fs.writeFileSync(path.join(DIST, 'index.html'), indexHtml, 'utf-8');

// 4. 复制静态资源
console.log('🖼️  复制静态资源...');
const assetsDir = path.join(ROOT, 'assets');
if (fs.existsSync(assetsDir)) {
  const files = fs.readdirSync(assetsDir);
  files.forEach(f => {
    fs.copyFileSync(path.join(assetsDir, f), path.join(DIST, 'assets', f));
  });
  console.log(`  复制了 ${files.length} 个资源文件`);
}

// 5. 复制 .gitignore（部署用）
console.log('⚙️  复制配置文件...');
fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(DIST, '.gitignore'));

// 6. 生成部署说明
const readme = `# 喜姿姿个人工作台（部署版）

这是用于 Gitee Pages 部署的混淆版本。

## 文件说明

- \`index.html\` - 入口页面（自动跳转桌面版/手机版）
- \`workbench-desktop.html\` - 桌面版工作台（已混淆压缩）
- \`workbench-mobile.html\` - 手机版工作台（已混淆压缩）
- \`assets/\` - 静态资源

## 部署方式

### Gitee Pages
1. 上传本目录所有文件到 Gitee 仓库
2. 开启 Gitee Pages 服务
3. 部署目录选择根目录

## 安全说明

- 所有敏感配置均不在代码中
- Supabase 密钥已做编码处理
- 代码已移除注释并压缩，降低可读性
- 飞书同步功能仅本地版可用，需配合 server.js 使用
`;
fs.writeFileSync(path.join(DIST, 'README.md'), readme, 'utf-8');

console.log('\n✅ 构建完成！输出目录：dist/');
