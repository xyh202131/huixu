# 会序在魔搭创空间运行

使用 Docker 类型的创空间。容器启动 Node.js 24 服务，监听 `0.0.0.0:7860`，同时提供工作台页面和活动 API。镜像内包含 Office、PDF、OCR 和压缩包解析依赖。首个 Docker 空间需要账号已绑定阿里云并完成实名认证。[魔搭 Docker 创空间文档](https://modelscope.cn/docs/studios/docker)

## 运行时配置

| 配置项 | 类型 | 用途 |
| --- | --- | --- |
| `HUIXU_PUBLIC_ORIGIN` | 明文 | 应用的完整 HTTPS 源，例如 `https://owner-huixu.ms.show`。用于登录安全校验和生成嘉宾、报名及交接链接。 |
| `HUIXU_SETUP_CODE` | 密文 | 至少 32 字符的随机初始化码。首次访问应用域名后，从头像入口建立负责人账号。 |
| `HUIXU_SIGNUP_CODE` | 密文，可选 | 至少 32 字符的独立随机邀请码。首位负责人创建后开放其他账号注册，留空时保留已有账号登录。 |
| `HUIXU_MODEL_ORIGINS` | 明文，可选 | 运维批准的自定义 HTTPS 模型源，用逗号分隔。云端内置模型服务及魔搭推理源可直接在界面填 Key。 |
| `HUIXU_LLM_PROTOCOL`、`HUIXU_LLM_BASE_URL`、`HUIXU_LLM_MODEL`、`HUIXU_LLM_API_KEY` | 可选，API Key 用密文 | 负责人 Agent 及资料整理的服务端后备模型。 |
| `HUIXU_LLM_KEY_HEADER` | 明文，可选 | 用于 Anthropic 兼容接口，可填 `bearer` 或 `x-api-key`。原生 Anthropic 默认 `x-api-key`，MiniMax 默认 `bearer`。 |
| `HUIXU_RESEND_API_KEY`、`HUIXU_MAIL_FROM` | 可选，API Key 用密文 | 正式邮件投递，需要可投递的空间访问地址及已验证发件域。 |

私有空间从已登录的魔搭创空间页面打开。嵌入工作台的负责人会话依赖浏览器支持 HTTPS 分区 Cookie。私有访问权限也适用于应用域名、报名和嘉宾链接。

应用将账号、工作区、Agent 对话、模型设置、活动索引、草稿、报名、已发布议程和嘉宾课件写入 `/mnt/workspace/huixu`。账号与报名分别使用共享的账号库和按活动负责人校验权限的报名库。每位账号的工作区在 `accounts/<账号 ID 哈希>/workspace.sqlite`，邀请注册的账号使用各自目录中的资料与模型数据库。首位负责人继续读取此前的资料索引和模型库。部署时保留整个数据目录，迁移或改名时另行备份。模型作为外部服务调用，部署令牌只用于创空间管理。

## 检查

- 打开应用域名和 `/healthz`，核对构建页面及运行状态。
- 使用初始化码建立负责人，确认匿名访问仅显示示例和已开放的公开活动。
- 需要开放开户时，保存新的密文邀请码，用两个测试账号验证活动、资料与对话隔离。使用同一账号跨设备及重启后恢复工作区。
- 导入虚构资料，执行索引、保存草稿、首次发布和报名，检查重启后记录是否保留。
- 登录后打开模型设置，核对「Agent 对话」与「资料整理」显示的当前模型，分别测试工具调用和证据提取。正式投递前使用测试收件人验证 Resend 与确认链接。
