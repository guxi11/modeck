# modup

<p align="center"><b>让工作目录决定 agent 加载哪些 rules 和 skills。</b></p>

借鉴 Emacs modes：把编程、运维、写作等工作方式组合成 mode，在自己的配置仓库里统一管理，再用业务项目中的一个 `.modes` 文件选择。modup 是基于 TypeScript 的 CLI，目前运行于 macOS / Linux、Node.js 20+，需要 Git。

业务目录中的选择与渲染结果（输出节选）：

```text
$ cat .modes
prog,ops
$ modup render --agent claude
# modup-context/1
agent: claude
…
modes: ["prog","ops"]

## rule prog-rules

Prefer small, composable functions.
```

`工作目录/.modes → 配置仓库 → rules + skills → 会话上下文`

## 从源码开始

在 modup 源码根目录执行。npm 包名为 `modup`；这里使用源码构建流程，不假定 npm 上已经发布。

```sh
npm ci
npm run build
npm link
modup --help
```

modup 补充 agent 的原生全局与项目配置：原生配置仍由 agent 加载，modup 负责注入所选 mode 的上下文。业务项目不用复制整套 rules 和 skills，也不用安装入口 skill。

## 一个配置仓库，一个选择文件

先创建配置仓库；目标目录必须尚不存在：

```sh
export MODUP_CONFIG="$HOME/aiconfig"
modup init --dir "$MODUP_CONFIG"
```

`init` 会创建 Git 仓库、`modup.config.mjs` 和 `auto.mjs`。以下命令加入两条规则：

```sh
mkdir -p "$MODUP_CONFIG/rules"
printf '%s\n' 'Prefer small, composable functions.' > "$MODUP_CONFIG/rules/prog.md"
printf '%s\n' 'Confirm the target environment before changing infrastructure.' > "$MODUP_CONFIG/rules/ops.md"
```

将配置仓库中的 `modup.config.mjs` 改为：

```js
export { default as auto } from './auto.mjs';

export default {
  schemaVersion: 1,
  defaults: [],
  modes: {
    prog: { rules: ['prog-rules'] },
    ops: { rules: ['ops-rules'] },
  },
  resources: {
    'prog-rules': {
      kind: 'rule', source: { type: 'local', path: 'rules/prog.md' },
    },
    'ops-rules': {
      kind: 'rule', source: { type: 'local', path: 'rules/ops.md' },
    },
  },
};
```

然后在业务项目根目录执行；`render` 只查看将注入的文本，不启动模型：

```sh
printf '%s\n' 'prog,ops' > .modes
modup resolve
modup render --agent claude
```

配置路径也可用 `--config <dir>` 指定。未指定时默认为 `~/.config/modup`；状态目录默认为 `~/.local/share/modup/v1`，可用 `MODUP_STATE` 或 `--state` 修改，必须位于配置仓库之外。

## mode 怎么叠加

- `.modes` 用逗号或换行列出 mode ID；从当前目录向上查找，到 Git 工作区根目录为止，采用最近的一份。非 Git 目录只查当前目录。
- 没有选择文件时启用自动检测；`prog,ops` 只选择显式 mode；`auto,prog` 将自动结果与 `prog` 叠加。`defaults` 在这些情况下都会加入。
- 合并顺序为 `defaults`、自动结果、显式选择；自动结果按 `priority` 从小到大排列，同优先级按 ID 排序。`extends` 的父 mode 先于子 mode 加入，每个 mode 只展开一次。
- 同一资源 ID 去重；规则按顺序拼接，不进行内容覆盖。同一 skill 只要有一次绑定 `preload: true`，就预载正文。

自动检测是普通 JS 函数。编辑 `auto.mjs`，也可以从自己的模块导入函数：

```js
export default ({ files, dependencies }) =>
  files.includes('package.json') || dependencies.includes('typescript')
    ? ['prog']
    : [];
```

函数收到 `cwd`、`boundary`、`files`、`dependencies`；文件路径与依赖基于工作区根目录收集。返回已定义的 mode ID 数组，支持异步函数。命名导出 `auto` 存在时，它取代各 mode 的 `detect.any` 检测；未导出时才使用声明式检测。配置及其导入模块会以本机用户权限执行，只加载信任的仓库。

## 把现有 skill 绑定到 mode

skill 保持标准目录结构：入口为带 `name`、`description` frontmatter 的 `SKILL.md`，脚本与参考文件一起保留。在上述配置中加入资源，并给 `prog` 加上绑定：

```js
// resources 中加入；路径相对于配置仓库
'review-skill': {
  kind: 'skill', source: { type: 'local', path: 'skills/review' },
},
// modes.prog 中加入
skills: [{ id: 'review-skill', preload: true }],
```

规则正文总是注入；skill 默认只注入名称、描述和可读取的资源路径，`preload: true` 才注入入口正文，脚本不会自动执行。原生项目 skills 仍由 agent 自己发现。CodeBuddy 接线会按 skill 名称跳过当前目录 `.codebuddy/skills` 与 HOME 下 `.codebuddy/skills` 中已有的资源；Claude / Codex 当前没有这层自动去重。

## 会话启动时加载

优先安装 `SessionStart` hook。先查看计划，再显式应用；下面以 Claude 为例，`--target-home` 是 HOME 根目录：

```sh
modup install --agent claude --target-home "$HOME"
modup install --agent claude --target-home "$HOME" --apply
claude
```

安装将配置仓库和状态目录绑定到 hook，后续从业务目录启动原生 agent 即可。配置仓库迁址或切换绑定前应先用 `uninstall` 卸载；安装、卸载默认均只预览，写入需要 `--apply`。

| Agent | Hook 安装位置（相对于 HOME） | Wrapper 启动 |
| --- | --- | --- |
| Claude Code | `.claude/settings.json` | `modup run --agent claude --` |
| Codex | `.codex/hooks.json` | `modup run --agent codex --` |

Codex 安装后仍需在 `/hooks` 审查并信任定义；安装不会代替授权。Claude 的 hook 失败不能保证阻止首条请求。实际加载依赖所用 agent 版本支持相应 hook 协议。

wrapper 在启动子进程前准备上下文，适合未启用 hook 的场景。它只接受已支持的参数；Codex 还需要 `app-server` 的有效配置读取能力，无法安全保留既有指令时会拒绝启动。同次 wrapper 启动的 hook 可识别已注入的内容，避免重复注入。

CodeBuddy Code CLI 接线已落盘，最终独立验收仍待确认，暂不列为已验证启动路径；目标配置为 `~/.codebuddy/settings.json`，旧 `.codebuddy-cli` 与 IDE 扩展不在已验证范围。modup 不管理 MCP。

## 扫描与迁移已有资源

扫描只读取支持目录中的自然语言 rules 与 skills，不扫描整份 HOME。迁移目标必须是已有 Git 仓库；先使用一个尚未配置 modup 的仓库，可以避免覆盖现有 JS 配置：

```sh
modup scan --home "$HOME" --format json
mkdir aiconfig-import
git init aiconfig-import
modup migrate --home "$HOME" --config ./aiconfig-import
```

检查输出中的资源、`conflicts` 与 `planDigest`，再把摘要填入以下命令：

```sh
modup migrate --home "$HOME" --config ./aiconfig-import --apply --expect <planDigest>
```

迁移保留原文件，将外部资源完整复制到 `.modup/resources/`，生成 JS 资源配置；不会自动替你判断所有 mode 归属。可用 `--bindings '<JSON>'` 指定 `defaults` 与 `modes`，预览和应用时需传入同一份绑定。重名异内容资源须在绑定中明确选择一个版本；未解决冲突或预览过期时不能应用。现有 JS 配置需要新增绑定或资源时，工具会报冲突，由你手动编辑，不覆盖用户代码。

绑定与迁移辅助记录放在隐藏的 `.modup/` 内并单独忽略；完整资源应随配置仓库分享。迁移也会检查复制资源是否被 Git 忽略，避免分享时丢文件。

## 分享资源，版本交给已有工具

`modup.config.mjs`、auto 模块和资源一起提交到自己的 Git 仓库即可分享，也可以用 `modup import --from <git-url> --dir <new-dir> --ref <ref>` 导入。资源支持配置仓库内的本地路径，以及带 `url`、`ref`、`path` 的 Git 来源。

版本由 Git、submodule 或 npm 等已有工具管理；modup 不要求独立 lock 文件。内置 `import` 不支持含 Git submodule（gitlink）的配置仓库，此类仓库需自行检出并初始化子模块。使用 Git 来源时，先运行 `modup sync` 准备资源再启动会话；它会准备配置中的全部资源，`modup sync --update` 刷新 Git 来源；本地资源按当前内容读取。缓存用于复用资源，不保证 agent 侧命中提示词缓存或不同 agent 共享缓存。

旧 `.mode` 与 JSON 配置仅用于迁移兼容；新项目使用 `.modes` 和 JS 配置。
