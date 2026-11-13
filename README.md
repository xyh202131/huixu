# 一站式活动规划与执行 Agent

面向一年承办多场活动的团队，支持企业培训、行业论坛、展览、市集和校园活动。团队从一句话、批量资料或模板起步，在同一工作台维护计划、筹备、报名、发布、现场与复盘。涉及已发布安排的改动由负责人在一张变更单上核对并确认。

| 文件 | 用途 |
| --- | --- |
| [完整产品设计](docs/product-design.md) | 五类活动、九项能力、工作台结构和统一变更发布 |
| [任务清单](task.md) | 全量功能的交付依赖、需求对应关系与验收场景 |
| [Agent 行为约定](agent.md) | 资料处理、校验、外部协作、改排、发布与发送权限 |
| [项目协作说明](AGENTS.md) | 在本目录工作的协作入口 |

当前为 v0.2 设计评审。150 人论坛的换厅场景用于验证完整产品的变更流程。付费票务、选座退款与外部消息渠道按活动需要接入。

## 本地 Web 工作台

在项目根目录运行以下命令，然后打开 [会序工作台](http://127.0.0.1:5173/)。

~~~powershell
cd web
npm.cmd ci --ignore-scripts
npm.cmd run dev
~~~

五类活动可从顶栏切换。桌面左栏打开对应章节，右栏是可收起的 Agent 工作台。手机底栏提供概况、目录、现场和 Agent，Agent 和模型设置用全屏面板打开。默认论坛可从「变更单」比较 B 厅和 C 厅。登录后可发布 C 厅方案，再到议程、现场和材料章节核对。演练数据保存在当前浏览器。

外部表单、凭证核验和通知记录都在本机演练。共享权限、扫码摄像头、票务支付、退款及消息渠道服务待接入。

## 登录本机工作台

点击工作台头像打开账户弹窗。首次设置负责人姓名、邮箱和 12–128 位密码，此后在弹窗里登录或退出。可点右上角的关闭按钮或按 Esc 回到当前页面。认证使用 Better Auth，账号和会话存储在同一工作区标识下的 `auth.sqlite`。会话默认有效七天，退出时撤销当前会话。自定义路径使用 `HUIXU_AUTH_DB`，数据库路径须位于 Web 根目录之外。 [Better Auth 的 SQLite 配置](https://better-auth.com/docs/adapters/sqlite)

打开工作台即可浏览五类示例活动的七个章节，查看资料原文、议程、变更影响和现场大屏。登录后可访问已保存的活动、原件、索引和智能整理，并使用 Agent。公开报名和外部协作保留浏览器内的演练流程。现有活动、方案草稿和现场状态继续使用当前浏览器存储。团队成员权限和活动数据的服务端隔离待接入。运行 `npm test` 可验证首账号并发创建、登录、受保护接口、退出和失败限流。

## 接入 Agent 模型

登录后，点击右上角齿轮打开「模型设置」。选择服务商后已填好默认模型，填入对应的 API Key 即可测试连接或保存。内置 OpenAI、Anthropic Claude、Google Gemini、DeepSeek、通义千问百炼中国内地和 MiniMax 中国。 [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [Claude](https://platform.claude.com/docs/en/models/haiku-5-5/overview) · [Gemini](https://ai.google.dev/gemini-api/docs/openai) · [DeepSeek](https://api-docs.deepseek.com/guides/tool_calls/) · [百炼](https://help.aliyun.com/en/model-studio/base-url) · [MiniMax](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)

自定义接口支持 OpenAI Chat Completions 和 Anthropic Messages，可填服务基址或完整调用地址，以及模型名称和按需填写的 API Key。支持 HTTPS 或本机 HTTP。Anthropic Messages 可选择 `x-api-key` 或 `Authorization: Bearer`。连接测试使用示例请求核对工具调用与结果回传。

模型设置中可分别配置「Agent 对话」和「资料整理」。资料整理默认沿用对话模型，也可单独选择服务商。资料提取测试用虚构议程和海报检查两条冲突时间及对应出处。新整理任务读取当前配置，已完成的结果随资料版本保留。

API Key 保存在本机服务的 `model-settings.sqlite`，可用 `HUIXU_MODEL_DB` 指定 Web 根目录之外的文件。界面显示密钥保存状态。移除独立的资料整理配置后恢复共用对话模型，移除对话配置后使用已有的 `web/.env.local`。环境变量配置方式见 [web/.env.example](web/.env.example)。

工作台的本机开发与预览服务处理 `/api/agent`。模型可以读议程与筹备、预算、报名、现场和发布状态，检索已授权的活动资料，准备活动草稿或提出换厅改时。换厅提议沿用工作台的校验，发布仍需要变更单确认。调用提供商时发送问题、工具所需的业务摘要及获准引用的相关片段。报名名单和资料原件不随活动摘要发送。

配置缺失时可从 Agent 工作台打开模型设置或使用本机规则演练。静态 `dist` 需要配套服务端。Agent 对话当前为单轮，浏览同一活动的不同章节时保留这一轮的回答，也可查询该活动的持久化资料索引。

## 导入项目与活动记忆

从「活动概览 → 导入活动项目」用一批文件创建新活动，也可以到「资料与确认」追加文件或压缩包。资料写入本机 SQLite，解析完成后即可搜索原文、下载原件或导出 Markdown 知识页。压缩包有独立的文件清单，搜索结果会保留包内路径和页码、行号等位置。同名同内容重传去重，同名新内容保留旧版并使用新版做检索。默认仅供本机搜索，开启资料的 Agent 引用后，模型才能检索对应片段。

导入时勾选「允许 Agent 引用本批资料」，索引完成后自动整理。标准表格字段在本地提取，需理解上下文的片段交给已配置的模型。「Agent 智能整理」显示缺失项、并排冲突原文和提取出处。确认冲突后生成可编辑方案，进入「方案与议程」补齐字段或增删条目。整理结果随当前资料版本存储在 SQLite，方案草稿和确认操作跟随浏览器活动数据。单次整理最多检查 2,500 个片段，其中最多 280 个非标准片段交给模型分批提取。未解析文件及未完成片段各有提示。

| 类别 | 可解析格式 |
| --- | --- |
| 文档与演示 | PDF、DOCX、RTF、PPTX |
| 表格 | XLSX、XLS、CSV、TSV |
| 文本与数据 | TXT、Markdown、HTML、JSON、JSONL、XML、YAML |
| 图片与扫描件 | PNG、JPEG、WebP、BMP、TIFF、GIF 和无文字层的 PDF 页，使用本机 OCR |
| 压缩包 | ZIP、7z、RAR、TAR、TAR.GZ、TAR.BZ2、TAR.XZ，以及 GZ、BZ2、XZ 单文件流 |

本机使用带 `node:sqlite` 和 FTS5 的 Node.js（本项目使用 Node.js 24），以及 Python 解析器。在 `web` 中运行 `python -m pip install --target .parser-deps -r server/requirements.txt` 可配置 Office、PDF 和 OCR 依赖。7z、RAR 使用本机 7-Zip，可从 PATH 或 Windows 安装位置识别，也可通过环境变量 `HUIXU_MEMORY_7Z` 指定。旧版 DOC、PPT 保存原件并提示转换为 DOCX、PPTX。加密、损坏或暂不支持的包内成员会显示状态，已完成的成员仍可检索。普通文件上限 12 MB，压缩包上限 48 MB，包内最多处理 300 项、3 层、累计展开 64 MB。扫描 PDF 和多帧图片会显示未处理的 OCR 范围。 [RapidOCR 配置文档](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/install/)

Windows 默认数据库在 `%LOCALAPPDATA%/Huixu/<工作区标识>/memory.sqlite`。如需指定位置，在本机配置 `HUIXU_MEMORY_DB` 并使用 Web 根目录之外的路径。索引按活动 ID 查询，活动计划和现场状态仍保存在当前浏览器。团队权限、审核后的跨活动知识复用和恢复演练见 [Agent 长期记忆设计](docs/agent-memory.md)。
