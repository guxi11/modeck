# agent-modes 详细设计

阶段：hard，2026-10-16。本文冻结 v1 Interface；任务与文件归属见 `tasks.md`。只设计，不实现、不写测试代码、不改真实全局配置、不发布或推送。以 `architecture.md` 为需求基线；本文明确收敛处优先作为 standard 实施契约。

## 1. 收敛后的闭环与 Module

Node.js >=20，TypeScript strict，ESM，首版支持 macOS/Linux。Windows 在写入前报 `E_PLATFORM`，不生成不能执行的 shell hook。包名暂为 `@guxi11/agent-modes`，bin 为 `agent-modes`；无 ai-rulez 依赖。只提供 Claude Code、Codex 两个真实 Adapter。

闭环是 `init/import → 编辑 modes.json → sync → resolve/render → install 或 run → uninstall`。init 创建有 Git 元数据的新配置目录；import 导入指定 Git revision 到新目录；两者都不隐式安装、联网同步资源或修改本机指针。配置仓库由用户正常 Git 提交/分享，下载内容及机器状态不进入仓库。

三个 Module 的 Seam：

| Module | 隐藏的 Implementation | 对外 Interface |
| --- | --- | --- |
| core | 校验、特征采集、DAG 展开、稳定编译 | 规范化配置、纯 resolve/compile；唯一公共 contracts |
| resources | Git、本地树快照、锁、内容库、校验与原子发布 | init/import、sync、离线 readResources |
| integration | 命令行、hook 编码、wrapper、安装事务、入口 skill | CLI 与两套 Adapter；只编排前两个 Module |

core 不导入 resources/integration；resources 只导入 `contracts` 的类型、协议常量及公共纯工具，不导入 core Implementation；integration 只从三者的公开 index/contracts 导入。共享契约只能由 core owner 修改；另两人不自行复制或“补一份”类型。

## 2. 路径、编码与身份

CLI 的 `--config <dir>` 指配置目录，不是文件。优先级：显式参数 > `AGENT_MODES_CONFIG` > `$HOME/.config/agent-modes`。状态目录：`--state <dir>` > `AGENT_MODES_STATE` > `$HOME/.local/share/agent-modes/v1`。相对 CLI 路径在入口进程原 cwd 下解释一次，再检查路径链并转为realpath；不存在的目标从最近存在父目录解析。config/state/destination/target先逐段lstat拒绝symlink，再取得真实路径，不能先realpath抹掉恶意symlink证据（隔离验证使用真实`/private/tmp`路径）。禁止配置目录和状态目录相同或状态目录位于配置目录内；无额外“当前配置指针文件”。

共享路径统一为 POSIX 相对路径：非空，无绝对前缀、反斜杠、空段、`.` 段（单独的资源根 `.` 除外）、`..` 段、NUL/控制字符、`.git` 段；文件名必须 NFC。标识符匹配 `^[a-z][a-z0-9-]{0,63}$`。本地资源路径必须在配置根内；Git path 必须在指定 commit 内。仅普通文件/目录，首版拒绝全部 symlink、gitlink、设备、FIFO、socket；不是只检查字符串。每次访问以 lstat/realpath、根内 containment 和父目录逐段检查共同校验，拒绝 symlink 父目录。入口 cwd 可以是 symlink 的别名，先 realpath；共享内容及安装目标不接受 symlink。

统一 `Sha256` 为 64 位小写 hex（不含 `sha256:`）；Git commit 是 40 位小写 SHA-1（首版拒绝 Git SHA-256 仓库）。所有 JSON 为 UTF-8，拒绝重复 key、非有限数字、孤立surrogate及未知字段；不做字符串到布尔/数字转换。JSON Schema 用 draft 2020-12，不启用自动 removeAdditional/coerceTypes。输入 JSON 上限 1 MiB，锁/本机 manifest 上限 8 MiB。公共 `parseJson` 在 JSON.parse 前检测重复 key，不能靠解析后的对象补查；各读取入口都调用它，大小上限由调用方按文件类别先检查。该工具也用于读取共享agent JSON，不让resources/integration另写宽松解析器。

canonical JSON：对象 key 递归按 JS 字符串 `<` 顺序排序，数组保序，无空白，UTF-8；展示用 JSON 另以两空格缩进加一个 LF。配置补齐本文规定默认值后计算 configDigest；`resources`/`modes` 是对象，其 key 不参与声明顺序。所有显式有序项必须是数组。共享配置/锁/selection身份摘要不含绝对路径、mtime、日志、时间或临时文件名；contentDigest及安装planDigest分别按其契约覆盖实际正文/计划字节数据，不能为稳定比较漏掉真实路径。

## 3. 输入 JSON Schema（完整 v1 形状）

core 提交三个文件 `schemas/modes.schema.json`、`selector.schema.json`、`lock.schema.json`。下列 JSON 就是各文件的规范内容；表后语义检查也是强制校验。Schema 的 `$id` 使用 URN，校验不联网。

`modes.schema.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:agent-modes:modes:1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "modes", "resources"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "defaults": { "$ref": "#/$defs/ids" },
    "modes": {
      "type": "object", "maxProperties": 256,
      "propertyNames": { "$ref": "#/$defs/id" },
      "additionalProperties": { "$ref": "#/$defs/mode" }
    },
    "resources": {
      "type": "object", "maxProperties": 512,
      "propertyNames": { "$ref": "#/$defs/id" },
      "additionalProperties": { "$ref": "#/$defs/resource" }
    }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },
    "ids": { "type": "array", "maxItems": 256, "uniqueItems": true, "items": { "$ref": "#/$defs/id" } },
    "path": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "source": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false, "required": ["type", "path"],
          "properties": { "type": { "const": "local" }, "path": { "$ref": "#/$defs/path" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["type", "url", "ref", "path"],
          "properties": {
            "type": { "const": "git" }, "url": { "type": "string", "minLength": 1, "maxLength": 2048 },
            "ref": { "type": "string", "minLength": 1, "maxLength": 256 }, "path": { "$ref": "#/$defs/path" }
          }
        }
      ]
    },
    "resource": {
      "type": "object", "additionalProperties": false, "required": ["kind", "source"],
      "properties": { "kind": { "enum": ["rule", "skill"] }, "source": { "$ref": "#/$defs/source" } }
    },
    "condition": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false, "required": ["type", "path"],
          "properties": { "type": { "const": "exists" }, "path": { "$ref": "#/$defs/path" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["type", "pattern"],
          "properties": { "type": { "const": "glob" }, "pattern": { "$ref": "#/$defs/path" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["type", "name"],
          "properties": { "type": { "const": "dependency" }, "name": { "type": "string", "minLength": 1, "maxLength": 214 } }
        }
      ]
    },
    "skillBinding": {
      "type": "object", "additionalProperties": false, "required": ["id"],
      "properties": { "id": { "$ref": "#/$defs/id" }, "preload": { "type": "boolean" } }
    },
    "mode": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "extends": { "$ref": "#/$defs/ids" },
        "priority": { "type": "integer", "minimum": -10000, "maximum": 10000 },
        "detect": {
          "type": "object", "additionalProperties": false, "required": ["any"],
          "properties": { "any": { "type": "array", "minItems": 1, "maxItems": 64, "items": { "$ref": "#/$defs/condition" } } }
        },
        "rules": { "$ref": "#/$defs/ids" },
        "skills": { "type": "array", "maxItems": 256, "items": { "$ref": "#/$defs/skillBinding" } }
      }
    }
  }
}
```

`selector.schema.json`（目录中的 `.mode`）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:agent-modes:selector:1",
  "type": "object", "additionalProperties": false, "required": ["schemaVersion"],
  "properties": {
    "schemaVersion": { "const": 1 }, "auto": { "type": "boolean" },
    "add": { "$ref": "#/$defs/ids" }, "disable": { "$ref": "#/$defs/ids" }
  },
  "$defs": {
    "ids": { "type": "array", "maxItems": 256, "uniqueItems": true, "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" } }
  }
}
```

默认补齐：`defaults=[]`；mode 的 `extends/rules/skills=[]`、`priority=0`，缺 detect 就不推断；skill binding `preload=false`；selector `auto=true, add=[], disable=[]`。detect 是 any-of，不做嵌套布尔表达式。glob 只支持路径段中的 `*` 及独立整段 `**`，匹配整个相对文件路径，大小写敏感，`**` 可匹配零段；拒绝 `? [] {} !`、转义及 extglob。exists 只判断普通文件；dependency 只查边界根 package.json 的 dependencies/devDependencies/peerDependencies/optionalDependencies 中的 key，不查版本、不递归 workspace、不解析锁文件。package.json 无效应报错，不忽略。

语义检查：defaults、extends、selector 引用必须存在；DAG 全图无环（即使未选中）；rules 只能引用 rule，skills 只能引用 skill，同一 mode 的 skill id 不重复；未知 id 立即失败。所有资源即使未选中也要验证描述。禁止原型污染 key（JSON 中的 `__proto__`/`prototype`/`constructor` 作为对象 key），实现使用 Map 或无原型对象。

## 4. 锁与资源协议

`lock.schema.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:agent-modes:lock:1",
  "type": "object", "additionalProperties": false,
  "required": ["schemaVersion", "resourceSpecDigest", "resources"],
  "properties": {
    "schemaVersion": { "const": 1 }, "resourceSpecDigest": { "$ref": "#/$defs/sha" },
    "resources": { "type": "array", "maxItems": 512, "items": { "$ref": "#/$defs/locked" } }
  },
  "$defs": {
    "sha": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "entry": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false, "required": ["path", "kind"],
          "properties": { "path": { "type": "string", "minLength": 1 }, "kind": { "const": "directory" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["path", "kind", "digest", "bytes", "executable"],
          "properties": {
            "path": { "type": "string", "minLength": 1 }, "kind": { "const": "file" },
            "digest": { "$ref": "#/$defs/sha" }, "bytes": { "type": "integer", "minimum": 0 }, "executable": { "type": "boolean" }
          }
        }
      ]
    },
    "locked": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "kind", "sourceDigest", "commit", "treeDigest", "entries"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },
        "kind": { "enum": ["rule", "skill"] }, "sourceDigest": { "$ref": "#/$defs/sha" },
        "commit": { "oneOf": [{ "type": "null" }, { "type": "string", "pattern": "^[0-9a-f]{40}$" }] },
        "treeDigest": { "$ref": "#/$defs/sha" },
        "entries": { "type": "array", "maxItems": 10000, "items": { "$ref": "#/$defs/entry" } }
      }
    }
  }
}
```

`sourceDigest = sha256(canonical({kind,source}))`，其中 source 是规范化描述；`resourceSpecDigest = sha256(canonical(config.resources))`。lock.resources 按 id 升序，与配置 id 集合严格相等；local 的 commit 必须 null，git 必须 commit。entries 按相对 path 升序、唯一，目录条目包含空目录，根目录不入列表；父目录必须存在且为 directory，不允许文件/目录冲突或大小写折叠碰撞。treeDigest 是 `sha256(UTF8("agent-modes-tree-v1\n") + UTF8(canonical(entries)))`。文件 digest 是原始字节的 SHA-256，executable 是源任一 execute bit 是否置位；不记录 uid/gid/mtime/其余权限。

rule 源必须是一个 UTF-8 文件，物化后统一名为 `tree/content.md`；skill 源必须是包含根级 `SKILL.md` 的目录，完整物化全部目录/文件，绝不只复制 SKILL.md。不得默认排除 scripts/references/assets 或任意隐藏文件（`.git` 是拒绝而非静默忽略）；包含不安全条目则整个资源失败。每树最多 10,000 条目、总文件 64 MiB、单文件 16 MiB；rule/SKILL.md 各至多 1 MiB；资源总量最多 512 MiB。超限失败，不发布部分树。

SKILL.md 使用 UTF-8 YAML frontmatter，单个文档，无自定义 tag/alias，根为 mapping，必需 `name`/`description` 两个非空 string；name 匹配上述 id（最多64），description 最多1024 UTF-16 单位且不含控制字符。其他 frontmatter 字段保存在原文件，但本工具不执行或解释其中 hooks/权限等字段。全配置 skill name 唯一，保留名 `agent-modes` 不可占用。YAML 用受限 yaml parser，不写简陋正则解析多行 description；原始 frontmatter/脚本均纳入树摘要。

固定内容库位置：`<state>/store/sha256/<treeDigest>/tree/`，旁边是 `manifest.json`（entries 的 canonical JSON + LF）。内容库独立于配置路径，可跨配置复用。文件物化成 0444/0555，目录 0555，执行位语义保留；验证摘要不依赖其余权限。发布用同文件系统 staging + rename，已有目标必须验证后才复用，损坏目标报 `E_INTEGRITY`，不可“相信目录名”。不自动 GC；因此已输出的 skill 绝对路径在卸载 adapter 后仍然有效。

同步语义固定如下：

| 操作 | 有锁 | 无锁 | 网络/写入 |
| --- | --- | --- | --- |
| `sync` | 只复用锁；任何描述/本地内容漂移报错 | 锁定所有资源并创建锁 | 可获取缺失的固定 commit、填充内容库 |
| `sync --update` | 重新解析全部 Git ref/本地内容并更新锁 | 同首次 sync | 显式允许所有资源版本更新 |
| `sync --frozen` | 描述、集合、本地树与锁必须匹配，锁字节不变 | `E_LOCK_MISSING` | 可获取缺失固定 commit/从匹配本地源重建内容库 |
| resolve/render/hook/run/install | 只读锁，完整验证全部资源/内容库和本地源 | `E_LOCK_MISSING` | 无网络、不修复、不写内容库 |

`--update` 与 `--frozen` 互斥。空配置也须 `sync` 生成空锁。只修改 modes/defaults 不要求更新资源锁，但 configDigest 改变。离线验证也检查未选中资源，避免把已损坏的共享配置宣称为有效。Git 离线阶段不要求保留临时 Git repo；校验 sourceDigest、commit 格式、树及 lock 即可，不重新访问远端。本地源每次重算树，不能用旧内容库隐藏本地改动；frozen 不是“有文件就算通过”。

sync 在配置根旁/锁同文件系统创建临时锁输出；配置写锁使用 exclusive lockfile，全部资源校验及发布成功后，复查 modes.json/旧锁原始摘要，再原子替换 modes.lock.json；中途失败旧锁原样保留。已发布但未引用的内容对象可以留下，不是假成功。互斥锁记录 pid，不自动按时间抢锁；残留锁报 `E_BUSY` 并给出路径，由人确认进程退出后处理。

Git url 支持 `https://`、`ssh://` 以及以 `./` 开始且位于配置根内的本地仓库目录（用于离线分发/fixture）；不支持 scp 简写、git ext/helper、任意绝对本机路径、URL 密码或控制字符。ref 接受 HEAD、完整 commit、合法分支/tag 名；分支/tag 同名且无法唯一解析时报错。路径字符串按第2节校验；本地仓库真实目录及父目录不可为 symlink。锁保留相对描述的摘要，不保存展开后的绝对 URL。日志去除 URL 凭据。

Git 子进程使用 argv，无 shell；清除继承的 `GIT_*`（需要的显式重建），禁用 system/global config、credential helper、hooks、templates、未授权 protocol、submodule recursion、prompts、filters；远端只按已校验scheme开放https或ssh，本地来源只开放file。Git 工作目录为工具 staging，不在来源目录执行工作树操作。首版https支持公开仓库，私有仓库通过ssh现有key/agent认证，交互提示关闭，不接受来源指定 sshCommand。对 ssh 不插值 URL 到 shell 命令。抓取到全 commit 后，以 `ls-tree -rz`/`cat-file` 提取普通文件，不 checkout、不触发 LFS/filter/submodule；LFS 指针视为普通字节，不能宣称已经下载 LFS 实体。网络命令每次最多120秒，输出受限，失败清理 staging。frozen 抓取旧 commit 不可用则明确失败，不能替换成 ref 的新头。

init 的最小内容为 `modes.json`（schemaVersion1、defaults=[base]、单个空语义base、resources={}；base默认字段由parseConfig补齐后写出）及工具生成的 `.git`；不创建 README/样例规则/锁。destination 必须不存在，父目录安全，失败不留下半成品。import 同样只接受新 destination；url 接受上述远端 URL，另外 CLI 的显式本地绝对 Git 目录可用于导入（不写入资源描述）。以 `git init + fetch + read-tree` 和受约束的 tracked tree 物化建立普通可提交配置仓库，设置 origin、HEAD/本地分支 `main` 指向所选 commit；不执行 checkout/hook，不自动 sync，不复制远端仓库控制目录。拒绝导入 symlink/gitlink/不安全文件树；`.git` 仅为本工具创建的元数据。配置与已有锁经回调校验后才 rename 到 destination。接收者导入后 `sync --frozen` 得到同内容；源仓库若没有锁，须先普通 sync 才有复现承诺。本地资源分享要求其所有文件已提交；Git不保留空目录，需由用户放置占位文件，否则接收者frozen应明确失败，不能默默丢目录后通过。相对本地Git源也须随配置完整分发，否则不具备跨机器复现前提。

## 5. 解析与稳定编译

collectFacts：验证 cwd 为目录，用 Git worktree 根为 boundary（支持 `.git` 文件、嵌套仓库以最近 Git 根为准）；非 Git boundary=cwd。不在 Git 时不向上读 `.mode`；在 Git 内从 cwd 向 boundary 逐级查找，最近的一个 `.mode` 生效。路径上的无效/不可读 `.mode` 立即失败；找到了就不继续叠加父级。

检测只扫描 boundary 内普通文件，排序后输出相对路径；不跟随 symlink。固定排除目录名 `.git,node_modules,dist,build,coverage,.next,.turbo,.cache,.agent-modes`，以及位于 boundary 内的 state 真实目录。最多遍历20,000条目录项/10,000文件，深度64，文件路径1024字符；package.json/selector 各1MiB。即使可提前判定 exists，也必须完成限额检查；超限 `E_SCAN_LIMIT`，无部分 plan。不存在根 package.json 则依赖集合为空；存在但不可读/非法则失败。相对路径按第2节排序；检测不读正文、不看 dirty/mtime/分支。

resolve 为纯函数，输入规范配置、facts、configDigest/lockDigest，输出 ResolvedPlan：

1. seeds = defaults +（auto=true 时，detect.any 至少一项命中的 mode 按 priority 升序/id升序）+ selector.add；保留重复 seed 的全部 reason。
2. 去掉 disable 中直接出现的 seeds；add/disable 重叠是 `E_MODE_CONFLICT`。沿每个 seed 声明的 extends 做有序 DFS，父先子后，首次出现保序去重。若任何保留 seed 的传递父在 disable 中，报冲突并带依赖链，不重新加入父。
3. 最终 mode 列表按上步顺序；每个 mode 依次取 rules、skills。资源首次出现位置确定最终顺序；同一 skill 任一绑定 preload=true 则合并为 true，但不改变第一次位置。rule 的 preload 恒 true。
4. reasons 只描述最终保留mode，按seed/DFS遇到顺序记录；via=parent时mode是被展开的父mode、from是声明extends的子mode，conditionIndex=null；via=detect时conditionIndex是detect.any中首个命中位置，其余from/conditionIndex均null。重复seed的各来源仍保留。不进入正文。diagnostics 首版成功为空数组；失败抛错，不成功返回半个 plan。

compile 不采集文件或联网；输入 plan 与 resources 返回的 VerifiedResourceSet（绑定文件已读成字节）。必须确认二者 configDigest/lockDigest 一致；不在 Adapter 重算 plan。公开 CLI resolve 也先离线验证资源，随后输出 plan；render/hook/run 复用同一个准备流程。

协议 `agent-modes-context/1` 的正文顺序及标点固定：

- 第一行 `# agent-modes-context/1`；其后依次 `agent: <codex|claude>`、`selection: <selectionDigest>`、`modes: <canonical JSON modeIds>`，空行。不写整配置或整锁摘要。
- 每个 rule 按最终有序资源中的 rule 顺序：`## rule <id>`、空行、规范化全部正文、空行。
- `## skills`，空行，固定一行 `Skill paths resolve from the indexed root; scripts are not run automatically.`，空行；每个 skill 按最终 skill 顺序一行 canonical JSON，字段为 `id,name,description,root,entry,preload`；root 是内容库 tree 的绝对路径，entry 为 root + `/SKILL.md`。JSON 字符串引用路径，不能裸拼路径到指令/shell。
- 每个 preload skill：空行、`## skill <id>`、空行、去掉 frontmatter 后的完整正文。
- 尾部恰一个 LF；无 skills 时保留空 skills 节。不将诊断、wrapper 标记、用户已有 developer instructions 放入这份正文。

rule/preload 文本按 UTF-8 fatal 解码，去单个 BOM，CRLF/CR统一LF，去末尾连续换行后加一个LF；内部空格/空行不重排。description 使用 YAML 解析后的字符串，JSON escape 换行，不产生额外正文行。正文总上限为9,000 UTF-16单位且32,768 UTF-8 bytes，两者都检查；超限 `E_CONTEXT_SIZE`，不截断、摘要化或偷偷关闭 preload。所有 render/hook/wrapper 一致执行该上限；它让 Claude 的10,000字符 spill 阈值留有余量。Codex handler 设 additionalContextLimit=0，依靠本工具硬上限避免其默认2,500 token spill。完整技能树不受正文上限限制，默认只索引按需读取。

`lockDigest = sha256(canonical(已校验锁))`，只用于输入一致性校验、resolve/JSON诊断，不参与稳定正文。按本轮稳定性补充，这一契约优先于architecture中将整锁变化视为上下文变化的早期描述。`selectionDigest = sha256(canonical({protocol,agent,modeIds,resources}))`，其中resources严格取plan最终有序绑定，逐项仅为`{id,kind,treeDigest,preload}`；不取全配置、全锁、detector、选择原因、source URL/ref或Git commit。treeDigest覆盖选中资源完整树及execute语义，因此未preload的skill资产/脚本变化也能改变身份；Git固定commit变了但同一选中树不变则正文不变。

`contentDigest = sha256(实际 text UTF-8 bytes)`，text自己不包含contentDigest，避免递归。RenderedContext同时返回selectionDigest/text/contentDigest/byteLength；其中configDigest/lockDigest只是诊断元数据，禁止被Adapter再拼进注入正文。在同一state绝对位置内，只要选中mode顺序、选中资源绑定/树/preload、agent和协议相同，text与contentDigest必须相同：无关detector或未选资源的合法变更即使改变configDigest/lockDigest，也不扰动正文。整JSON输出的诊断字段可以不同，验收比较text/selectionDigest/contentDigest，不比较整个render JSON。

稳定输出不豁免第4节完整性检查：未选资源合法变更并显式sync后才有有效锁；任何local源改变但未sync仍报E_LOCK_MISMATCH，不能只读旧内容库绕锁。迁移state路径会改变skill实际定位及正文摘要，这个稳定性只保证同一安装位置；不能承诺跨机器前缀、provider cache key、KV/cache hit。

这个摘要只覆盖本工具text。Codex/Claude原生skill初始索引也可能包含绝对路径；迁移HOME或入口skill安装位置会改变agent自己的model-visible prompt，即使本工具text/digest不变也不能声称完整前缀相同。不得为了缓存比较从原生索引里删去实际资源定位。

## 6. 公共导出类型与函数（core 独占）

`src/contracts/index.ts` 只含下列类型、只读协议常量与无副作用 JSON解析/canonical/hash/path词法/错误工厂函数；所有属性/数组语义为 readonly。这里用紧凑 TS 声明固定字段，实施必须用深层只读类型表达，不得增删字段或以 any 擦除契约。外部未经校验的输入一律 unknown。

```ts
type Id = string;
type Sha256 = string;
type Agent = "codex" | "claude";
type Kind = "rule" | "skill";
type Source = { type: "local"; path: string }
  | { type: "git"; url: string; ref: string; path: string };
type ResourceSpec = { kind: Kind; source: Source };
type Condition = { type: "exists"; path: string }
  | { type: "glob"; pattern: string } | { type: "dependency"; name: string };
type SkillBinding = { id: Id; preload: boolean };
type Mode = { extends: Id[]; priority: number; detect?: { any: Condition[] }; rules: Id[]; skills: SkillBinding[] };
type Config = { schemaVersion: 1; defaults: Id[]; modes: Record<Id, Mode>; resources: Record<Id, ResourceSpec> };
type Selector = { schemaVersion: 1; auto: boolean; add: Id[]; disable: Id[] };
type TreeEntry = { path: string; kind: "directory" }
  | { path: string; kind: "file"; digest: Sha256; bytes: number; executable: boolean };
type LockedResource = { id: Id; kind: Kind; sourceDigest: Sha256; commit: string | null; treeDigest: Sha256; entries: TreeEntry[] };
type ResourceLock = { schemaVersion: 1; resourceSpecDigest: Sha256; resources: LockedResource[] };
type ConfigContext = { configRoot: string; config: Config; configDigest: Sha256; rawConfigDigest: Sha256 };
type ProjectFacts = { cwd: string; boundary: string; files: string[]; dependencies: string[]; selector: { path: string; value: Selector } | null };
type Reason = { mode: Id; via: "default" | "detect" | "selector" | "parent"; from: Id | null; conditionIndex: number | null };
type Diagnostic = { code: string; message: string; path: string | null };
type BoundResource = { id: Id; kind: Kind; preload: boolean };
type ResolvedPlan = { schemaVersion: 1; configDigest: Sha256; lockDigest: Sha256; cwd: string; boundary: string; selectorPath: string | null; modeIds: Id[]; resources: BoundResource[]; reasons: Reason[]; diagnostics: Diagnostic[] };
type VerifiedResource = { id: Id; kind: Kind; treeDigest: Sha256; root: string; entry: string; entryBytes: Uint8Array; skill: { name: string; description: string; body: string } | null };
type VerifiedResourceSet = { schemaVersion: 1; configDigest: Sha256; lock: ResourceLock; lockDigest: Sha256; resources: VerifiedResource[] };
type RenderedContext = { schemaVersion: 1; protocol: "agent-modes-context/1"; agent: Agent; configDigest: Sha256; lockDigest: Sha256; selectionDigest: Sha256; modeIds: Id[]; text: string; contentDigest: Sha256; byteLength: number };
type HookEvent = { hook_event_name: "SessionStart"; cwd: string; session_id: string; source: "startup" | "resume" | "clear" | "compact" | "fork" };
type HookReply = { hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string } } | null;
type RunMarker = { version: 1; agent: Agent; configRoot: string; stateRoot: string; cwd: string; contentDigest: Sha256; ownerPid: number };
type FileImage = { data: string; encoding: "utf8" | "base64"; mode: number };
type FileChange = { path: string; category: "shared-json" | "owned"; beforeDigest: Sha256 | null; beforeMode: number | null; after: FileImage | null };
type InstallPlan = { schemaVersion: 1; operation: "install" | "uninstall"; agent: Agent; targetHome: string; owner: "agent-modes/v1"; changes: FileChange[]; conflicts: Diagnostic[]; warnings: Diagnostic[]; planDigest: Sha256 };
type ManagedFile = { path: string; digest: Sha256; mode: number };
type InstallRecord = { schemaVersion: 1; owner: "agent-modes/v1"; agent: Agent; configRoot: string; stateRoot: string; runtimeDigest: Sha256; files: ManagedFile[]; hookFile: string; hookGroup: unknown; beforeHookFile: FileImage | null; afterHookFileDigest: Sha256 };
type LockParser = (value: unknown) => ResourceLock;
type ImportValidator = (stagingRoot: string) => Promise<void>;
type LoadConfigRequest = { configRoot: string };
type CollectFactsRequest = { cwd: string; stateRoot: string };
type ResolveRequest = { context: ConfigContext; facts: ProjectFacts; lockDigest: Sha256 };
type CompileRequest = { plan: ResolvedPlan; resources: VerifiedResourceSet; agent: Agent };
type InitConfigRequest = { destination: string; initialConfig: Config };
type ImportConfigRequest = { url: string; ref: string; destination: string; validate: ImportValidator };
type SyncMode = "reuse" | "update" | "frozen";
type ReadResourcesRequest = { context: ConfigContext; stateRoot: string; parseLock: LockParser };
type SyncResourcesRequest = ReadResourcesRequest & { mode: SyncMode };
type PrepareRequest = { configRoot: string; stateRoot: string; cwd: string; agent: Agent };
type PreparedContext = { plan: ResolvedPlan; rendered: RenderedContext };
type EncodeHookRequest = { event: HookEvent; rendered: RenderedContext; marker: RunMarker | null; configRoot: string; stateRoot: string };
type PlanInstallRequest = { agent: Agent; targetHome: string; configRoot: string; stateRoot: string; runtimeRoot: string };
type PlanUninstallRequest = { agent: Agent; targetHome: string };
type ApplyInstallPlanRequest = { plan: InstallPlan; expectDigest: Sha256 };
type RunAgentRequest = PrepareRequest & { argv: string[]; executable: string };
type RunResult = { exitCode: number | null; signal: NodeJS.Signals | null };
type ModeErrorCode = "E_CONFIG" | "E_SELECTOR" | "E_MODE_CONFLICT" | "E_SCAN_LIMIT"
  | "E_PATH" | "E_LOCK_MISSING" | "E_LOCK_MISMATCH" | "E_RESOURCE_MISSING"
  | "E_INTEGRITY" | "E_GIT" | "E_GIT_COMMIT_UNAVAILABLE" | "E_LIMIT" | "E_CONTEXT_SIZE"
  | "E_INSTALL_CONFLICT" | "E_PLAN_STALE" | "E_BUSY" | "E_WRAPPER_CONFLICT"
  | "E_CODEX_CONFIG" | "E_HOOK_INPUT" | "E_PLATFORM" | "E_USAGE" | "E_IO";
type ModeError = Error & { code: ModeErrorCode; details: Readonly<Record<string, unknown>> };
```

`VerifiedResource.entry`：rule 为 root/content.md，skill 为 root/SKILL.md；resourceSet 按 id 排序，编译器按 plan 重排，不能依赖其遍历顺序。resourceSet 是本次完整校验的结果而非可永久信任的 token；hook 每次都重新准备。InstallRecord.hookGroup 是外部 agent JSON 的受检 opaque 值，不代表允许任意共享类型 any。

强制公开函数（对象参数不增加隐式 cwd；Promise 表示可能 I/O）：

| 导出文件 | 名称和参数 | 返回值 / 责任 |
| --- | --- | --- |
| contracts/index | `parseJson(text: string)`, `canonical(value: unknown)`, `sha256(bytes: Uint8Array)`, `checkRelativePath(path: string, allowRoot: boolean)` | unknown、string、Sha256、void；path只做词法校验，真实FS检查各owner负责；解析错误用E_CONFIG，读取入口转换成所属类别错误 |
| contracts/index | `PROTOCOL`, `SCHEMA_VERSION`, `LIMITS` | 本文版本/限额的只读常量 |
| core/index | `parseConfig(value: unknown)`, `parseSelector(value: unknown)`, `parseLock(value: unknown)` | Config、Selector、ResourceLock；含语义校验（parseLock 仅自身结构，不持有Config） |
| core/index | `loadConfig({configRoot})` | Promise<ConfigContext>；真实路径、JSON重复key、schema/引用/DAG校验 |
| core/index | `collectFacts({cwd,stateRoot})` | Promise<ProjectFacts>；selector调用parseSelector |
| core/index | `resolve({context,facts,lockDigest})` | ResolvedPlan；纯计算 |
| core/index | `compile({plan,resources,agent})` | RenderedContext；纯计算 |
| resources/index | `initConfig({destination,initialConfig})` | Promise<string>；安全创建Git目录，initialConfig由CLI调用parseConfig得到 |
| resources/index | `importConfig({url,ref,destination,validate})` | Promise<string>；validate:(stagingRoot:string)=>Promise<void>；成功才发布 |
| resources/index | `syncResources({context,stateRoot,mode,parseLock})` | Promise<VerifiedResourceSet>；mode:reuse/update/frozen；parseLock:(unknown)=>ResourceLock |
| resources/index | `readResources({context,stateRoot,parseLock})` | Promise<VerifiedResourceSet>；只读、离线、完整验证 |
| integration/index | `prepare({configRoot,stateRoot,cwd,agent})` | Promise<{plan:ResolvedPlan,rendered:RenderedContext}>；唯一 load/read/facts/resolve/compile 编排 |
| integration/index | `encodeHook({event,rendered,marker,configRoot,stateRoot})` | HookReply；纯编码/身份与摘要检查，marker:RunMarker\|null；pid存活检查在hook I/O入口完成 |
| integration/index | `planInstall({agent,targetHome,configRoot,stateRoot,runtimeRoot})` | Promise<InstallPlan>；runtimeRoot为包根，预览无写入 |
| integration/index | `planUninstall({agent,targetHome})` | Promise<InstallPlan>；读取record、共享JSON及现状 |
| integration/index | `applyInstallPlan({plan,expectDigest})` | Promise<void>；仅应用本工具重建且摘要匹配的计划，不接收CLI任意JSON计划 |
| integration/index | `runAgent({agent,configRoot,stateRoot,cwd,argv,executable})` | Promise<{exitCode:number\|null,signal:NodeJS.Signals\|null}>；exec必须绝对路径/已解析PATH实体 |
| cli/main | `main(argv: string[])` | Promise<number>；bin负责设置exitCode，禁止module import时自动启动 |

上列Request/Return类型也全由core从contracts/index导出，函数参数使用对应命名类型；不让三路对着inline object猜测。resources 不依赖 core 校验器，因此 parseLock 和 import validate 从 integration 显式注入；import validate 必须 loadConfig，若有 lock 则 parseLock 并比对 resourceSpecDigest/集合/描述，但不联网、不要求内容库。资源层自己完成锁与配置/树语义交叉校验。ModeError 用公共工厂 `modeError(code:ModeErrorCode,message:string,details:Readonly<Record<string,unknown>>):ModeError` 导出，避免跨 Module 的 instanceof 失效。`src/cli/main.ts`可导入而不执行；单独`src/cli/bin.ts`作为构建的可执行入口，调用main并处理退出码/信号。

## 7. CLI 契约

仅支持下表；未知参数/重复标量参数报 E_USAGE。公共参数必须在命令之后、run 的 `--` 之前；不支持用位置参数猜目录。`--cwd` 默认入口 cwd，只用于 resolve/render/run；hook 必须用 stdin cwd，禁止用进程 cwd替代。所有 flag value 的 `--x=y` 与 `--x y` 等价。`--help`/`--version` 不读取配置、不联网/写状态。普通JSON输出都是完整单个对象加LF。

| 命令 | 参数与默认值 | stdout / 结果 |
| --- | --- | --- |
| `init` | 必需 `--dir` | `{schemaVersion:1,configRoot}`；新目录，最小配置+git init |
| `import` | 必需 `--from`,`--dir`；`--ref HEAD` | 同init；校验成功才发布 |
| `sync` | `--config`,`--state`；可选互斥 `--update`/`--frozen` | `{schemaVersion:1,configDigest,lockDigest,resources:[{id,treeDigest,commit}]}` |
| `resolve` | `--config`,`--state`,`--cwd` | ResolvedPlan（始终JSON，不另设 --json） |
| `render` | 同resolve；必需 `--agent`；`--format text\|json` 默认text | text 原样；json为RenderedContext |
| `hook` | 必需 `--agent`；`--config`,`--state` | stdin事件→一次HookReply JSON；去重/跳过stdout空，exit0 |
| `install` | 必需 `--agent`,`--target-home`；`--config`,`--state`；`--format text\|json` 默认text；可选 `--apply --expect <digest>` | 默认预览 InstallPlan，不写；apply前重建计划并核验expect，成功仍输出本次InstallPlan |
| `uninstall` | 必需 `--agent`,`--target-home`；format/apply/expect 同install | 输出InstallPlan；无record返回空changes幂等计划 |
| `run` | 必需 `--agent`；`--config`,`--state`,`--cwd`；可选 `--executable`；`--` 后 agent argv 原样分词 | stdio继承，退出码/信号见wrapper契约 |

`--target-home` 是显式隔离HOME根，不是`.codex`/`.claude`目录，禁止省略；本参数替代旧草案的target-root，不保留含糊别名。Codex固定写`<target-home>/.codex/hooks.json`与`<target-home>/.agents/skills/agent-modes/`；Claude固定写`<target-home>/.claude/settings.json`与`<target-home>/.claude/skills/agent-modes/`。不跟随安装进程继承的CODEX_HOME/CLAUDE_CONFIG_DIR重定向写入。target-home等于OS账户真实home（通过os.userInfo().homedir取得，不用可被临时HOME覆盖的默认值）时只允许预览，apply报E_INSTALL_CONFLICT；不添加绕过flag。运行原生agent验证时由验证进程显式设置HOME及相应CODEX_HOME/CLAUDE_CONFIG_DIR到该隔离布局，工具安装本身不改父进程环境或真实全局配置。hook命令固定带绝对config/state路径，不受后来环境变量改变。

除 run 透传外，exit0成功；2=usage/config/selector/resolve/size；3=资源/Git/锁/路径/IO；4=安装冲突/陈旧计划/busy；5=hook事件非法或wrapper能力/冲突；错误 stderr 为 `{error:{code,message,details}}` 单行JSON，不在stdout夹日志。hook内部失败统一exit1，stderr同格式，stdout空；不伪装成功的空规则。install冲突预览仍输出完整plan但exit4；apply缺expect是E_USAGE。hook输入最多1MiB，session_id为非空string（最多256，无控制字符），忽略agent额外已知/未来字段，只严格校验本工具消费字段，hook_event_name/source不支持则E_HOOK_INPUT。hook入口先把stdin cwd校验并realpath规范化，再构造传给prepare/encodeHook的HookEvent；禁止退回进程cwd。

## 8. 两个 Adapter 与去重

依据为本轮提供的 `/tmp/mode-codex-hooks.md`、`/tmp/mode-claude-hooks.md`、`/tmp/mode-codex-skills-jina.md`，以及本机只读核查 `codex --help/debug --help/app-server generate-json-schema`（0.162.1）、`claude --help`（2.1.296）。不是运行真实模型的证据。[Codex skills官方文档](https://developers.openai.com/codex/skills/)明确USER为`$HOME/.agents/skills`，REPO为cwd至repo根各层`.agents/skills`；不能把只写旧`.codex/skills`当发现成功。其他原始出处见architecture.md；实施时不把临时依据路径写进产品。

两个hook文件均采用一个独立 matcher group：`matcher = "^(startup|resume|clear|compact|fork)$"`，`hooks` 中只有本工具一个 `type:"command"` handler，timeout=15秒。Codex 写 `<target-home>/.codex/hooks.json` 的 hooks.SessionStart；Claude 写 `<target-home>/.claude/settings.json` 同一字段；输出均为 `{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:text}}`。Codex handler另有additionalContextLimit=0。不得假造 managed/trusted 状态，不写信任存储，不生成 bypass-hook-trust 参数；安装预览/结果警告其新/变更定义须在真实会话 `/hooks` 审阅，否则可能跳过。Claude首次响应等待SessionStart完成，但退出失败不阻止请求；Codex也不能把hook失败一概说成fail-closed。

命令使用安装内固定 runtime 的 Node 绝对路径与CLI绝对路径，分别做POSIX单引号转义，不依赖npx临时路径、PATH同名程序、git root或cwd。根目录有空格/单引号也必须可执行；资源路径不拼入命令。runtime CLI 以bundled单文件安装，不复制未解析的 node_modules 引用。

去重分两层，不把“同session已经注入过”当通用依据：

1. 安装幂等：record中保存完整hook group，重复install复用/替换该组而不是append；保留其他handler/group及其相对顺序。一个target-home内每个agent只允许一个配置绑定，换config/state须先uninstall该agent。识别同runtime/owner的重复或手工改写组即冲突，不猜测并删除。Codex该层同时存在inline hook时保留它并警告；不得擅自迁移。
2. wrapper去重：仅在spawn已准备好完整附加指令时，将 canonical RunMarker 放入子进程环境 `AGENT_MODES_RUN_V1`（不写父环境/正文）。hook入口检查marker结构与ownerPid存活，再prepare并验证资源；encodeHook检查真实cwd/config/state/agent及contentDigest全部匹配，才返回null/exit0。marker非法、父wrapper已死、摘要/cwd不一致时抛E_WRAPPER_CONFLICT，不能当没看见然后追加第二份。wrapper子进程后续clear/compact在同配置/目录下仍由持久system/developer指令覆盖，匹配marker时继续跳过；wrapper路径不支持会话中切换mode/cwd，要重启。

纯hook路径的resume/clear/compact/fork每次重新注入，不落持久session去重文件；避免第二次compact或不同会话丢规则。一次安装保证本工具在该target只有一个组；首版不承诺对手工复制到多个config层/第三方plugin的重复hook去重，预览发现已知多来源时告警。不能用`session_id+source`永久缓存假装解决这一问题。支持的部署方式为每个agent一个生效的agent-modes安装；多层手工复制属于冲突配置，须清理后使用。

## 9. wrapper 契约与 Codex 有效配置

wrapper只支持创建本地新会话及Claude `-p/--print`、Codex `exec`；不包装维护/登录/远程/共享daemon/已有session操作。检测argv必须在消费flag值的语法下进行，不能把prompt里出现的 `-C` 子串当flag。实现两套小型、显式arity的已核查参数表；拒绝未知flag/子命令（能力不明则失败），支持已知flag的 `--x=y`。prompt和 `--` 后面全部是数据，禁止扫描误伤。完整允许表写在integration的adapter内，仅允许下述支持集，不能另放共享contracts副本：

- Codex：新交互会话或 `exec`/`e`；根级 `-m/--model`、`-s/--sandbox`、`-a/--ask-for-approval`、`--search`、`--no-alt-screen`、`--no-daemon`、`-c/--config`；exec另允许`--json`,`--skip-git-repo-check`,`-o/--output-last-message`、最后一个prompt（`-`保留stdin）。允许`-C/--cd`仅用于等值核验；不支持`-p/--profile`、`--worktree`、`--remote`、resume/fork/review、多值image/add-dir及不明别名。
- Claude：新交互会话或`-p/--print`；`--model`,`--effort`,`--permission-mode`,`--output-format`,`--input-format`,`--max-budget-usd`,`--verbose`,`--no-session-persistence`，最后一个prompt。接受`--append-system-prompt`或`--append-system-prompt-file`单个值作为用户附加正文，二者互斥，不直接透传（合并后只发一个append）。拒绝替换system prompt的所有形式、resume/continue/fork、worktree/tmux、远程/desktop、--settings/--setting-sources/--agent/--bare/--safe-mode等改变加载来源/提示语义的参数。

shell以外调用方若要更广参数，先扩展契约再实现，不能默默透传已知会改变目录/提示来源的参数。现有argv逐token解析；除消费掉的等值cwd、用户append及Codex developer override之外，其余支持token保留原顺序、值与字节（不重新shell分词）。重复标量安全相关flag一律拒绝；Codex -c 允许重复不同key，同key也拒绝。

cwd唯一来源是CLI `--cwd`的realpath；Codex用户的 -C/--cd（包括=形式）解析后必须与它相等，否则E_WRAPPER_CONFLICT（不擅自选一方）；相等则移除，最终固定注入一个 `-C <cwd>`，spawn也用同cwd。拒绝可能另建worktree/切换session的参数。Claude使用spawn cwd而无额外切目录参数；原生额外目录不代表mode选择根，首版不支持。解析冲突在prepare/启动之前完成。

Claude：读取用户唯一append字符串或文件的原字节UTF-8文本（文件不要求在配置根，但必须显式指定且普通文件，不能symlink），保持它的字符内容；若非空，加 `\n\n` 后接mode text，通过单个 `--append-system-prompt` 传给CLI。无用户append则值严格为mode text。保留默认系统提示、cwd、原生CLAUDE.md及既有settings。首版wrapper拒绝resume，是因为本机help指出system prompt snapshot可能复用旧append，不能承诺新mode被纳入旧会话。合并值超过64KiB bytes时E_LIMIT，不经shell或临时路径降级。

Codex不能自己猜测`~/.codex/config.toml`的层叠规则。固定有效配置探测协议：

1. 使用同一已解析codex executable、相同env/CODEX_HOME、同cwd、用户原始全部`-c key=value`启动独立`codex [这些-c] app-server --stdio`，不连接proxy/daemon。仅交换本地JSON-RPC，不创建thread、不请求模型、不调用config/write。
2. newline JSON messages：`initialize` id1，params为 `{clientInfo:{name:"agent-modes",version:<包版本>},capabilities:{experimentalApi:false}}`；成功后`initialized`通知；`config/read` id2，params为 `{cwd:<real cwd>,includeLayers:true}`。这是0.162.1生成的ConfigReadParams契约；ConfigReadResponse含config、origins及请求的layers。只接受对应id的result，不把notification当result；总10秒、响应上限8MiB、错误即终止探测进程并报E_CODEX_CONFIG。
3. 取`result.config.developer_instructions`。string原样保留，null/缺失仅在有效layers均无该配置时视为空；类型不符、响应缺layers、发现层中有值但effective缺失、disabledReason不明导致无法判定时拒绝。不从调试prompt里提取/重复原生AGENTS.md，不靠JSON中第一条developer消息猜基线。logs不得输出已有指令正文。
4. `-c` key只接受无引号的 `[A-Za-z_][A-Za-z0-9_.-]*` 后接`=`，value原样交给Codex解析；拒绝`profile`、`model_instructions_file`、`instructions`及其下级，防止替换基础提示；developer_instructions只允许精确顶层key，值由config/read解释。启用的layers中若指定model_instructions_file或不可解释的开发者指令替代来源，也拒绝，保留不了原生语义就不覆盖。用户-c和层中已有developer_instructions可为多行/引号/backslash，必须保持内容前缀不变。
5. 合并值是 baseline +（非空时`\n\n`）+ mode text；不规范化baseline。删除原argv里精确developer_instructions override，其他-c原样保留；最终生成一个`-c developer_instructions=<JSON.stringify(合并值)>`，JSON字符串仅作为TOML基本字符串的编码（拒绝NUL/不合法Unicode；校验编码 round-trip），绝不作为shell quoting。合并值上限64KiB。启动前再次config/read并比对layers版本、effective值/origins，变化则E_CODEX_CONFIG；这是缩小竞态而非声称跨外部修改的原子快照。
6. 实际启动强制 `--no-daemon`、固定-C；同env中放RunMarker。共享daemon可能不继承本次wrapper marker，因此禁止该路径。若版本不支持config/read、--no-daemon或协议形状变更，明确拒绝该wrapper；hook适配仍可单独使用。已读内容仍由Codex自行加载原生instructions；不得使用model_instructions_file替换基础提示。

两个wrapper都用spawn(argv,{cwd,env,stdio:"inherit",shell:false})；不把stdin用于本工具探测（Codex探测使用独立pipe），保留用户stdin供agent。PATH选择后固定真实executable，不得解析回agent-modes自身。临时移除父进程已有AGENT_MODES_RUN_V1：若其存在则拒绝嵌套wrapper，避免错误去重。收到SIGINT/SIGTERM/SIGHUP时转发给子进程，等待退出后移除handler；正常退出保留exitCode，signal终止则bin以同信号终止自身（不能只返回0或吞信号）。spawn失败报E_IO。wrapper预检失败时绝不启动实际会话。

## 10. 安装、所有权与卸载

每个显式target-home只管理下列位置；FileChange/ManagedFile/hookFile均相对此HOME，禁止把agent配置目录当路径根：

| 位置 | 所有权与内容 |
| --- | --- |
| `.codex/hooks.json`（Codex）/`.claude/settings.json`（Claude） | shared-json；仅record记载的独立SessionStart组归本工具 |
| `.agents/skills/agent-modes/`（Codex）/`.claude/skills/agent-modes/`（Claude） | owned完整入口skill树；已存在且无record即冲突，即使字节相同 |
| `.agent-modes/<agent>/runtime/<runtimeDigest>/` | owned最小包布局：`dist/bin/agent-modes.mjs`、`schemas/`三份schema、`skills/agent-modes/`完整树及`package.json` |
| `.agent-modes/<agent>/install.json` | owned InstallRecord；只记录本机绝对路径，可含安装前hook原字节；不进入config/lock |
| `.agent-modes/<agent>/install.lock`、`transaction.json`、事务备份 | apply期间的专用互斥与恢复文件；完成后清理 |

同一隔离HOME可分别安装两个agent，record/runtime/journal互相隔离；每个agent只删除其列出的路径。Codex卸载不得删除`.agents/skills`下其他内容，也不删除旧`.codex/skills`内容。所有父目录仍按第2节安全校验；不能因为hook与skill在不同目录，就绕过同一HOME下的完整预览/事务。

不得改AGENTS.md、CLAUDE.md、config.toml、其他native skill、信任文件或权限策略。npm包build生成的standalone JS bundle（第三方代码已打入）与schema/入口skill数据必须包含在tarball。core从`dist/core`下的schema加载文件用`../../schemas/`相对import.meta.url读取；打包后入口在`dist/bin`仍是同样两级路径。安装保留上表最小包布局，因此不依赖源码路径、cwd或外部node_modules；版本从该包根package.json读取。runtimeRoot在普通bundle与安装bundle中都由入口URL上溯两级得到，不由工作目录推断。安装runtime从当前包的已校验固定路径复制，不下载、不npm install、不执行生命周期脚本。

Node绝对路径进入hook命令，升级Node后需重新预览安装。runtimeDigest=sha256(canonical(上述最小包布局各文件的相对path/digest/mode列表))，按path排序；不含时间/随机id。record的owned files不包含record自身，避免摘要自引用。加载record须校验全部字段/路径/文件集合；agent不符、未知owner、重复/越界path或不在上表可管理位置的文件一律冲突。record中hookGroup须经agent结构检查后使用，不能据不可信record删除任意target文件。初版允许同包同目标重复安装，升级时只替换记录的runtime/entryskill及hook组，旧runtime仅当它在owned清单且完整未改时删除。

预览是只读操作：读取包资源/目标/config，构造按相对path排序的FileChange；path均相对target，beforeDigest是现有文件原始字节摘要，beforeMode是权限低9位（文件不存在时两者都为null），after为完整内容或null删除。共有JSON对象保留所有未知key和其他hooks；只接受UTF-8严格JSON object，无JSONC/注释/重复key，hooks/SessionStart形状错误报冲突，不自动修复。更新共有文件用稳定pretty JSON；同包重复install如果语义已满足且owned无变化，changes为空且不为重排原文件格式而写回。conflicts在写之前收齐，禁止部分安装。

安装文件的mode为0..511整数，和资源锁只记录execute语义是不同契约：共享文件更新/恢复保持原0777权限，不得把0600配置扩大为0644；新共享JSON、record/journal/备份为0600，事务目录0700；自有普通产品文件0644、可执行产品文件0755。新target和`.agent-modes`目录0700，已有target目录权限不擅改；target及其下待操作目录须归当前uid且无group/other写权限，拒绝已有特殊权限位文件。manifest/journal权限不安全时拒绝读取/应用；beforeHookFile可能含其他工具私密配置，只存在受保护记录内。回滚恢复权限也恢复内容，验证不能只比较execute位。

planDigest=sha256(canonical(plan除planDigest字段))，覆盖agent/target/operation/全部内容及警告冲突。JSON预览包含FileImage完整文本；text预览列path/action/before/after摘要及hook/skill变更详情。`--apply --expect`重新按相同路径和包准备计划；不是反序列化/执行用户提供的任意计划文件。摘要不匹配、目标文件/权限/真实父路径变化都报E_PLAN_STALE；apply在目标内exclusive锁下复查路径类型、摘要及状态。目标及任一既有父段是symlink、目标由其他owner占用、共享配置或未被本工具record拥有的目标文件含字面标记`GENERATED by evoloop`时E_INSTALL_CONFLICT；不对自己的runtime代码做字面标记误判，不添加force绕过。工具不承诺抵抗另一个具有相同用户权限、专门在lstat与rename间恶意替换目录的进程，但要在rename前再次校验父inode/realpath，避免普通竞态误写。

事务流程：拿锁→完整复验→私有staging中写所有after并fsync→写journal/原字节备份→逐文件同目录rename（record最后）→fsync目录→清理journal/备份/锁。journal记录完整原plan、planDigest、每文件before/after及本次创建目录，只有父进程死亡且路径/owner校验通过时才允许恢复；残留锁中的pid仍存活即E_BUSY。多文件不是一次原子rename：中途异常必须按journal恢复原字节/缺失状态。预览发现journal报E_BUSY并在details给出原operation/planDigest，不隐式写入；重试同operation的`--apply --expect <原digest>`才有恢复授权，先在锁下回滚，再重建新计划核验expect，变化则仅恢复后报E_PLAN_STALE。这个顺序避免“预览永远报busy，apply无路可恢复”。每文件当前内容/权限必须等于journal的before或after才可回滚，第三方改动报冲突，禁止覆盖。空父目录仅删除本事务创建且仍为空者；不递归删除target。owned文件也要校验完整mode，不能只校验bytes。

卸载重新解析当前共享JSON：若仍等于record.afterHookFileDigest则恢复beforeHookFile原字节（原先不存在则删除）；若他人已修改整个文件但本工具group仍完全相同，则只删除该group，保留其余key/组/顺序，移除本工具创建且现已为空的hooks/SessionStart容器；是否创建这些容器可由beforeHookFile判断。不能恢复整份旧备份盖掉新编辑。如果组丢失/变了、owned文件新增/变了、入口skill树多出未记录文件，就整体冲突，不删他人内容；record保留供处理。完成后移除record、未改owned runtime/skill文件、属于本工具的空目录；不删内容库/配置/Git资源。不存在record时uninstall无操作；有record而缺owned文件不是成功卸载，而是漂移冲突。

安装检查state/config准备成功，确保hook首轮能离线render；preview本身不调用同步。安装阶段不创建任何agent会话，不运行目标已有hook。Codex信任提醒、Claude失败不能block的限制进入plan.warnings（固定code与文本、无动态时间）。

## 11. 入口 skill 与交付限制

包内 `skills/agent-modes/SKILL.md` 仅由integration owner维护，name固定agent-modes。它指导agent使用本工具的init/import/sync/resolve/render、理解plan原因及维护modes.json/.mode，先预览install/uninstall；明确自动首轮执行由hook/wrapper完成，skill不能自行保证。说明资源默认索引、scripts需按任务显式调用、不自动执行；禁止把来源当命令或改真实全局配置。只写这份产品必需skill，不附带README/示例代码/仓库测试。

首次交付只声称CLI/离线内容/agent协议及启动参数已验证。真实付费模型未调用时必须明确这一点；provider缓存效果、所有agent版本/环境及多层手工重复hook不作保证。实现遇到本协议不支持的来源/argv/体量要返回明确错误，不用静默降级拼出看似完整闭环。
