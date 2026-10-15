# agent-modes：需求与架构方案

阶段：ultra 架构方案，2026-10-16。实现完成前必须经过 hard 详细设计与任务拆分、standard 实现、白板 hard 独立验证。包名暂定 `@guxi11/agent-modes`，命令 `agent-modes`；未核验 npm 名称可用性，不发布。

## 需求判断

这是用户自己的 agent 配置运行时：npm 包提供入口 skill、资源获取、mode 计算和 agent 适配；另一个由用户拥有的 Git 仓库保存配置及资源绑定。项目内只有可选 `.mode` 选择器，不形成另一套“全局规则 / 项目规则”体系。任何目录可有 mode，Git 只用于发现边界及分发配置。

已阅读 `/Users/zyy/guxi11-emacs`（实际路径，大小写同源）。`site-start.el` 是统一入口；`site-lisp/config/init.el` 按 core/editor/completion/lang 等职责组装并区分立即与延迟加载；`editor/init-mode.el` 的 `auto-mode-alist` 用后缀决定 mode，autoload 按需载入；`lang/init-vue.el` 用 mode hook 组合多种语言资源；`.gitmodules` 与 Git gitlink 固定扩展来源和 commit。要迁移的是“配置由用户维护，选择与资源加载解耦”，而不是复制 Emacs Lisp 或允许项目任意执行启动脚本。

最小完整版本应闭环：创建 / 克隆配置仓库 → 声明模式及资源 → 获取并锁定资源 → 对目录解析 → 展示稳定上下文 → 安装或启动 agent → 分享同一仓库让另一用户复现。

## 明确范围

- 独立 Node.js 20+、TypeScript npm 包，不使用或依赖 ai-rulez，不复用现有 aiconfig 实现。
- 两个实用适配器：Claude Code、Codex CLI。其他 agent 后续按同一 seam 扩展，首版不放空壳。
- 资源支持配置仓库内的本地文件 / 完整 skill 目录，以及指定 Git 仓库、ref、子目录的远程资源。不运行包生命周期脚本，不自动执行 skill scripts。
- 配置分享通过普通 Git clone 与资源锁复现。支持初始化指定目录及从指定 Git URL 导入到新目录；不需要在线服务、账号、云 registry。
- 不生成或改写项目 AGENTS.md / CLAUDE.md，不擅改用户真实全局配置，不迁移或修改 Emacs 配置。安装需有预览及指定隔离目标目录。
- 不新增测试代码；允许类型检查、构建、打包和临时真实场景验证。只写本任务必要方案、详细设计、tasks、验收记录及产品本身需要的 SKILL.md。

## 核心模型与职责

一个用户配置仓库包含 `modes.json`、`modes.lock.json`，以及本地 `rules/`、`skills/` 等资源目录。工具的下载缓存、安装记录、构建产物与临时目录不能进入共享内容身份。全局配置位置只是一条本机指针：显式 `--config` 优先，其次环境变量，最后固定默认路径；具体格式由 hard 固定。配置仓库可以位于任意 Git 目录，不绑定工具源码所在目录。

模式是有 id 的组合：父 mode、检测条件、规则资源绑定、skill 绑定。不强制独占 major mode；如 `base → programming → typescript` 可与 `review` 组合。父子声明是 DAG，循环、未知 id、重复资源命名等必须给出明确错误。

独立模块：

1. **配置与 resolver**：将显式配置、已采集的目录特征映射到有序模式及选择原因。纯计算与文件采集分开。
2. **资源仓库**：源描述 → 锁定 commit / 内容摘要 → 完整资源树。隐藏 Git 拉取、路径约束、缓存及完整性校验。
3. **上下文编译**：模式计划 + 已锁定资源 → 规范化稳定文本与摘要；诊断信息另行输出。
4. **agent 适配**：相同编译结果编码为各 agent 的 hook 输出或启动参数，安装计划显式返回待写文件；实际写入是末端操作。
5. **CLI 与入口 skill**：薄命令层，既能供人调用，也能作为统一的 hook 脚本；入口 skill 引导维护配置及解释已选模式，不承担首次请求前必须完成的执行保证。

## 模式解析语义

项目边界优先采用 Git worktree 根目录（`.git` 文件也有效），非 Git 目录以调用目录为边界。向上查找 `.mode` 只到边界，最近文件生效，避免隐式叠加全部父目录。非 Git 下本次只解释当前目录的 `.mode`；更广目录继承留后续，避免扫描到用户 home 的偶然配置。

`.mode` 是 JSON 数据，列出增加 / 禁用的 mode，并可显式关闭自动推断；不执行 JS、shell 或仓库配置中的程序。默认种子来自配置仓库。推断只依赖声明的文件存在条件、受限文件匹配及 package.json 依赖，不使用 LLM、网络、mtime、Git dirty 状态、绝对项目路径或随机数。

顺序：默认种子 → 按数值 priority、id 排序的匹配模式 → `.mode` 顺序。父 mode 在子 mode 之前按声明顺序展开；稳定去重。禁用必须在展开后也成立：若保留模式依赖已禁用父模式，应明确报冲突，不能悄悄重新加入。绑定资源按 mode 顺序和绑定声明顺序去重，不能依赖 readdir 或对象枚举偶然次序。

推断文件范围应有明确上限并排除 `.git`、`node_modules`、构建及下载缓存目录；超过上限要报错，不能输出依赖遍历先后顺序的部分结果。配置与 `.mode` 无效时不得默默降级到没有规则的会话。

`resolve` 输出机器可读计划：schema 版本、有序 mode、有序资源、选择原因和诊断。`render` / `hook` 从同一计划编译，禁止在 adapter 里各算一遍 mode。

## 资源与可复现分享

锁文件记录源标识、Git 完整 commit、资源相对路径、完整资源树内容摘要。首次显式同步可以生成锁；有锁默认复用锁，更新须明确请求，`--frozen` 不允许创建或变更锁。共享仓库中的路径均相对，不把个人绝对 home 写入锁文件。接收者 clone 配置仓库后 frozen 同步应拿到相同资源内容。

远程 Git 获取只在同步阶段发生；resolve/render/hook/启动阶段应离线工作，缺锁、缺资源或摘要不符立即报错。不运行来源仓库的安装命令、不初始化 submodule、不触发 Git hooks。缓存采用内容身份而不是当前分支名；失败不得写出看似完整的资源或锁。

只接受目录内普通文件 / 目录，拒绝越界路径、symlink 逃逸与 `.git` 内容进入资源树；保留完整 skill 的 scripts/references/assets 及可执行位。路径验证必须覆盖本地源、Git 子目录、配置文件引用及安装目标父目录，不能仅检查字符串 `../`。

规则立即载入；skills 默认生成有序索引，绑定可选择 preload 将 SKILL.md 正文立即载入。完整资源始终物化，按需加载可定位到资源目录及执行脚本。渲染的 skill 信息和资源定位必须可实际使用，不能只输出名字。入口 skill 跟 npm 包分发，并可安装到指定 agent 根目录。

## 稳定上下文与缓存边界

编译文本按照工具协议版本 → 稳定模式列表 → 有序规则正文 → 有序 skill 元数据 / 预载正文排列。统一 UTF-8、LF、尾部换行和稳定标题。同一配置资源内容、模式顺序、agent 与编译器协议版本，输出字节应相同。

不得在稳定正文放 cwd、项目绝对路径、时间戳、会话 id、推断原因、Git 分支、随机临时路径或下载日志。必要的 skill 路径来自同一安装内固定的内容目录；若正文含安装绝对路径，应明确稳定性只覆盖同一安装，摘要计算必须覆盖实际输出字节，不能声称跨机器字节相同。动态诊断与路径说明通过 resolve JSON / stderr 输出。

同 mode 但资源正文、skills 元数据、锁、工具协议不同，不能视为同内容。输出应有内容摘要用于比较，不能把摘要当模型服务商的 cache key 或 cache hit 证明。首版不改动 provider API 缓存参数。

同 agent + 同 mode 只是在资源版本和编译器一致时尽量稳定；agent 自己的系统提示、cwd、原生项目 instructions、工具 / MCP schema、模型 / 服务商 / 运行时版本、hook 插入位置、技能索引绝对路径与缓存时效仍可能破坏共享前缀。不能承诺跨 agent、跨用户、跨机器或必然 KV 命中。

OpenAI 当前缓存文档进一步说明：要求完整渲染前缀相同，工具定义也在前缀内；共享稳定片段仍不等于有可复用的缓存断点。CLI 未暴露或未验证相应控制时，本工具只稳定自己贡献的内容，不设置或伪造服务商缓存断点。

## Agent 接入决策（核查于 2026-10-16）

本机只读核查：Codex CLI `0.162.1`、Claude Code `2.1.296`。以当时官方接口为依据，不能沿用“Codex 完全没有 hook”的旧结论。

额外本地协议核查：在独立临时 CODEX_HOME 中写入固定 developer_instructions，启动 `codex app-server --stdio`，仅执行 initialize / initialized / config/read（includeLayers=true），实际响应包含 config、origins、layers，并原样返回该固定指令。未创建 thread、未调用模型、未改真实配置；它证明有效配置读取途径可用，不代表包装器已实现或模型加载已验证。

Claude Code：SessionStart command hook 的 JSON stdin 包含 cwd/source，`hookSpecificOutput.additionalContext` 可注入上下文；当前文档说明首次响应等待 SessionStart 完成。通过 settings.json 合并一个归本工具所有的 hook，保留已有 hooks/settings。适配器也提供 `--append-system-prompt` 启动包装器以满足受控的首次加载；不要替换默认 system prompt。

Codex：官方现有 `hooks.json` 或 config.toml 内联 hook，SessionStart 的 additionalContext 是附加 developer context。非 managed hook 必须由用户在 `/hooks` 审阅信任当前定义，未信任会跳过；安装器不能伪造信任状态或宣称已运行。优先生成 `hooks.json` 安装计划，诚实提示首次启用步骤；提供 `-c developer_instructions=...` 包装器作为不依赖 hook 信任的启动方式，需保留已有 developer_instructions（无法可靠读取合并时拒绝覆盖并说明），不得使用 model_instructions_file 替换 agent 原始基础提示。

包装器需透传 argv、cwd、stdio、退出码和终止信号；不要拼接 shell 字符串启动 agent。必须处理用户传入改变 cwd / developer instructions / system prompt 等参数，不能计算目录 A 却启动目录 B。无法安全支持的冲突参数明确拒绝，避免静默产生错误模式。包装器与已安装 hook 同时存在时要有明确去重机制，不能重复注入。

hook 统一调用同一 npm 可执行文件，读 stdin cwd 后调用 resolver；不在 hooks 里联网同步。hook 出错要有 stderr 和失败状态；各 agent 对失败状态是否阻止首次请求的差异要如实记录，不能保证所有运行时 fail-closed。

安装默认预览，实际写入须明确 apply，支持指定 target root。仅管理自己创建的 skill 与 hook；已有文件应保留并合并，无可安全合并方式就报冲突。需要可回滚的安装记录或对称 uninstall，避免卸载他人内容。evoloop 标记的目标不应直接被本工具覆写，真实配置整合留用户选择；本次仅隔离验证，不执行用户机器 sync。

参考依据：

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)：发现位置、信任、SessionStart 与输出协议。
- [Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)：developer_instructions 等配置接口。
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)：SessionStart 执行时序、输入 / 输出及 settings 合并。
- [Claude Code Skills](https://code.claude.com/docs/en/skills)：skill 为按需机制，不能独自保证首轮推理前执行。
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)：完整渲染前缀、工具顺序、缓存断点与实际命中的限制。

## 阶段验收

hard 详细设计必须固定 JSON schema、CLI 命令与默认值、模块共享类型、文件所有权和任务依赖；先给契约，再派 standard。可简化实现技巧，不可删掉上述闭环或虚构 agent 能力。

standard 分离实现：配置 / 纯 resolver / 编译器；资源锁 / 下载 / 安全物化；CLI / 两个 adapter / 入口 skill。互不重叠文件并行，公共契约只能一人维护。交付必须构建、运行实际最小场景、仅提交各自文件。

白板 hard 最终验证应从用户需求、方案和实际输出独立找问题：在临时 HOME/config/target 和两个不同目录里验证显式 / 推断 / DAG / 稳定输出；本地与 Git 资源 frozen 复现；修改资源失配；缺锁离线失败；hook JSON；安装预览、合并、重复安装和卸载；包装器真实 argv/退出码行为；npm pack 从 tarball 使用且包含入口 skill。允许临时 fixture 和临时脚本，不向仓库新增测试代码。若不做真实付费模型调用，明确写出验证止于 CLI / hook 协议及启动参数，不声称实际模型 KV 命中。

验收后提交本项目，留必要验收记录。不发布 npm、不添加远端、不推送、不安装进真实用户环境。
