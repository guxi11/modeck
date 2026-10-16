# modup

<p align="center"><b>一份配置，按工作目录为 agent 选择 rules 和 skills。</b></p>

modup 是面向多项目、多 agent 工作流的 TypeScript CLI。你把规则和技能集中在自己的配置目录，用 mode 组合它们，再通过原生 `SessionStart` hook 注入会话。支持 Claude Code、Codex 和 CodeBuddy Code CLI。

```text
配置目录：rules + skills + modes
                ↓
业务目录：自动识别 / .modes 固定选择
                ↓
SessionStart → 规则正文 + 技能索引 → agent 会话
```

## 从源码开始

需要 Node.js 20+、npm，以及 macOS 或 Linux；克隆源码和读取 Git 资源还需要 Git。agent CLI 需单独安装。以下流程从仓库构建，不依赖 npm registry 上的同名包是否已发布。

克隆并安装 CLI：

```sh
git clone https://github.com/guxi11/modup.git
cd modup
npm ci
npm run build
npm install -g .
modup --version
```

版本输出应与 `package.json` 中的版本一致。全局安装目录需要对你可写。

1. 创建并进入独立的配置目录：

   ```sh
   mkdir -p "$HOME/.config/modup"
   cd "$HOME/.config/modup"
   ```

2. 初始化配置，选择并命名要导入的全局 rules 和 skills：

   ```sh
   modup init
   ```

   `init` 需要交互终端；可选择 `none` 从空配置开始。它生成 `modup.mjs` 和 `modep-auto.mjs`，将导入资源绑定到默认 `base` mode。初始化前可用 `modup init --list` 只读查看扫描结果。

   **导入会移动已选原生 skill 入口。** 确认导入并成功写入配置后，这些入口备份到配置目录的 `.modup/backups/批次/`，`restore.json` 记录原路径和备份路径，可按记录移回。未选资源、rules、evoloop 管理入口和配置真源保留。

3. 在配置目录绑定你使用的 agent；以 Claude Code 为例：

   ```sh
   modup bind --agent claude
   ```

   `--agent` 也接受 `codex` 或 `codebuddy`。绑定直接写入该 agent 的用户级 hook 配置；添加 `--dry-run` 可先预览。Codex 还需在 **`/hooks`** 中审查并信任 hook。

4. 验证目标业务目录的上下文：

   ```sh
   modup render --agent claude --cwd PROJECT_DIR
   ```

   将 `PROJECT_DIR` 换成已存在的业务项目路径。输出以 `# modup-context/1` 开头，并列出选中的 modes、规则正文和技能索引；这一步不启动模型。之后在同一业务目录启动原生 agent，新会话通过 hook 加载上下文。

## 按工作方式组织配置

mode 是一组资源名称的组合，可用 `extends` 继承其他 mode。`defaults` 始终参与选择，自动识别和 `.modes` 决定额外的 mode。

初始化把所有导入资源放进 `base`，并生成 `defaults: ['base']`，因此这些资源默认在所有目录加载。要按目录筛选，将业务资源的绑定从 `base` 移到 `prog` 等 mode，`base` 只保留通用资源；仅在 `prog` 再添加一次相同绑定不会缩小加载范围。

在配置目录编辑 `modup.mjs`；以下示例假设你已准备对应的规则文件与技能目录：

```js
export { default as auto } from './modep-auto.mjs';

export default {
  resources: {
    rules: { coding: 'rules/coding.md' },
    skills: { review: 'skills/review' },
  },
  defaults: ['base'],
  modes: {
    base: {},
    prog: { extends: ['base'], rules: ['coding'], skills: ['review'] },
  },
};
```

资源路径相对于配置目录。rule 指向 Markdown 文件；skill 指向包含 `SKILL.md` 的完整目录，保留其中的 `scripts/`、`references/` 和 `assets/`。将示例名称和路径换成你实际导入或创建的资源。

编辑 `modep-auto.mjs`，按目录特征选择已声明的 mode：

```js
export default ({ files, dependencies }) =>
  files.includes('package.json') || dependencies.includes('typescript')
    ? ['prog']
    : [];
```

`auto` 支持异步函数，收到 `cwd`、`boundary`、`files` 和 `dependencies`。文件列表与 `package.json` 依赖基于工作区边界收集；Git 项目以 worktree 根目录为边界，非 Git 目录以调用目录为边界。初始化生成的 `auto` 默认返回空数组。

需要固定选择时，在业务目录创建纯文本 `.modes`，用逗号或换行分隔 mode 名称：

```text
prog
```

非空 `.modes` 关闭本次自动识别，仍保留 `defaults` 和继承的 mode；缺失或空白时启用自动识别。查找从调用目录向上到工作区边界，最近的文件生效。

配置和 `auto` 是以你的本机权限执行的 JavaScript。只加载你信任的配置；worker 隔离模块缓存，不隔离权限。

## 了解加载边界

三种 agent 使用同一套 mode 解析与上下文编译逻辑，接入行为如下：

| 接入对象 | 绑定位置 | 使用前确认 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | 启用并允许执行 `SessionStart` hook |
| Codex | `~/.codex/hooks.json` | 在 `/hooks` 审查并信任 hook |
| CodeBuddy Code CLI | `~/.codebuddy/settings.json` | 使用支持 `SessionStart` 的 CLI |

rules 正文直接注入；skills 注入名称、描述、完整目录 `root` 和入口 `entry`，由 agent 按需读取。**技能索引不是原生技能注册，也不保证 `/skills` 中可见**；脚本不会因注入索引而自动执行。与 agent 原生技能同名的索引项会被过滤，避免重复提供。

本地资源在每次准备上下文时重新快照并校验。Git 资源先运行 `modup sync` 获取，之后 hook 使用本地缓存；用 `modup sync --update` 显式更新缓存。项目没有共享锁文件或 `--frozen` 模式；分享配置时，固定 Git commit 比浮动分支更便于复现，但不构成完整的可复现锁定机制。

modup 不改写业务项目的 `AGENTS.md` 或 `CLAUDE.md`。agent 原生全局和项目指令仍由 agent 加载；上下文稳定不等于模型缓存命中，也不保证模型遵循每条规则。

## 调试与移除绑定

在配置目录查看 mode 选择原因和资源计划：

```sh
modup resolve --cwd PROJECT_DIR
```

将 `PROJECT_DIR` 换成业务项目路径。需要检查编译文本、摘要和字节数时，运行：

```sh
modup render --agent claude --cwd PROJECT_DIR --format json
```

如果绑定指向不同配置目录，或要显式选择配置，在命令中添加 `--config CONFIG_DIR`，将 `CONFIG_DIR` 换成配置目录路径。

移除指定 agent 的 modup 绑定：

```sh
modup unbind --agent claude
```

解绑按所有权记录移除 modup 的 hook 与运行时，保留其他配置；它不删除你的资源目录，也不自动恢复初始化时备份的原生 skill 入口。受管文件或已修改的归属文件发生冲突时，命令报错并要求先处理冲突。

## 阅读实现与架构

源码按职责分层：

| 目录 | 职责 |
| --- | --- |
| `src/contracts/` | 共享类型、协议、错误和摘要 |
| `src/core/` | 配置校验、目录事实、mode 解析、上下文编译 |
| `src/resources/` | 本地与 Git 资源、内容寻址存储、完整性验证 |
| `src/integration/` | 上下文准备、hook、绑定计划与应用、进程启动 |
| `src/cli/` | 命令入口、初始化、迁移与终端交互 |
| `schemas/` | 配置与资源 manifest 的 JSON Schema |

模块边界、数据流、完整性约束与设计取舍见[架构设计](docs/architecture.md)。`design/` 保存历史方案与验收记录，具体行为以源码及架构设计中的现状说明为准。

修改源码后运行 `npm run typecheck`；交付 CLI 前运行 `npm run build`。`dist/` 由构建生成，不直接修改。
