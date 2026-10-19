<p align="center">
  <img src="assets/logo.svg" width="480" alt="modeck：按工作方式组合规则和技能">
</p>

<p align="center">
  <strong>多 agent 的配置与技能分散、切换项目还要反复整理？modeck 集中管理多套规则、技能和外部资源，并按项目自动组合，在 agent 启动时预先注入上下文。</strong>
</p>

<p align="center">
  <a href="assets/comparison.png"><img src="assets/comparison-share.svg" width="100%" alt="modeck 工作方式对比：原生 CC/Codex 的全局和项目资源分别维护；个人与团队配置统一组织规则、技能、外部资源和工作模式，通过原生 SessionStart hook 为七种 agent 注入上下文。"></a>
</p>

## 安装

需要 Node.js 22.20.0+ 和你要使用的 agent CLI。通过 npm 全局安装：

```sh
npm install -g modeck
modeck --version
```

当前支持 **Claude Code**（`claude`）、**Codex CLI**（`codex`）、**CodeBuddy Code CLI**（`codebuddy`）、**Qwen Code CLI**（`qwen`）、**Qoder CLI**（`qoder`）、**Factory Droid**（`droid`）和 **GitHub Copilot CLI**（`copilot`，需 1.0.89 或更新版本）。七种 agent 绑定时均通过原生同步 `SessionStart` command hook 注入上下文；Rulesync 在隔离目录转换 hook 配置，并校验合并结果。

| Agent | 原生 hook 接入 |
| --- | --- |
| Qwen Code CLI | [Hooks 文档](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)；项目设置位于 `.qwen/settings.json`。核验基线：v0.25.2（[官方发布](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.2)）；不据此保证所有旧版兼容，旧版本的 hook timeout 行为也有差异。 |
| Qoder CLI | [Hooks 文档](https://docs.qoder.com/cli/hooks)；项目设置位于 `.qoder/settings.json`。核验基线：官方发行版 1.1.73（[发行说明](https://docs.qoder.com/release-notes/qoder-cli)）；不据此保证所有旧版兼容。 |
| Factory Droid | [Hooks 文档](https://docs.factory.ai/reference/hooks-reference)；需 CLI 0.196.0+，此版本修复 `SessionStart` 上下文丢弃；写入 `~/.factory/hooks.json` 的原生顶层事件映射。可能遮蔽原有声明的混合配置会被拒绝；请先整合到原生 `hooks.json` 再绑定。 |
| GitHub Copilot CLI | [Hooks 文档](https://docs.github.com/en/copilot/reference/hooks-reference)；本项目要求 CLI 1.0.89+。1.0.88 已合并多个 hook 的 `additionalContext` 修复，本项目采用更保守的版本下限；使用独立 `~/.copilot/hooks/modeck.json`，hook 输出顶层 `additionalContext`。[官方 changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) |

Qwen、Qoder、Factory Droid 和 Copilot 的绑定仅支持默认用户配置位置（相对于 `--target-home` 的 `.qwen`、`.qoder`、`.factory` 和 `.copilot`）。Qwen 的 `QWEN_HOME` 可重定向 settings，且可能由用户 `.env` 在启动时引导；设置了重定向或无法确认仍使用默认位置时，不在支持范围内。Qoder 的 `QODER_CONFIG_DIR` 或 Copilot 的 `COPILOT_HOME` 指向其他目录时也不受支持。Droid 的 `FACTORY_HOME_OVERRIDE` 会替换 HOME 基础目录，再由 CLI 在其下拼接 `.factory`；非默认 override 不受支持。请恢复默认目录，或按 agent 的原生机制在实际生效的配置位置另行配置 hook。

这条注入路径在同步 `SessionStart` hook 启用并成功执行时，会在主会话首轮推理前返回上下文；不承诺屏障覆盖启动阶段的辅助模型、鉴权或其他网络请求。agent 设置禁用 hook、策略阻止执行、hook 未触发、命令失败或超时时，原生会话仍可能继续而没有 mode 内容；modeck 不承诺 fail-closed。我们尚未进行登录状态下的真实模型请求验证，因此不保证模型实际采纳内容。

工作模式仍按项目动态选择，会话加载规则正文和按需读取的技能索引。配置格式与原生 hook 接入方式因 agent 而异。

## 初始化并启用配置

1. 创建并进入配置目录，导入你选中的规则和技能：

   ```sh
   mkdir agent-config
   cd agent-config
   modeck init
   ```

   按提示选择 agent 和资源。初始化生成 `modeck.yaml` 和 `modeck-auto.mjs`；移动原生入口前展示变更与备份位置，受管或共享入口保留。

2. 注册配置, 支持注册多份配置：

   ```sh
   modeck register
   ```

3. 选择启用的配置和绑定的 agent：

   ```sh
   modeck config
   ```

   modeck 安装 SessionStart hook，保留其他工具的 hook。使用 Codex 时，在 `/hooks` 中审查并信任安装的定义；绑定本身不授予信任。

4. 预览会话上下文：

   ```sh
   cd path-to-target-project
   modeck render
   ```

   选择一个 agent 后输出规则正文和技能索引，不附带内部 ID。非交互调用需指定 `--agent <claude|codex|codebuddy|qwen|qoder|droid|copilot>`。Claude Code、Codex 和 CodeBuddy 按各自原生扫描结果省略同名技能；新增的 Qwen、Qoder、Factory Droid 和 Copilot CLI 保留完整技能索引，避免原生扫描差异造成漏注入。之后在该目录启动所选 agent，会话通过 hook 加载上下文。

## 组合工作模式

在 `modeck.yaml` 中声明资源，再通过资源名称组合 mode。本地资源写相对路径，外部资源写 `(use 仓库地址)/仓库内路径`：

```yaml
resources:
  rules:
    coding: rules/coding.md
  skills:
    review: skills/review
    technical-documentation: (use https://github.com/wondelai/skills.git)/technical-documentation
defaults: [base]
modes:
  base: {}
  prog:
    extends: [base]
    rules: [coding]
    skills: [review]
  doc:
    extends: [base]
    skills: [technical-documentation]
```

示例中的 `coding` 和 `review` 对应配置目录里已有的本地文件或目录；`technical-documentation` 从外部仓库安装。保存配置后，在配置目录运行 `modeck res init`，再在业务项目的 `.modes` 中选择 `prog`、`doc` 或组合使用。

rule 是 Markdown 文件，skill 是包含 `SKILL.md` 的完整目录。`defaults` 始终加载，`extends` 可复用其他 mode；`modes` 可定义多个工作模式，并通过继承组合规则与技能。初始化导入的资源默认归入 `base`；将只用于编程的资源移入 `prog`，才能按需加载。

自动选择脚本 `modeck-auto.mjs` 接收目录、文件和依赖等工作区事实，默认导出函数并返回已声明的 mode 名称。初始化生成的函数返回空数组。

需要固定某个项目的工作模式时，在业务目录创建纯文本 `.modes`，可指定多个 mode：

```text
prog,doc,web
```

多个名称用逗号或换行分隔。非空 `.modes` 中的多个 mode 会组合加载，并保留默认 mode 和继承关系；缺失或空白时使用自动选择。

## 管理外部资源

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

## 静态 MCP 集中管理

MCP 使用独立的 `modeck-mcp.json`（`schemaVersion: 2`），与定义工作模式的 `modeck.yaml` / `modeck.yml` 分离。可跨 agent 表达的定义放在 `servers`；只针对某个 agent 的原生定义直接放在 `agents.claude.mcpServers` 或 `agents.codex.mcp_servers`。原生字段、扩展字段及 literal `args`、`env`、`headers` 按 JSON 值保留；这只保证配置可迁移和往返，不代表字段会被相应 agent 原生支持。`{ env: ENV_NAME }` 引用和 portable 编码限制仅适用于 `servers`，modeck 不读取环境变量实际值。Codex 原生定义写入 TOML 前会验证 TOML 往返可无损表示。

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

写入使用可恢复事务，日志与原生文件暂存位于 Git 工作树外的私有 modeck 状态目录；拒绝跨文件系统的原子写入。迁移与写入兼容既有同目录 ownership 来源记录、pending/committed journal 和 stale locks；recover 按原 agent、scope、home、cwd 与配置路径恢复。原生定义端点身份绑定并检查漂移；原子批次遇冲突整体拒绝，保留未管理项及中央已移除的项。macOS / Linux 上使用内核文件锁协调 modeck 命令，不支持锁时拒绝操作。执行 `migrate` / `apply` / `recover` 时应暂停原生配置命令和编辑器写入：漂移检查不能保证与外部写入者之间的原子比较和替换。检测到受管策略或相关审批设置时会拒绝操作，交由原生工具处理。

MCP 不参与 mode 选择、注册配置多源组合或 SessionStart hook，也不会随它们自动同步。`apply` 后通过原生 MCP 列表命令检查，并重启会话加载；不承诺热更新、连接或认证成功，原生策略、审批和认证仍由 agent 负责。退出码：`0` 完成、`2` 用法或配置错误、`3` I/O 失败、`4` 冲突 / 忙 / 需恢复、`6` 部分迁入。

## 命令介绍

运行 `modeck --help` 查看命令总览，当前输出如下：

```text
Usage: modeck <command> [options]

Commands:
  res <init|update>  Manage external resources
  init                   Initialize configuration
  scan                   Import resources from agent homes
  migrate                Migrate existing configuration
  mcp <migrate|apply|status|recover>  Manage static native MCP configuration
  eval                   Evaluate automatic modes
  save                   Save automatic modes to .modes
  resolve                Resolve context
  render                 Render context
  hook                   Handle agent session hooks
  register               Register a configuration
  unregister             Unregister a configuration
  config                 Manage registered configurations

Options:
  -h, --help              Show help
  -v, --version           Show version
```

以下命令中的 `CONFIG_DIR` 是配置目录，`PROJECT_DIR` 是业务项目目录，运行前替换为实际路径。agent 标识为 `claude`、`codex`、`codebuddy`、`qwen`、`qoder`、`droid` 或 `copilot`。

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

### 安装与更新资源

`res` 操作指定配置目录中的外部资源；省略 `--config` 时使用当前目录。在多份配置之间切换时建议明确指定目录。

```sh
modeck res init --config CONFIG_DIR
modeck res update --config CONFIG_DIR
modeck res --help
```

`res init` 按声明和 `modeck-lock.json` 同步资源：已有资源校验后跳过，缺失内容按锁定 commit 恢复，新增声明首次安装并加入锁。确实需要升级远端版本时用 `res update`，并审查、共享更新后的锁文件。

### 排查 mode 选择

在业务项目目录运行 `modeck resolve`，输出解析计划的 JSON，包括最终 mode、选中的资源、选择原因和诊断信息。可指定业务目录，或指定单份配置单独排查：

```sh
modeck resolve
modeck resolve --cwd PROJECT_DIR
modeck resolve --config CONFIG_DIR --cwd PROJECT_DIR
```

省略 `--config` 时优先使用注册配置集合；尚未注册时回退到已有绑定，再尝试当前目录的配置。`resolve` 会准备并校验上下文，也会执行配置中的自动选择脚本；缺失外部资源需先运行 `res init`。

## 调整或移除绑定

运行 `modeck config`，取消勾选需要解绑的 agent，或调整启用的配置。移除目录注册使用 `modeck unregister --config CONFIG_DIR`，将 `CONFIG_DIR` 替换为配置目录路径；已绑定的旧式单目录配置需先通过 `modeck config` 更新绑定。

源码升级后重新运行 `modeck config`，更新 hook 使用的运行时副本。

[架构设计](docs/architecture.md) · [参与开发](CONTRIBUTING.md)
