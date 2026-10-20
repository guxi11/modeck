# modeck 架构决策

状态：随当前实现维护。本文说明设计取舍；运行架构见 [架构设计](../docs/architecture.md)，字段、命令与恢复契约见 [详细设计](detailed-design.md)。本轮整理不改变实现。

## 目标与系统边界

面向需要在多个 agent、项目和个人 / 团队配置之间复用规则与技能的用户。配置仓库维护资源与模式，业务项目提供目录事实及可选 `.modes`，modeck 负责选择、校验、编译和原生接入。技术基线是 Node.js 22.20.0+、TypeScript strict、ESM，支持 macOS / Linux。

核心闭环是初始化配置、声明模式、安装外部资源、预览上下文、注册并绑定 agent，再通过普通 Git 共享配置与锁。它不改写业务项目 `AGENTS.md` / `CLAUDE.md`，也不替代 agent 的工具权限、信任、认证或模型服务。

## 决策 1：声明配置与自动选择代码分开

**问题**：用户需要声明资源和组合方式，也需要根据不同项目决定工作模式。

**决定**：YAML 保存资源与模式，`modeck-auto.mjs` 单独接收目录事实并返回模式名称；业务项目的 `.modes` 仅为文本选择器。配置发现优先显式参数、注册集合和已有绑定，最后才尝试调用目录，避免业务仓库静默替换已信任入口。

**代价与边界**：自动选择在 Worker 中执行，隔离模块缓存并校验来源，但仍有本机用户权限；不是安全沙箱。只应注册可信配置。选择器不提供旧方案的禁用模式语法，默认模式和继承始终保留。

依据：[config-file.ts](../src/core/config-file.ts)、[auto.ts](../src/core/auto.ts)、[config.ts](../src/cli/config.ts)。

## 决策 2：模式组合保持有序、可解释

**问题**：自动检测、显式选择和继承同时存在时，输出需要可预测，排查时需要看到原因。

**决定**：默认模式、自动结果、显式追加依次构成种子，父模式按声明顺序先于子模式展开，再稳定去重；不依赖数字 priority。`resolve` 展示最终模式、资源和选择原因，`render` 只提供实际上下文。

**代价与边界**：非空 `.modes` 默认替代自动结果，`+` 才表示追加；最近的选择器生效。多配置中同名模式应用于各自声明它的配置，不跨配置继承；资源身份按配置根限定，同名技能内容不同则拒绝组合。

依据：[resolve.ts](../src/core/resolve.ts)、[prepare.ts](../src/integration/prepare.ts)。

## 决策 3：资源安装与会话读取分离

**问题**：会话启动需要避免隐式更新，同时让配置仓库能共享外部规则和完整技能目录。

**决定**：`res init` 按根目录资源锁安装或恢复，`res update` 显式更新默认分支；规则与技能分别安装到顶层 `vendor/rules/`、`vendor/skills/`。运行期读取并验证已安装内容，不拉取 Git。插件另用完整 commit pin 与独立包锁。

**代价与边界**：缺失内容先安装，漂移拒绝覆盖；缺失资源能否恢复取决于远端是否仍提供锁定 commit。内容摘要验证内容身份，不能证明作者可信。获取阶段不运行来源仓库安装命令或 skill 脚本，自动选择代码自身仍有联网能力。

依据：[repository.ts](../src/resources/repository.ts)、[git.ts](../src/resources/git.ts)、[bundle.ts](../src/plugins/bundle.ts)。

## 决策 4：规则正文与技能索引分开编译

**问题**：规则需要直接进入上下文，完整技能正文会占用预算且未必与当前任务有关。

**决定**：规则输出为正文，技能输出名称、描述和可读取的绝对 root / entry。支持已确认的原生名称过滤和规则文本去重；预算不足先缩短技能描述，再移除索引项，规则本身不截断。过滤与缩减均报告原因。

**代价与边界**：技能索引不是原生注册，不保证 agent 调用。正文稳定性只覆盖相同输入、安装路径、探测结果与预算条件；绝对技能路径会使不同机器输出不同。摘要不是模型服务端 cache key，不能证明缓存命中。

依据：[compile.ts](../src/core/compile.ts)、[native-skills.ts](../src/integration/native-skills.ts)。

## 决策 5：统一使用原生会话 hook

**问题**：不同 agent 的接入协议和信任机制不同，需要共享编译流程并保留原生行为。

**决定**：七种 agent 复用 prepare / compile，通过同步 SessionStart command hook 编码；不再提供 `run` 包装启动器、RunMarker 或入口 skill。Codex 信任由用户经原生界面授予。配置升级后重新绑定安装的 runtime 副本。

**代价与边界**：hook 禁用、阻止、失败或超时后，原生会话仍可能继续。modeck 不保证所有启动网络请求都等待 hook，也不保证模型实际采纳返回内容。新增 agent 必须核实发现路径、事件、输入输出和版本，不能只生成 JSON 即宣称接入成功。

依据：[agents.ts](../src/contracts/agents.ts)、[hooks.ts](../src/integration/hooks.ts)、[install.ts](../src/integration/install.ts)。

## 决策 6：动态插件内容与静态原生状态分开

**问题**：技能和规则适合随工作模式组合，原生 commands、agents、hooks、LSP、MCP 等组件有独立安装和加载生命周期。

**决定**：锁定完整插件包，从选中模式提取动态 skills/rules；受支持静态组件物理投影到配置私有 marketplace，再调用原生 CLI 安装。独立静态 MCP 则仅以 schemaVersion 2 JSON 为中央配置，portable 与各 agent 原生定义分开保存。

**代价与边界**：插件和静态 MCP 当前只支持 Claude / Codex 的指定 scope；原生变更需重启会话，不热切换。配置命名空间不能隔离原生全局同名插件或 MCP，冲突必须拒绝。保留原生字段不代表 agent 支持它们，Codex MCP 写入还需 TOML 往返校验。

依据：[projection.ts](../src/plugins/projection.ts)、[manage.ts](../src/plugins/manage.ts)、[config.ts](../src/mcp/config.ts)。

## 决策 7：按子系统给出恢复承诺

**问题**：hook 文件合并、原生 CLI 插件操作和多文件 MCP 提交拥有不同的写入机制，不能用一个“原子事务”概括。

| 子系统 | 当前保障 | 仍存在的限制 |
| --- | --- | --- |
| Hook 绑定 | 计划摘要、所有权、锁、逐文件原子替换、可捕获异常逆序回滚 | 多文件与多 agent 非整体原子；无崩溃自动恢复 |
| 插件生命周期 | journal 阶段、包摘要、原生 inventory 指纹及恢复命令 | 原生 CLI 无 CAS，检查与外部写入之间仍有竞态 |
| 静态 MCP | 内核锁、pending/committed journal、身份与漂移复核、恢复命令 | 不与编辑器或原生写入者形成 CAS；跨文件系统原子写入拒绝 |

所有权证据不足或内容漂移时拒绝覆盖和删除；恢复不能接管其他中央路径或未知安装。具体 journal、权限和 scope 约束集中维护于 [详细设计](detailed-design.md)。

## 决策 8：暂不实现 Claude 路径延迟注入

早期评估过用 `PreToolUse` 根据路径延迟加载规则。它会新增路径匹配、会话去重、并发、compact / resume 后失效等状态，也无法让模型依据当前工具返回的新上下文重新决定已发出的写入或并行调用。Bash 任意脚本的文件访问也不能可靠枚举。

当前保留跨 agent SessionStart 编译；需要 Claude 原生路径语义的规则保留在项目 `.claude/rules/`，扫描迁移时保留其原生入口，并避免同时选入 modeck 导致重复或全量加载。编译器不会解释 rule frontmatter 的路径语义。

## 已替代的早期方案

| 早期提案 | 当前契约 |
| --- | --- |
| `modes.json`、`modes.lock.json`、JSON `.mode` | YAML、根目录 `modeck-lock.json`、文本 `.modes` |
| priority / detect、禁用父模式、skill preload | 有序继承、自动选择脚本、规则正文与按需技能索引 |
| 仅 Claude / Codex，Node.js 20+ | 七种上下文适配器，Node.js 22.20.0+ |
| install / uninstall 与 run 包装器双路径 | `config` 管理原生 hook 绑定 |
| frozen 同步与跨机器字节一致 | init 按锁恢复、update 显式更新；稳定性受绝对路径与原生探测影响 |
| MCP YAML / v1 自动兼容 | 唯一 schemaVersion 2 JSON；不接管旧来源或不完整旧锁 |

早期 schema 全文、包装器参数白名单和阶段派工记录保留在 Git 历史，不再作为本地文档中的第二套契约。未来可能补充的严格离线开关、hook 崩溃恢复与受限脚本接口均尚未实现。
