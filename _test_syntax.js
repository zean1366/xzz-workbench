const fs = require('fs');

const html = fs.readFileSync('workbench-mobile.html', 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

if (scriptMatch) {
  const js = scriptMatch[1];
  
  // 找 habitStatsHTML 里的 xLabels
  const searchStr = '周${lbl}';
  const idx = js.indexOf(searchStr);
  if (idx >= 0) {
    const snippet = js.substring(idx - 100, idx + 50);
    console.log('=== 错误位置附近代码 ===');
    console.log(snippet);
    console.log('========================');
  }
  
  // 尝试用 Function 构造器测试，捕获详细错误
  try {
    new Function(js);
    console.log('✅ 语法正常');
  } catch (e) {
    console.log('❌ 语法错误:', e.message);
    
    // 从错误信息中提取行号
    const lineMatch = e.stack.match(/<anonymous>:(\d+)/);
    if (lineMatch) {
      const lineNum = parseInt(lineMatch[1]);
      const lines = js.split('\n');
      console.log(`\n错误行号: ${lineNum}`);
      console.log('附近代码:');
      for (let i = Math.max(0, lineNum-3); i < Math.min(lines.length, lineNum+2); i++) {
        const marker = (i === lineNum - 1) ? '👉 ' : '   ';
        console.log(marker + (i+1) + ': ' + lines[i].substring(0, 120));
      }
    }
  }
} else {
  console.log('没找到 script 标签');
}
