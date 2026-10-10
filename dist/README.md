# 喜姿姿个人工作台（部署版）

这是用于 Gitee Pages 部署的混淆版本。

## 文件说明

- `index.html` - 入口页面（自动跳转桌面版/手机版）
- `workbench-desktop.html` - 桌面版工作台（已混淆压缩）
- `workbench-mobile.html` - 手机版工作台（已混淆压缩）
- `assets/` - 静态资源

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
