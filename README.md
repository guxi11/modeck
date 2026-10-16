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
  res <add|init|update>  Manage external resources
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

在 `modeck.yaml` 中，使用你实际导入的资源名称和相对路径组织 mode：

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
    rules: [coding]
    skills: [review]
```

rule 是 Markdown 文件，skill 是包含 `SKILL.md` 的完整目录。`defaults` 始终加载，`extends` 可复用其他 mode。初始化导入的资源默认归入 `base`；将只用于编程的资源移入 `prog`，才能按需加载。

自动选择脚本 `modeck-auto.mjs` 接收目录、文件和依赖等工作区事实，默认导出函数并返回已声明的 mode 名称。初始化生成的函数返回空数组。

需要固定某个项目的工作方式时，在业务目录创建纯文本 `.modes`：

```text
prog
```

多个名称用逗号或换行分隔。非空 `.modes` 替代自动选择，并保留默认 mode 和继承关系；缺失或空白时使用自动选择。

## 管理外部资源

在配置目录添加一个 Git 仓库中的 skill：

```sh
modeck res add \
  --url https://github.com/wondelai/skills.git \
  --path technical-documentation \
  --target resources/technical-documentation
```

命令下载完整目录，在 `modeck-resources.json` 记录 commit 和摘要，并将目标加入 `.gitignore`。把目标路径登记到 `modeck.yaml` 的 `resources.skills`，再将名称加入需要的 mode，才会加载。`modeck res init` 按清单还原资源，`modeck res update` 更新资源；本地内容有修改时拒绝覆盖。

## 调整或移除绑定

运行 `modeck config`，取消勾选需要解绑的 agent，或调整启用的配置。移除目录注册使用 `modeck unregister --config CONFIG_DIR`，将 `CONFIG_DIR` 替换为配置目录路径；已绑定的旧式单目录配置需先通过 `modeck config` 更新绑定。

源码升级后重新运行 `modeck config`，更新 hook 使用的运行时副本。

[架构设计](docs/architecture.md) · [参与开发](CONTRIBUTING.md)
