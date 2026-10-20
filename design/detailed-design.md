# modeck 详细设计与配置参考

本文记录当前可用的配置和操作契约。整体数据流见 [架构设计](../docs/architecture.md)，取舍见 [架构决策](architecture.md)，首次使用见 [README](../README.md)。旧版 JSON 配置、`.mode`、`install/uninstall`、`run` 包装器和 `--frozen` 提案已从本文移除；它们不是当前接口，历史内容可从 Git 记录查阅。

## 契约入口

| 契约 | 维护位置 | 约束 |
| --- | --- | --- |
| 模式配置 | [config-file.ts](../src/core/config-file.ts)、[modes.schema.json](../schemas/modes.schema.json)、[types.ts](../src/contracts/types.ts) | `modeck.yaml` / `modeck.yml` 二选一；保留 rules / skills 分类 |
| 选择与编译 | [resolve.ts](../src/core/resolve.ts)、[compile.ts](../src/core/compile.ts) | 纯计算；顺序、过滤和摘要规则见架构文档 |
| Agent 协议 | [agents.ts](../src/contracts/agents.ts)、[hooks.ts](../src/integration/hooks.ts) | 原生事件、输入、输出和限额集中定义 |
| 插件 | [plugins.ts](../src/contracts/plugins.ts)、[src/plugins](../src/plugins/) | 固定完整 commit，动态资源与静态投影分开 |
| 静态 MCP | [mcp-static.ts](../src/contracts/mcp-static.ts)、[src/mcp](../src/mcp/) | 唯一中央源是 schemaVersion 2 JSON |

下文 `CONFIG_DIR` 为配置目录，`PROJECT_DIR` 为业务目录，`HOME` 为目标用户目录；使用命令前替换为实际路径。参数清单以各命令 `--help` 为准，本文不复制整份 help 输出。

## 模式与资源声明

YAML 的 `resources.rules` 和 `resources.skills` 分别将资源 ID 映射到本地相对路径或 `(use URL)/path`。规则是 Markdown 文件；技能是包含 `SKILL.md` 的完整目录，其 YAML frontmatter 必须有合法 `name` 和非空 `description`。完整目录的 scripts、references、assets 与可执行位共同参与内容校验。

`defaults` 声明始终加入的模式；`modes.<id>` 以 `extends`、`rules`、`skills`、`plugins` 数组组合父模式、资源和插件。未知引用、类型不匹配和循环继承拒绝加载；不支持旧版 `priority`、`detect` 或 skill `preload` 绑定。自动选择由独立 `modeck-auto.mjs` 完成。

`.modes` 是 UTF-8 纯文本，多名称以逗号或换行分隔。普通非空内容替代自动选择，`+` 前缀追加到自动结果；空白或仅 `+` 启用自动选择。默认模式与继承始终保留。最近文件生效，空白文件也会停止向父目录查找；查找不越过工作区边界。

## 外部资源

外部规则和技能都直接声明在 `modeck.yaml` 中，格式为 `资源名称: (use Git仓库地址)/仓库内路径`。rule 指向单个 Markdown 文件，skill 指向包含 `SKILL.md` 的目录。

下面以你自己的资源仓库为例；将 `your-org/agent-resources` 和仓库内路径替换为实际值：

```yaml
resources:
  rules:
    team-guide: (use https://github.com/your-org/agent-resources.git)/rules/team-guide.md
  skills:
    review: (use https://github.com/your-org/agent-resources.git)/skills/review
```

安装外部资源需要本机可用 Git。在配置目录运行：

```sh
modeck res init     # 安装新增资源，按锁恢复缺失内容
modeck res update   # 主动更新到远端默认分支的最新版本
```

`res init` 增量安装：没有锁记录的资源从仓库默认分支获取，已有且完整的资源跳过，缺失资源按 `modeck-lock.json` 中的 commit 和摘要恢复。`res update` 重新获取默认分支并更新锁记录。两个命令都输出逐项状态和数量汇总；本地内容被修改时会停止，避免覆盖。

安装目录按资源名称自动生成，保留规则与技能分类。上例对应：

```text
vendor/
  rules/
    team-guide.md
  skills/
    review/
      SKILL.md
modeck-lock.json
```

`/vendor/` 和 `/.modeck/` 会自动加入 `.gitignore`；`.modeck/` 存放本机状态、暂存和备份。共享 YAML 和根目录 `modeck-lock.json`，其他机器拉取配置后运行 `modeck res init`，即可安装相同的锁定版本。资源地址和路径留在 YAML，安装路径、commit 和摘要由工具维护。

会话启动时只读取并校验这些已安装资源，不自动下载或更新。修改资源来源后需再次运行 `res init`；已有 `.modeck/resources/` 安装会在校验后迁移到 `vendor/`，保留锁定版本，目标重名或本地修改会阻止迁移。移除声明不会删除本地目录。

## 插件声明与生命周期

插件包以完整 Git commit 固定，并与 mode 动态内容分开声明。`plugins` 的键是配置内 ID；`source.url` 和完整 40 位小写 SHA-1 `source.commit` 必填，`source.path` 可省略（默认仓库根），`agents` 可选且只接受 `claude`、`codex`。mode 用 `plugins` 引用这些 ID：

```yaml
plugins:
  team-tools:
    source:
      url: https://github.com/your-org/agent-plugins.git
      path: plugins/team-tools
      commit: 0123456789abcdef0123456789abcdef01234567
    agents: [claude, codex]
modes:
  prog:
    plugins: [team-tools]
```

所有子命令都必须显式提供 `--config CONFIG_DIR --agent <claude|codex> --target-home HOME --cwd PROJECT_DIR`，`--format text|json` 可选。`modeck plugin init` 按固定 commit 安装并校验包，写根目录 `modeck-plugins-lock.json`，内容在 `vendor/plugins/<id>/<treeDigest>/`；`/vendor/` 与 `/.modeck/` 忽略，锁文件跟踪。`status` 只读；`apply` 管理原生插件；`remove` 卸载本配置拥有的插件；`recover` 根据 journal 阶段处理未完成操作，不等同于普通卸载，也不删除无法证明归属的同名安装。升级时先 remove 原生安装，修改 pin 后运行 init，再 apply 新版本。

被 mode 选中的插件 skills/rules 作为动态资源参与上下文，skill 名称按插件命名空间处理。动态内容中的 `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 替换为锁定原包根，依赖 `${PLUGIN_DATA}` 或 `user_config` 的动态内容拒绝。多配置组合时资源身份以配置根限定，同名技能仅在内容等价时合并。commands、agents、hooks、LSP、MCP 等受支持的静态组件由 apply 经私有 marketplace 投影并调用原生命令安装；动态 skills/rules 从静态投影中移除，避免重复加载。当前仅支持 Claude Code 与 Codex 的 user scope，不写 project scope。Codex portable 插件的 hooks、apps、auth、依赖和不支持组件会被拒绝；Codex legacy hooks 保持原生 untrusted 状态，modeck 不授予信任。

每份注册配置使用独立 marketplace 名称；跨配置的原生插件名或 MCP 名称冲突会拒绝。动态内容在 SessionStart 时生效，原生插件变更需重启 session；均不热切换，也不构成权限隔离。journal 与原生指纹用于检查所有权和漂移；冲突时拒绝覆盖或删除。原生 CLI 不提供 compare-and-swap，检查和外部写入之间仍有竞态。

## 静态 MCP 配置与事务

MCP 使用独立的 `modeck-mcp.json`（`schemaVersion: 2`），与定义工作模式的 `modeck.yaml` / `modeck.yml` 分离。可跨 agent 表达的定义放在 `servers`；只针对某个 agent 的原生定义直接放在 `agents.claude.mcpServers` 或 `agents.codex.mcp_servers`。在大小、深度及关键字段形状校验允许的范围内，原生字段、可序列化扩展字段及 literal `args`、`env`、`headers` 按 JSON 值保留；这只保证配置可迁移和往返，不代表字段会被相应 agent 原生支持。`{ env: ENV_NAME }` 引用和 portable 编码限制仅适用于 `servers`，modeck 不读取环境变量实际值。Codex 原生定义写入 TOML 前会验证 TOML 往返可无损表示。

不同 agent 可使用相同 server 名；同一 agent 的 native 定义不能与 `servers` 中的 portable 定义重名。将条目追加到相应 agent 的原生映射后运行 `status` 检查计划，再运行 `apply` 写入；`servers` 或 `agents` 为空时可省略。`migrate` 遇到与 native 同名且语义等价的 portable 项时保留 portable 项并登记 native 来源；语义不同则拒绝冲突，不覆盖任一方。

中央配置仅接受 `modeck-mcp.json` 的 schemaVersion 2；`migrate` 从 agent 原生配置导入并写入该 JSON 文件。`--config` 接受配置目录或 `modeck-mcp.json`；`--target-home` 默认当前用户 home，`--cwd` 默认当前目录，目录必须已存在。TTY 文本模式可交互选择缺省 action、agent 和 scope；非 TTY 必须显式给出这些必要值。可用 `--format json` 输出结构化结果。

| 命令 | 用途与安全行为 |
| --- | --- |
| `mcp migrate` | 将原生定义按原样迁入 agent 专属 JSON，并登记成功迁入或匹配项的管理权；不改变原生文件字节。可部分成功，拒绝项的原生定义不改。匹配既有 portable 定义时保留它供其他 agent 使用并登记来源。即使没有新 native 项，也会创建 JSON；即使仅匹配，也会以事务将 JSON 权限收紧为 `0600`。 |
| `mcp status` | 只读检查当前配置并输出不含凭据值的 apply 计划；不写入或收紧文件权限。 |
| `mcp apply` | 增量合并中央定义；保留未受管项和已从中央移除的原生项，不自动删除。同名冲突、受管项漂移或端点身份变化会拒绝整批写入。匹配的未受管项不会自动接管，需先显式 `migrate`。 |
| `mcp recover` | 回滚中断且未提交的事务，或完成已提交事务的清理；必须使用原事务的 agent、scope、home、cwd 和配置路径。 |

当前支持范围：

| agent | scope 与原生目标 | 边界 |
| --- | --- | --- |
| Claude Code | `user`：`<home>/.claude.json`；`project`：`<cwd>/.mcp.json` | local 定义保留在原生配置。显式设置 `CLAUDE_CONFIG_DIR=<home>/.claude` 时，user 目标改为该目录内的 `.claude.json`。 |
| Codex CLI | 仅 `user`：`<home>/.codex/config.toml` | 只写默认用户配置；portable 定义不支持显式 SSE，且不能通过变量重命名物化凭据。原生 project 和独立 `*.config.toml` profile 不写入。 |
| CodeBuddy Code CLI | 暂不支持 | 候选文件优先级和共享项目文件需要独立适配。 |

Codex 的原生可见性范围限于未使用 `--profile` 或 `-c` / `--config` 覆盖的默认用户配置；独立 profile 会参与同名冲突检查，但不会同步。非默认 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 被拒绝。已有 `.mcp.json` 是共享原生文件；若新建它会遮蔽 CodeBuddy 已有的项目 `mcp.json`，操作会被拒绝。

pending journal 回滚尚未提交的变更，committed journal 只完成清理。写入使用可恢复事务，日志与原生文件暂存位于 Git 工作树外的私有 modeck 状态目录；拒绝跨文件系统的原子写入。ownership 来源、pending/committed journal 与 stale lock 的中央路径必须精确匹配当前 JSON；其他中央路径或缺少 staging inventory 的旧锁会安全拒绝，不自动清理或接管。recover 按原 agent、scope、home、cwd 与配置路径恢复。原生定义端点身份绑定并检查漂移；原子批次遇冲突整体拒绝，保留未管理项及中央已移除的项。macOS / Linux 上使用内核文件锁协调 modeck 命令，不支持锁时拒绝操作。执行 `migrate` / `apply` / `recover` 时应暂停原生配置命令和编辑器写入：漂移检查不能保证与外部写入者之间的原子比较和替换。检测到受管策略或相关审批设置时会拒绝操作，交由原生工具处理。

MCP 不参与 mode 选择、注册配置多源组合或 SessionStart hook，也不会随它们自动同步。`apply` 后通过原生 MCP 列表命令检查，并重启会话加载；不承诺热更新、连接或认证成功，原生策略、审批和认证仍由 agent 负责。退出码：`0` 完成、`2` 用法或配置错误、`3` I/O 失败、`4` 冲突 / 忙 / 需恢复、`6` 部分迁入。

## 绑定兼容边界

路径相对于 `--target-home`，默认使用本机 home。各 hook 文件位置见 [Hook 与启动适配](../docs/architecture.md#hook-与启动适配)；不能把 MCP 的 scope 或配置路径约束直接套用于 hook。

| Agent | 当前绑定检查与核验基线 |
| --- | --- |
| Qwen | 基线 v0.25.2；`QWEN_HOME` 必须解析为 `<home>/.qwen`。`<home>/.qwen/.env`、`<home>/.env` 声明该变量时拒绝绑定，包括 `export`、`=`、`: ` 写法，避免原生启动后改变配置位置。 |
| Qoder | 基线 1.1.73；可执行文件为 `qodercli`，`QODER_CONFIG_DIR` 只能指向 `<home>/.qoder`。 |
| Factory Droid | 最低 0.196.0；`FACTORY_HOME_OVERRIDE` 替换 home 基目录，CLI 再拼 `.factory`，因此只能等于目标 home。已有 hooks.json 未定义 SessionStart 时，若 settings.json 或 settings.local.json 定义该事件，拒绝新增以避免遮蔽。没有 hooks.json 时还拒绝带 hooks 的旧 settings 和旧 hooks/hooks.json，需先通过原生 `/hooks` 整理。 |
| GitHub Copilot | 最低 1.0.89；`COPILOT_HOME` 只能指向 `<home>/.copilot`。使用独立版本化 hook 文件，输出顶层 `additionalContext`。 |

Qwen / Qoder 的基线记录不保证所有旧版兼容。默认目录边界在计划和应用时均检查，不能只在预览时确认。旧入口 skill 仅在安装记录列为自有内容且整棵树校验未变时清理；用户手写的同名 skill 不接管。

参考入口：[Qwen hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)、[Qoder hooks](https://docs.qoder.com/cli/hooks)、[Droid hooks](https://docs.factory.ai/reference/hooks-reference)、[Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)。具体实现以 [install.ts](../src/integration/install.ts) 为核对依据。

## 配置管理与诊断

### 初始化与导入

`init` 创建配置；已有配置后用 `scan` 追加从 agent 用户目录发现的资源。`--list` 只输出发现结果的 JSON，不执行导入；实际导入时按提示选择资源，并在移动原生入口前确认变更和备份位置。

```sh
modeck init # 进入引导流程
modeck init --agent codex --config CONFIG_DIR --list
modeck init --agent codex --config CONFIG_DIR
modeck scan --agent claude --config CONFIG_DIR --list
modeck scan --agent claude --config CONFIG_DIR
```

`modeck init --help` 和 `modeck scan --help` 可查看各自支持的参数。

### 管理多份配置

注册目录后，通过 `config` 统一选择启用的配置和绑定的 agent。新注册的目录默认未启用；所有绑定的 agent 共用选中的配置集合，按注册顺序组合加载。

```sh
modeck register --config CONFIG_DIR
modeck config --list
modeck config --dry-run
modeck config
modeck unregister --config CONFIG_DIR
```

`config --list` 输出已注册目录、启用状态及各 agent 的绑定状态；`config --dry-run` 交互选择后输出变更计划和冲突，不应用变更。`unregister` 只移除注册，不删除配置目录。

需要脚本化管理时，`config --answers FILE` 读取 JSON 文件：`configs` 为要启用的已注册目录绝对路径数组，`agents` 为要绑定的 agent 标识数组。两项都必须提供，空数组表示不启用配置或不绑定 agent。先用 `modeck config --answers FILE --dry-run` 检查计划，再用 `modeck config --answers FILE --expect DIGEST` 应用，其中 `DIGEST` 替换为计划输出的 `planDigest`；计划变化时会拒绝应用。

### 排查模式选择

在业务项目目录运行 `modeck resolve`，展示最终模式、插件、规则、技能及选择原因。TTY 默认使用简洁文本，非 TTY 默认保留 JSON；用 `--format text|json` 显式指定格式。可指定业务目录，或指定单份配置单独排查：

```sh
modeck resolve
modeck resolve --cwd PROJECT_DIR
modeck resolve --config CONFIG_DIR --cwd PROJECT_DIR
```

省略 `--config` 时优先使用注册配置集合；尚未注册时回退到已有绑定，再尝试当前目录的配置。`resolve` 会准备并校验上下文，也会执行配置中的自动选择脚本；缺失外部资源需先运行 `res init`。

### 评估与保存自动选择

`eval` 忽略现有 `.modes`，只评估自动选择、默认模式和继承，并与实际选择比较；不安装资源或创建状态，但仍执行可信的自动选择脚本。`save` 将可忠实固定的结果写到 Git 根目录 `.modes`，非 Git 目录写到调用目录。已有文件先预览，覆盖需交互确认或 `--yes`；空结果、较近的选择器覆盖等无法忠实固定的情况拒绝写入。两者支持 `--config`、`--cwd`、`--state` 和 `--format text|json`。

### 更新与移除绑定

运行 `modeck config` 调整配置集合或取消 agent 绑定；`unregister` 只移除注册，不删除配置目录。升级 npm 包、源码或 Node 后重新运行 `config` 更新安装的 runtime。绑定只处理自身 hook 与 runtime，不等同于 `mcp recover` 或 `plugin recover`。
