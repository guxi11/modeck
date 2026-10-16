# modup

**一份配置，让 agent 随工作目录切换规则和技能。**

在多个项目间切换时，编程、写作和运维需要不同的工作方式。modup 把你的 rules 和 skills 集中管理，按目录选择合适的组合，在会话开始时加载。支持 Claude Code、Codex 和 CodeBuddy Code CLI。

## 快速开始

需要 Node.js 20+、npm、macOS 或 Linux，以及你要使用的 agent CLI。

1. 安装 [modup npm 包](https://www.npmjs.com/package/modup)：

   ```sh
   npm install -g modup
   ```

2. 创建并进入一个文件夹，初始化配置。文件夹的名称和位置由你决定：

   ```sh
   mkdir agent-config
   cd agent-config
   modup init
   ```

   按提示选择要扫描的 agent，以及要导入的规则和技能。modup 生成 `modup.yaml` 和 `modep-auto.mjs`；导入前会展示变更清单和备份位置，确认后执行。

3. 在配置目录绑定 agent：

   ```sh
   modup bind
   ```

   在 CLI 列表中勾选你使用的 agent。使用 Codex 时，还需在 `/hooks` 中审查并信任安装的 hook。

4. 进入你的业务项目目录，预览加载内容：

   ```sh
   modup render
   ```

   按提示选择要预览的 agent，默认使用当前目录，输出选中的 modes、规则正文和技能索引。之后在这个目录启动原生 agent，新会话就会通过 hook 加载配置。

## 按工作方式组织配置

mode 把一组规则和技能命名为一种工作方式。你可以在多个项目中复用同一份编程规范，也可以让写作目录只加载写作相关内容，减少无关指令干扰。修改一份共享规则，引用它的 mode 都能使用更新后的内容。

例如，把工作方式分成以下几组：

| Mode | 加载内容 | 使用场景 |
| --- | --- | --- |
| `base` | 通用沟通习惯 | 所有项目 |
| `prog` | 编程规范、代码审查技能 | 代码项目 |
| `writing` | 写作风格、编辑技能 | 文章和笔记 |

初始化会把导入的资源放在默认 `base` 中。把只用于某种工作的资源从 `base` 移到对应 mode，才能让它们按需加载。

在 `modup.yaml` 中，用你实际导入的资源名称和路径组织配置：

```yaml
resources:
  rules:
    coding: rules/coding.md
    prose: rules/prose.md
  skills:
    review: skills/review

defaults: [base]
modes:
  base: {}
  prog:
    rules: [coding]
    skills: [review]
  writing:
    rules: [prose]
```

路径相对于配置目录：rule 是 Markdown 文件，skill 是包含 `SKILL.md` 的目录。`defaults` 中的 mode 始终加载，无需再通过 `extends` 继承。`extends` 用来复用其他非默认 mode 的配置。

## 添加和更新外部资源

用 `modup res` 管理 Git 仓库中的资源目录，需要安装 Git。在配置目录运行以下命令，添加一个外部 skill：

```sh
modup res add \
  --url https://github.com/wondelai/skills.git \
  --path technical-documentation \
  --target skills/technical-documentation
```

`--path` 是仓库中的源目录，省略时取仓库根目录；`--target` 是配置目录中的目标路径。可用 `--ref` 指定分支、标签或 commit，默认跟踪 `HEAD`。

命令下载指定目录，将目标加入 `.gitignore`，并在 `modup-resources.json` 中记录地址、路径、ref、commit、摘要、commit 时间 `date` 和标签 `tag`（没有标签时为 `null`）。提交这份清单和 `.gitignore`，即可在其他机器还原资源，无需 Git submodule。

下载后，在 `modup.yaml` 的 `resources.skills` 中登记目标路径，并将 skill 加入需要的 mode，才会加载：

```yaml
resources:
  skills:
    technical-documentation: skills/technical-documentation
modes:
  writing:
    skills: [technical-documentation]
```

将这些条目合并到已有的同名配置项中。之后在配置目录按清单初始化，或更新到所跟踪 ref 的版本：

```sh
modup res init
modup res update
```

`init` 按记录的 commit 和摘要还原缺失目录；`update` 更新资源和清单。已有目录若包含本地修改，命令会拒绝覆盖。命令输出 JSON 资源清单；在其他目录运行时，用 `--config` 指定配置目录。原命令 `modup resource` 仍可使用。

## 让目录自动选择工作方式

在 `modep-auto.mjs` 中定义选择逻辑。例如，让包含 `package.json` 的项目选择 `prog`，其他目录选择 `writing`：

```js
export default ({ files }) =>
  files.includes('package.json') ? ['prog'] : ['writing'];
```

`auto` 返回 `modup.yaml` 中已声明的 mode 名称。初始化生成的函数返回空数组，你可以按自己的目录特征修改它。

需要固定某个项目的工作方式时，在该项目中创建纯文本 `.modes`，写入 mode 名称；多个名称用逗号或换行分隔：

```text
prog
```

非空 `.modes` 替代自动选择，仍保留默认 mode 和继承关系；没有该文件或内容为空时使用自动选择。

## 移除绑定

要停止为 agent 加载 modup 配置，在终端运行并勾选要解绑的 agent：

```sh
modup unbind
```

## 进一步阅读

[架构设计](docs/architecture.md) · [参与开发](CONTRIBUTING.md)
