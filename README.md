<p align="center">
  <img src="assets/logo.svg" width="480" alt="modeck：按工作方式组合规则和技能">
</p>

# modeck

**让 Claude Code、Codex 和 CodeBuddy 随项目切换规则和技能。**

modeck 是一个 TypeScript CLI。把 rules、skills 组成命名的 mode，在原生 agent 的会话开始时加载；共享配置集中维护，业务项目只需一个可选的 `.modes` 文本文件。

<p align="center">
  <img src="https://img.shields.io/badge/agents-3-173B35?style=flat-square" alt="支持 3 种 agent">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-173B35?style=flat-square" alt="Node.js 20 或更高版本">
</p>

终端入口提供资源、配置和会话命令，运行 `modeck --help` 可查看：

```text
Usage: modeck <command> [options]

Commands:
  res <init|update>  Manage external resources
  init                   Initialize configuration
  scan                   Import resources from agent homes
```

## 从源码安装

需要 Node.js 20+、npm、Git、macOS 或 Linux，以及你要使用的 agent CLI。在终端构建并链接源码：

```sh
git clone https://github.com/guxi11/modeck.git
cd modeck
npm ci
npm run build
npm link
modeck --version
```

## 初始化并启用配置

1. 创建并进入配置目录，导入你选中的规则和技能：

   ```sh
   mkdir agent-config
   cd agent-config
   modeck init
   ```

   按提示选择 agent 和资源。初始化生成 `modeck.yaml` 和 `modeck-auto.mjs`；移动原生入口前展示变更与备份位置，受管或共享入口保留。

2. 注册这个目录：

   ```sh
   modeck register
   ```

   注册只加入目录清单。你可以分别注册多份配置。

3. 选择启用的配置和绑定的 agent：

   ```sh
   modeck config
   ```

   modeck 安装 SessionStart hook，保留其他工具的 hook。使用 Codex 时，在 `/hooks` 中审查并信任安装的定义；绑定本身不授予信任。

4. 进入业务项目目录，预览会话上下文：

   ```sh
   modeck render --agent codex
   ```

   输出规则正文和技能索引。之后在该目录启动原生 agent，会话通过 hook 加载选中的配置。

## 组合工作方式

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

rule 是 Markdown 文件，skill 是包含 `SKILL.md` 的完整目录。`defaults` 始终加载，`extends` 可复用其他 mode。初始化导入的资源默认归入 `base`；将只用于编程的资源移入 `prog`，才能按需加载。

自动选择脚本 `modeck-auto.mjs` 接收目录、文件和依赖等工作区事实，默认导出函数并返回已声明的 mode 名称。初始化生成的函数返回空数组。

需要固定某个项目的工作方式时，在业务目录创建纯文本 `.modes`：

```text
prog
```

多个名称用逗号或换行分隔。非空 `.modes` 替代自动选择，并保留默认 mode 和继承关系；缺失或空白时使用自动选择。

## 管理外部资源

外部规则和技能都直接声明在 `modeck.yaml` 中，格式为 `资源名称: (use Git仓库地址)/仓库内路径`。rule 指向单个 Markdown 文件，skill 指向包含 `SKILL.md` 的目录。

下面以你自己的资源仓库为例；将 `your-org/agent-resources` 和仓库内路径替换为实际值：

```yaml
resources:
  rules:
    team-guide: (use https://github.com/your-org/agent-resources.git)/rules/team-guide.md
  skills:
    review: (use https://github.com/your-org/agent-resources.git)/skills/review
defaults: [base]
modes:
  base:
    rules: [team-guide]
    skills: [review]
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

## 调整或移除绑定

运行 `modeck config`，取消勾选需要解绑的 agent，或调整启用的配置。移除目录注册使用 `modeck unregister --config CONFIG_DIR`，将 `CONFIG_DIR` 替换为配置目录路径；已绑定的旧式单目录配置需先通过 `modeck config` 更新绑定。

源码升级后重新运行 `modeck config`，更新 hook 使用的运行时副本。

[架构设计](docs/architecture.md) · [参与开发](CONTRIBUTING.md)
