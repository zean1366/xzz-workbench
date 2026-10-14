// 飞书同步配置示例文件 —— 本地 server.js 专用
// 使用方法：复制本文件为 sync-config.js，填入真实凭证和表格 token
// 注意：sync-config.js 已在 .gitignore 中，不会被提交；server.js 已禁止通过 HTTP 访问它

module.exports = {
  // 飞书自建应用凭证（https://open.feishu.cn/app → 创建企业自建应用 → 凭证与基础信息）
  // 权限只需勾选：bitable:app（多维表格读写）
  // 并把应用添加为各多维表格的协作成员
  FEISHU_APP_ID: 'cli_xxxxxxxxxxxxxxxx',
  FEISHU_APP_SECRET: 'xxxxxxxxxxxxxxxxxxxxxx',

  // 8 个模块的多维表格配置
  TABLE_CONFIG: {
    // 1. 每日待办
    todo:      { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
    // 2. 一周主题
    weeklylearn: { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
    // 3. 内容生产（选题库，需含「封面图」附件字段）
    content:   { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
    // 4. 门店随手记（6 种类型对应 6 张表）
    quickshop: {
      moodToTable: {
        '会员消费': { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },  // 需含「客户实拍」附件字段
        '会员储值': { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },  // 需含「充值凭证」附件字段
        '散客消费': { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
        '门店支出': { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
        '赠送礼品': { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
        '会员调理': { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
      },
    },
    // 5. 碎片日记（需含「照片」附件字段）
    diary:     { baseToken: '', tableId: '' },
    // 6. 生活收支
    money:     { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
    // 7. 例假记录
    period:    { baseToken: '你的 baseToken', tableId: 'tblXXXXXX' },
    // 8. 习惯打卡（需含「习惯名称」「打卡记录」「自动关联模块」字段）
    checkin:   { baseToken: '', tableId: '' },
  },
};
