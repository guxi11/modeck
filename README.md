# modup

<p align="center"><b>让工作目录决定 agent 加载哪些 rules 和 skills。</b></p>

借鉴 Emacs modes，把编程、运维、写作等工作方式声明为 mode。rules 和 skills 集中放在自己的配置目录，业务项目只需一个纯文本 `.modes` 文件。支持 Claude Code、Codex 和 CodeBuddy Code CLI。

## 开始使用

需要 Node.js 20+，运行于 macOS 或 Linux。

```sh
npm install -g modup
```

进入准备用来管理配置的目录，运行：

```sh
modup init
```

modup 会扫描已有的 rules 和 skills，让你选择要纳入管理的资源、为它们命名，并生成 `modup.mjs` 和 `auto.mjs`。随后编辑 mode 声明，决定每种工作方式需要哪些资源。

在这个配置目录绑定 agent：

```sh
modup bind --agent claude
```

将 `claude` 换为 `codex` 或 `codebuddy`，即可绑定相应 agent。之后从业务项目启动原生 agent，新会话会自动加载对应的 rules 和 skills。

## 配置按工作方式组织

`modup.mjs` 中先声明资源，再把资源名称绑定到 mode。资源路径相对于配置目录；rule 指向 Markdown 文件，skill 指向包含 `SKILL.md` 的目录。

```js
export { default as auto } from './auto.mjs';

export default {
  resources: {
    rules: {
      coding: 'rules/coding.md',
      operations: 'rules/operations.md',
    },
    skills: {
      review: 'skills/review',
    },
  },
  modes: {
    prog: { rules: ['coding'], skills: ['review'] },
    ops: { rules: ['operations'] },
  },
};
```

把示例路径和名称换成初始化时选定的资源。规则正文会注入会话；skill 先提供名称、描述和路径，正文按需读取。

在业务项目中创建 `.modes`：

```text
prog
```

把业务项目的 `.modes` 写为 `auto`，即可让 `auto.mjs` 根据目录内容自动选择 mode；显式写 `prog` 时不会运行自动检测：

```js
export default ({ files, dependencies }) =>
  files.includes('package.json') || dependencies.includes('typescript')
    ? ['prog']
    : [];
```

`auto` 是普通 JS 函数，可以导入自己的模块，也支持异步。它收到 `cwd`、`boundary`、`files` 和 `dependencies`，返回配置中已声明的 mode 名称数组。文件路径与依赖基于工作区根目录收集。配置及 auto 脚本以本机用户权限执行。

## 从配置到会话

```mermaid
flowchart LR
  Config["配置目录<br/>modup.mjs · auto.mjs<br/>rules · skills"] --> Bind["modup bind"]
  Bind --> Hook["agent 的 SessionStart hook"]
  Project["业务项目<br/>.modes / 自动识别"] --> Hook
  Hook --> Context["选择的 rules 和 skills"]
  Context --> Session["新会话上下文"]
```

绑定后，hook 在会话开始时读取配置和工作目录，准备对应的上下文；不需要额外的入口 skill。agent 原有的全局和项目配置仍由它自己加载。

Codex 绑定后还需要在 `/hooks` 中审查并信任 hook。CodeBuddy 的适配对象是 CodeBuddy Code CLI。

需要查看准备注入的内容时，可在配置目录用 `render` 调试，并将 `/path/to/project` 替换为业务项目路径；它不会启动模型：

```sh
modup render --agent claude --cwd /path/to/project
```

移除某个 agent 的绑定：

```sh
modup unbind --agent claude
```
