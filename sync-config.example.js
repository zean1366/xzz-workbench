// 飞书同步配置示例文件
// 使用方法：复制本文件为 sync-config.js，填入实际的 baseToken 和 tableId
// 注意：sync-config.js 已加入 .gitignore，不会提交到代码仓库

module.exports = {
  // 每日待办
  todo: {
    baseToken: '你的多维表格 baseToken',
    tableId: '你的表 ID',
    fieldMap: {
      title: '事项',
      note: '备注',
      date: '日期',
      priority: '优先级',
      done: { field: '状态', type: 'statusDone' },
    },
    extraFields: ['分类', '完成时间'],
  },

  // 一周主题
  weeklylearn: {
    baseToken: '你的多维表格 baseToken',
    tableId: '你的表 ID',
    fieldMap: {
      title: '重点内容',
      category: '分类',
      priority: '优先级',
      goalType: '目标类型',
      stage: '进展阶段',
      note: '备注',
      startDate: '开始日期',
      endDate: '结束日期',
      quantifiedTarget: '量化目标',
      week: '周次',
    },
    extraFields: ['对应月度焦点', '当前进展'],
  },

  // 生活收支
  money: {
    baseToken: '你的多维表格 baseToken',
    tableId: '你的表 ID',
    fieldMap: {
      date: '日期',
      amount: '金额',
      type: '收支类型',
      bigCategory: '支出用途大分类',
      smallCategory: '支出用途类别小分类',
      incomeCategory: '收入分类',
      transferCategory: '往来分类',
      payMethod: '支付方式',
      note: '备注',
      title: null,
    },
    extraFields: ['多选'],
  },

  // 门店随手记（6种类型对应6张表）
  quickshop: {
    moodToTable: {
      '会员消费': { baseToken: 'baseToken', tableId: 'tableId' },
      '会员储值': { baseToken: 'baseToken', tableId: 'tableId' },
      '散客消费': { baseToken: 'baseToken', tableId: 'tableId' },
      '门店支出': { baseToken: 'baseToken', tableId: 'tableId' },
      '赠送礼品': { baseToken: 'baseToken', tableId: 'tableId' },
      '会员调理': { baseToken: 'baseToken', tableId: 'tableId' },
    },
    fieldMaps: {
      '会员消费': {
        customer: '客户姓名', date: '消费日期', amount: '消费金额',
        project: '调理项目', gift: '赠送项目', therapist: '实际调理人',
        feedback: '调理效果', note: '备注', title: null, mood: null,
      },
      '会员储值': {
        customer: '会员姓名', date: '充值日期', principal: '储值本金',
        giftAmount: '赠送金额', payMethod: '到账去向', firstTime: '是否首次储值',
        note: '备注', title: null, mood: null,
      },
      '散客消费': {
        date: '消费日期', amount: '消费金额', project: '消费项目',
        payMethod: '支付方式', channel: '来源渠道', level: '客户分层',
        nickname: '微信标识/称呼', note: '备注', title: null, mood: null,
      },
      '门店支出': {
        date: '支出日期', amount: '支出金额', category: '支出类别',
        payMethod: '支出方式', detail: '支出详情', note: '备注',
        title: null, mood: null,
      },
      '赠送礼品': {
        date: '日期', customer: '姓名', category: '赠送类别',
        note: '备注', title: null, mood: null,
      },
      '会员调理': {
        customer: '会员姓名', date: '调理日期', sessionNum: '第几次调理',
        project: '调理项目', focus: '本次调理重点', beforeState: '调理前状态',
        effect: '调理效果', feedbackWord: '客户反馈原话', giftProject: '赠送项目',
        note: '备注', title: null, mood: null,
      },
    },
  },

  // 例假记录
  period: {
    baseToken: '你的多维表格 baseToken',
    tableId: '你的表 ID',
    fieldMap: {
      startDate: '开始日期',
      endDate: '结束日期',
      status: '状态',
      flowAmount: '经量',
      painLevel: '痛经',
      color: '颜色',
      texture: '质地',
      symptoms: '身体症状',
      emotions: '情绪',
      note: '备注',
    },
  },
};
