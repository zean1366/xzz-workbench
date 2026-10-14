// 喜姿姿工作台 · 腾讯云 SCF Web 函数打包脚本（零依赖）
// 用法：node make_zip.js
// 产出：xizizi-scf-web.zip（根目录直接是 scf_bootstrap + index.js + package.json，无外层文件夹）
// scf_bootstrap 自动带 755 可执行权限（纯手写 zip 格式，精确控制 Unix 权限位）
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const ZIP_PATH = path.join(BASE, 'xizizi-scf-web.zip');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(v) { return Buffer.from([v & 0xFF, (v >>> 8) & 0xFF]); }
function u32(v) { return Buffer.from([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]); }
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 4) | d.getDate();
  return { time, date };
}

// scf_bootstrap：LF 换行、ascii、无 BOM；优先用腾讯云 Nodejs18.15 镜像 node 路径，回退 PATH
// cd 到脚本所在目录（防止工作目录不对导致 node 找不到 index.js）
// 启动信息落盘 /tmp/scf_start.log，控制台日志不可用时可在 Web IDE 文件面板查看
const BOOT = [
  '#!/bin/bash',
  'cd $(dirname $0) || exit 1',
  'NODE_BIN=/var/lang/node18/bin/node',
  '[ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node)',
  '{',
  '  echo "time=$(date \'+%F %T\')"',
  '  echo "cwd=$(pwd)"',
  '  echo "node=$NODE_BIN"',
  '  echo "node_exists=$([ -x "$NODE_BIN" ] && echo yes || echo no)"',
  '  echo "files: $(ls)"',
  '} > /tmp/scf_start.log 2>&1',
  'exec $NODE_BIN index.js',
].join('\n') + '\n';

const files = [
  { name: 'scf_bootstrap', mode: 0o755, data: Buffer.from(BOOT, 'ascii') },
  { name: 'index.js', mode: 0o644, data: fs.readFileSync(path.join(BASE, 'index.js')) },
  { name: 'package.json', mode: 0o644, data: fs.readFileSync(path.join(BASE, 'package.json')) },
];

const { time, date } = dosDateTime(new Date());
const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const name = Buffer.from(f.name, 'utf8');
  const crc = crc32(f.data);
  const size = f.data.length;

  // Local File Header（STORED 不压缩）
  locals.push(Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(date),
    u32(crc), u32(size), u32(size), u16(name.length), u16(0), name,
  ]), f.data);

  // Central Directory Header（version made by = Unix，external_attrs 带 755/644 权限位）
  centrals.push(Buffer.concat([
    u32(0x02014b50),
    u16((3 << 8) | 20), u16(20), u16(0), u16(0), u16(time), u16(date),
    u32(crc), u32(size), u32(size),
    u16(name.length), u16(0), u16(0), u16(0), u16(0),
    u32((f.mode << 16) >>> 0), u32(offset), name,
  ]));

  offset += 30 + name.length + size;
}

const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
  u32(cdBuf.length), u32(offset), u16(0),
]);

const zip = Buffer.concat([...locals, cdBuf, eocd]);
fs.writeFileSync(ZIP_PATH, zip);
console.log('打包完成: ' + ZIP_PATH + ' (' + zip.length + ' bytes)');

// ---------- 验证：读回中央目录检查权限位 ----------
console.log('\n=== zip 内容与权限位（scf_bootstrap 必须是 755）===');
const cdView = zip.subarray(offset, offset + cdBuf.length);
let pos = 0;
for (let i = 0; i < files.length; i++) {
  if (cdView.readUInt32LE(pos) !== 0x02014b50) throw new Error('中央目录签名错误');
  const mode = (cdView.readUInt32LE(pos + 38) >>> 16) & 0o7777;
  const nameLen = cdView.readUInt16LE(pos + 28);
  const name = cdView.subarray(pos + 46, pos + 46 + nameLen).toString();
  console.log('  ' + name.padEnd(16) + ' mode=' + mode.toString(8) + (mode === 0o755 ? '  <- 可执行 OK' : ''));
  pos += 46 + nameLen;
}
