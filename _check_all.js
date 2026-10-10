const fs = require('fs');

const files = ['workbench-desktop.html', 'workbench-mobile.html'];

files.forEach(file => {
  console.log(`\n=== 检查 ${file} ===`);
  const html = fs.readFileSync(file, 'utf-8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  if (scriptMatch) {
    const js = scriptMatch[1];
    const tempFile = '_check_' + file.replace('.html', '.js');
    fs.writeFileSync(tempFile, js);
    
    const { execSync } = require('child_process');
    try {
      execSync(`node --check "${tempFile}"`, { stdio: 'pipe' });
      console.log('✅ 语法正常');
    } catch (e) {
      console.log('❌ 语法错误:');
      console.log(e.stderr.toString());
    }
    
    fs.unlinkSync(tempFile);
  }
});
