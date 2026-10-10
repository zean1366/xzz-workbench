/* ============================================================
   应用配置文件 —— 包含所有敏感密钥和配置
   使用方法：
   1. 复制本文件为 app-config.js
   2. 填入你自己的各项配置
   3. app-config.js 已在 .gitignore 中，不会被提交到代码仓库
   ============================================================ */

window.APP_CONFIG = {
  // Supabase 云端同步配置（用于多设备数据同步）
  SUPABASE_URL: "你的 Supabase 项目 URL",
  SUPABASE_KEY: "你的 Supabase anon key",

  // DeepSeek API 配置（用于语音记账智能分类）
  // 注意：这是付费 API，请妥善保管，不要泄露给他人
  DEEPSEEK_KEY: "你的 DeepSeek API Key",

  // 是否开启云端同步
  cloudSync: true
};
