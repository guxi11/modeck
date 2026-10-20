<p align="center">
  <img src="assets/logo.svg" width="480" alt="modeck：按工作方式组合规则和技能">
</p>

# modeck

<p align="center">
  <strong>集中管理多套 agent 配置，按项目组合规则与技能。</strong><br>
  基于 TypeScript 的 CLI，通过原生 SessionStart hook 加载当前工作模式。
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.20.0-339933?style=flat-square" alt="Node.js >=22.20.0"></a>
  <a href="#支持的-agent"><img src="https://img.shields.io/badge/agents-7-blue?style=flat-square" alt="支持 7 种 agent"></a>
</p>

<p align="center">
  <a href="assets/comparison.png"><img src="assets/comparison-share.svg" width="100%" alt="工作方式对比：个人与团队配置统一组织规则、技能、外部资源和工作模式，通过原生 SessionStart hook 为七种 agent 注入上下文。"></a>
</p>

## 快速开始

需要 Node.js 22.20.0+、macOS / Linux 和要使用的 agent CLI；Git 用于工作区边界探测及外部资源安装。

```sh
npm install -g modeck
mkdir agent-config
cd agent-config
modeck init
modeck register
modeck config
```

`init` 引导导入规则与技能，生成 `modeck.yaml` 和 `modeck-auto.mjs`；移动原生入口前展示变更与备份位置，受管或共享入口保留。`register` 注册配置，`config` 选择启用的配置和绑定的 agent。使用 Codex 时，还需在 `/hooks` 中审阅并信任安装的定义。

之后在业务项目目录启动所选 agent，会话通过 hook 加载上下文。预览实际正文可运行 `modeck render --agent codex`，排查选择原因可运行 `modeck resolve`。

## 一份配置覆盖哪些工作

| 管理方式 | 原生配置分别维护 | 使用 modeck |
| --- | --- | --- |
| 上下文接入 | 各 agent 维护自己的入口 | 同一编译流程适配 7 种 agent |
| 选择工作方式 | 手动整理当前规则和技能 | 自动选择或用 `.modes` 组合多个模式 |
| 个人与团队配置 | 各入口分别引用 | 多份配置按注册顺序组合 |
| 原生插件与静态 MCP | 由各 agent 管理 | 为 Claude / Codex 提供独立管理流程 |

以上是能力对比，没有性能或模型效果基准。modeck 稳定自己输出的内容，不保证模型服务端缓存命中。

## 看完就能调整配置

- rule 是 Markdown 文件，随模式加载正文；skill 是完整目录，会话先加载索引，匹配任务后再读 `SKILL.md`。
- `defaults` 始终加载，`extends` 复用父模式；只在编程时需要的资源放入 `prog`，避免留在默认模式。
- 业务项目的 `.modes` 写 `prog,doc` 可固定组合；写 `+doc` 则在自动选择后追加 `doc`。
- 外部资源在配置目录运行 `modeck res init` 安装，运行期校验已安装内容，不自动下载或更新。
- `modeck config` 调整配置或解绑 agent；升级 modeck 或 Node 后重新运行它，更新 hook 的 runtime 副本。

## 声明工作模式

`modeck.yaml` 中保留 rules / skills 分类，本地路径相对配置目录。以下配置要求已有 `rules/coding.md` 和 `skills/review/SKILL.md`：

```yaml
resources:
  rules:
    coding: rules/coding.md
  skills:
    review: skills/review
defaults: [base]
modes:
  base: {}
  prog:
    extends: [base]
    rules: [coding]
    skills: [review]
```

在业务项目的 `.modes` 中写入 `prog` 即可固定选择。没有 `.modes` 或内容为空白时，使用 `modeck-auto.mjs` 的自动选择结果；初始化生成的函数返回空数组。

外部资源声明使用 `资源名称: (use Git仓库地址)/仓库内路径`，同样直接写在 `resources.rules` / `resources.skills`。安装内容位于 `vendor/rules/`、`vendor/skills/`；提交 YAML 和根目录 `modeck-lock.json`，忽略 `/vendor/` 与 `/.modeck/`。[完整安装与更新语义](design/detailed-design.md#外部资源)。

## 支持的 agent

七种 agent 均通过原生同步 SessionStart command hook 接入；Rulesync 在隔离目录转换 hook 配置并校验合并结果。

| Agent | 可执行文件 | 接入边界 |
| --- | --- | --- |
| Claude Code | `claude` | 合并用户 settings 中的 SessionStart hook |
| Codex CLI | `codex` | 写入用户 hooks.json；安装不授予信任 |
| CodeBuddy Code CLI | `codebuddy` | 使用原生 hook；事件无 cwd 时取 hook 进程工作目录 |
| Qwen Code CLI | `qwen` | 核验基线 v0.25.2，旧版不在该基线覆盖范围 |
| Qoder CLI | `qodercli` | 核验基线 1.1.73，旧版不在该基线覆盖范围 |
| Factory Droid | `droid` | 要求 0.196.0+；拒绝可能遮蔽既有 hook 的配置 |
| GitHub Copilot CLI | `copilot` | 要求 1.0.89+；使用独立 modeck hook 文件 |

Qwen、Qoder、Droid、Copilot 的自动绑定仅支持默认用户配置目录；环境变量重定向和 Qwen `.env` 引导有额外限制，见 [绑定兼容边界](design/detailed-design.md#绑定兼容边界)。Claude / Codex / CodeBuddy 会省略原生同名技能索引，其余四种保留；超出 agent 输出预算时，技能索引仍可能缩减，见 [编译与输出预算](docs/architecture.md#输出预算与可观察降级)。

hook 启用且成功执行时，在主会话首轮推理前返回上下文；被禁用、阻止、未触发、失败或超时后，会话仍可能继续而没有模式内容。不保证阻止无上下文的会话，也不保证模型实际采纳；验证范围见 [Hook 与启动适配](docs/architecture.md#hook-与启动适配)。

## 项目全景

```text
配置仓库 + 项目事实 → 选择模式 → 校验资源 → 规则正文与技能索引 → 原生会话 hook
```

## 插件与静态 MCP

插件包固定完整 Git commit：模式选择其中的动态 skills/rules，`modeck plugin` 独立管理原生静态组件。静态 MCP 使用独立 schemaVersion 2 `modeck-mcp.json`，不随模式、配置集合或 hook 自动同步。两者当前仅管理 Claude / Codex，具体 scope、冲突与恢复限制见 [详细设计](design/detailed-design.md#插件声明与生命周期) 和 [MCP 契约](design/detailed-design.md#静态-mcp-配置与事务)。

## 文档

- [架构设计](docs/architecture.md)：模块边界、上下文流水线、完整性与 hook 绑定。
- [架构决策](design/architecture.md)：选择、资源、接入和事务设计的取舍。
- [详细设计与配置参考](design/detailed-design.md)：资源、插件、MCP、注册与诊断。
- [参与开发](CONTRIBUTING.md)：开发环境与提交检查。

<p align="center">
  <a href="https://guxi11.com/modeck/">官网</a> · <a href="docs/architecture.md">技术方案</a>
</p>
