# modeck 详细设计

阶段：hard详细设计，2026-10-16；经ultra review修订并收口，作为v1 Interface。任务与文件归属见 `tasks.md`。本轮只设计，不实现、不写测试代码、不操作真实全局配置、不发布或推送；这不限制产品在用户显式授权后安装到其真实HOME。以 `architecture.md` 为需求基线；本文明确收敛处优先作为standard实施契约。

## 1. 收敛后的闭环与 Module

Node.js >=20，TypeScript strict，ESM，首版支持 macOS/Linux。Windows 在写入前报 `E_PLATFORM`，不生成不能执行的 shell hook。包名为 `modeck`，bin 为 `modeck`；无 ai-rulez 依赖。只提供 Claude Code、Codex 两个真实 Adapter。

闭环是 `init/import → 编辑配置 → res init → resolve/render → install 或 run → uninstall`。init 创建有 Git 元数据的新配置目录；import 导入指定 Git revision 到新目录；两者都不隐式安装、联网同步资源或修改本机指针。配置仓库由用户正常 Git 提交/分享，下载内容及机器状态不进入仓库。

三个 Module 的 Seam：

| Module | 隐藏的 Implementation | 对外 Interface |
| --- | --- | --- |
| core | 校验、特征采集、DAG 展开、稳定编译 | 规范化配置、纯 resolve/compile；唯一公共 contracts |
| resources | Git、本地树快照、锁、内容库、校验与原子发布 | 离线 readResources；安装由 res init/update 管理 |
| integration | 命令行、hook 编码、wrapper、安装/进程内回滚 | CLI 与两套 Adapter；只编排前两个 Module |

core 不导入 resources/integration；resources 只导入 `contracts` 的类型、协议常量及公共纯工具，不导入 core Implementation；integration 只从三者的公开 index/contracts 导入。共享契约只能由 core owner 修改；另两人不自行复制或“补一份”类型。

## 2. 路径、编码与身份

CLI 的 `--config <dir>` 指配置目录，不是文件。优先级：显式参数 > `MODECK_CONFIG` > `$HOME/.config/modeck`。状态目录：`--state <dir>` > `MODECK_STATE` > `$HOME/.local/share/modeck/v1`。相对 CLI 路径在入口进程原 cwd 下解释一次，再检查路径链并转为realpath；不存在的目标从最近存在父目录解析。config/state/destination/target先逐段lstat拒绝symlink，再取得真实路径，不能先realpath抹掉恶意symlink证据（隔离验证使用真实`/private/tmp`路径）。禁止配置目录和状态目录相同或状态目录位于配置目录内；无额外“当前配置指针文件”。

共享路径统一为 POSIX 相对路径：非空，无绝对前缀、反斜杠、空段、`.` 段（单独的资源根 `.` 除外）、`..` 段、NUL/控制字符、`.git` 段；文件名必须 NFC。标识符匹配 `^[a-z][a-z0-9-]{0,63}$`。本地资源路径必须在配置根内；Git path 必须在指定 commit 内。仅普通文件/目录，首版拒绝全部 symlink、gitlink、设备、FIFO、socket；不是只检查字符串。每次访问以 lstat/realpath、根内 containment 和父目录逐段检查共同校验，拒绝 symlink 父目录。入口 cwd 可以是 symlink 的别名，先 realpath；共享内容及安装目标不接受 symlink。

统一 `Sha256` 为 64 位小写 hex（不含 `sha256:`）；Git commit 是 40 位小写 SHA-1（首版拒绝 Git SHA-256 仓库）。所有 JSON 为 UTF-8，拒绝重复 key、非有限数字、孤立surrogate及未知字段；不做字符串到布尔/数字转换。JSON Schema 用 draft 2020-12，不启用自动 removeAdditional/coerceTypes。输入 JSON 上限 1 MiB，锁/本机 manifest 上限 8 MiB。公共 `parseJson` 在 JSON.parse 前检测重复 key，不能靠解析后的对象补查；各读取入口都调用它，大小上限由调用方按文件类别先检查。该工具也用于读取共享agent JSON，不让resources/integration另写宽松解析器。

canonical JSON：对象 key 递归按 JS 字符串 `<` 顺序排序，数组保序，无空白，UTF-8；展示用 JSON 另以两空格缩进加一个 LF。配置补齐本文规定默认值后计算 configDigest；`resources`/`modes` 是对象，其 key 不参与声明顺序。所有显式有序项必须是数组。共享配置/锁/selection身份摘要不含绝对路径、mtime、日志、时间或临时文件名；contentDigest及安装planDigest分别按其契约覆盖实际正文/计划字节数据，不能为稳定比较漏掉真实路径。

运行时外部文件读取必须先lstat确认普通文件，再以`O_NONBLOCK | O_NOFOLLOW`打开并对已打开handle再次fstat确认普通文件；这样既拒绝FIFO/device/socket，也避免lstat与open之间替换为FIFO造成阻塞。此约束覆盖配置/selector/lock、资源与manifest、共享agent配置/安装record及显式append文件；不以“open后会检查类型”替代非阻塞打开。

## 3. 输入 JSON Schema（完整 v1 形状）

core 提交三个文件 `schemas/modes.schema.json`、`selector.schema.json`、`lock.schema.json`。下列 JSON 就是各文件的规范内容；表后语义检查也是强制校验。Schema 的 `$id` 使用 URN，校验不联网。

`modes.schema.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:modeck:modes:1",
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
  "$id": "urn:modeck:selector:1",
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
  "$id": "urn:modeck:lock:1",
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

`sourceDigest = sha256(canonical({kind,source}))`，其中 source 是规范化描述；`resourceSpecDigest = sha256(canonical(config.resources))`。lock.resources 按 id 升序，与配置 id 集合严格相等；local 的 commit 必须 null，git 必须 commit。entries 按相对 path 升序、唯一，目录条目包含空目录，根目录不入列表；父目录必须存在且为 directory，不允许文件/目录冲突或大小写折叠碰撞。treeDigest 是 `sha256(UTF8("modeck-tree-v1\n") + UTF8(canonical(entries)))`。文件 digest 是原始字节的 SHA-256，executable 是源任一 execute bit 是否置位；不记录 uid/gid/mtime/其余权限。

rule 源必须是一个 UTF-8 文件，物化后统一名为 `tree/content.md`；skill 源必须是包含根级 `SKILL.md` 的目录，完整物化全部目录/文件，绝不只复制 SKILL.md。不得默认排除 scripts/references/assets 或任意隐藏文件（`.git` 是拒绝而非静默忽略）；包含不安全条目则整个资源失败。每树最多 10,000 条目、总文件 64 MiB、单文件 16 MiB；rule/SKILL.md 各至多 1 MiB；资源总量最多 512 MiB。超限失败，不发布部分树。

SKILL.md 使用 UTF-8 YAML frontmatter，单个文档，无自定义 tag/alias，根为 mapping，必需 `name`/`description` 两个非空 string；name 匹配上述 id（最多64），description 最多1024 UTF-16 单位，允许LF/CR/TAB以支持常见YAML folded/literal多行描述，拒绝其余控制字符。其他 frontmatter 字段保存在原文件，但本工具不执行或解释其中 hooks/权限等字段。全配置 skill name 唯一，旧入口保留名 `modeck` 不可占用，扫描继续排除它以免迁移旧入口。YAML 用受限 yaml parser，不写简陋正则解析多行 description；原始 frontmatter/脚本均纳入树摘要。

固定内容库位置：`<state>/store/sha256/<treeDigest>/tree/`，旁边是 `manifest.json`（entries 的 canonical JSON + LF）。内容库独立于配置路径，可跨配置复用。文件物化成 0444/0555，目录 0555，执行位语义保留；验证摘要不依赖其余权限。发布用同文件系统 staging + rename，已有目标必须验证后才复用，损坏目标报 `E_INTEGRITY`，不可“相信目录名”。不自动 GC；因此已输出的 skill 绝对路径在卸载 adapter 后仍然有效。

外部资源通过 `res init` 按声明和 `modeck-lock.json` 同步：已安装项校验后跳过，缺失项按锁定 commit 恢复，新增声明首次安装并加入锁；`res update` 获取默认分支并更新安装内容和锁。运行期读取所选本地资源与已安装资源并验证完整性，不联网获取资源。

Git url 支持 `https://`、`ssh://` 以及以 `./` 开始且位于配置根内的本地仓库目录（用于离线分发/fixture）；不支持 scp 简写、git ext/helper、任意绝对本机路径、URL 密码或控制字符。ref 接受 HEAD、完整 commit、合法分支/tag 名；分支/tag 同名且无法唯一解析时报错。路径字符串按第2节校验；本地仓库真实目录及父目录不可为 symlink。锁保留相对描述的摘要，不保存展开后的绝对 URL。日志去除 URL 凭据。

Git 子进程使用 argv，无 shell；清除继承的 `GIT_*`（需要的显式重建），禁用 system/global config、credential helper、hooks、templates、未授权 protocol、submodule recursion、prompts、filters；远端只按已校验scheme开放https或ssh，本地来源只开放file。Git 工作目录为工具 staging，不在来源目录执行工作树操作。首版https支持公开仓库，私有仓库通过ssh现有key/agent认证，交互提示关闭，不接受来源指定 sshCommand。对 ssh 不插值 URL 到 shell 命令。抓取到全 commit 后，以 `ls-tree -rz`/`cat-file` 提取普通文件，不 checkout、不触发 LFS/filter/submodule；LFS 指针视为普通字节，不能宣称已经下载 LFS 实体。网络命令每次最多120秒，输出受限，失败清理 staging。frozen 抓取旧 commit 不可用则明确失败，不能替换成 ref 的新头。

init 的最小内容为 `modes.json`（schemaVersion1、defaults=[base]、单个空语义base、resources={}；base默认字段由parseConfig补齐后写出）及工具生成的 `.git`；不创建 README/样例规则/锁。destination 必须不存在，父目录安全，失败不留下半成品。import 同样只接受新 destination；url 接受上述远端 URL，另外 CLI 的显式本地绝对 Git 目录可用于导入（不写入资源描述）。以 `git init + fetch + read-tree` 和受约束的 tracked tree 物化建立普通可提交配置仓库，设置 origin、HEAD/本地分支 `main` 指向所选 commit；不执行 checkout/hook，不自动安装资源，不复制远端仓库控制目录。拒绝导入 symlink/gitlink/不安全文件树；`.git` 仅为本工具创建的元数据。配置与已有锁经回调校验后才 rename 到 destination。接收者通过 `res init` 恢复锁定的外部资源。本地资源分享要求其所有文件已提交；Git不保留空目录，需由用户放置占位文件，否则接收者frozen应明确失败，不能默默丢目录后通过。相对本地Git源也须随配置完整分发，否则不具备跨机器复现前提。

## 5. 解析与稳定编译

collectFacts：验证 cwd 为目录，用 Git worktree 根为 boundary（支持 `.git` 文件、嵌套仓库以最近 Git 根为准）；非 Git boundary=cwd。不在 Git 时不向上读 `.mode`；在 Git 内从 cwd 向 boundary 逐级查找，最近的一个 `.mode` 生效。路径上的无效/不可读 `.mode` 立即失败；找到了就不继续叠加父级。

检测只扫描 boundary 内普通文件，排序后输出相对路径；不跟随 symlink。固定排除目录名 `.git,node_modules,dist,build,coverage,.next,.turbo,.cache,.modeck`，以及位于 boundary 内的 state 真实目录。最多遍历20,000条目录项/10,000文件，深度64，文件路径1024字符；package.json/selector 各1MiB。即使可提前判定 exists，也必须完成限额检查；超限 `E_SCAN_LIMIT`，无部分 plan。不存在根 package.json 则依赖集合为空；存在但不可读/非法则失败。相对路径按第2节排序；检测不读正文、不看 dirty/mtime/分支。

resolve 为纯函数，输入规范配置、facts、configDigest/lockDigest，输出 ResolvedPlan：

1. seeds = defaults +（auto=true 时，detect.any 至少一项命中的 mode 按 priority 升序/id升序）+ selector.add；保留重复 seed 的全部 reason。
2. 去掉 disable 中直接出现的 seeds；add/disable 重叠是 `E_MODE_CONFLICT`。沿每个 seed 声明的 extends 做有序 DFS，父先子后，首次出现保序去重。若任何保留 seed 的传递父在 disable 中，报冲突并带依赖链，不重新加入父。
3. 最终 mode 列表按上步顺序；每个 mode 依次取 rules、skills。资源首次出现位置确定最终顺序；同一 skill 任一绑定 preload=true 则合并为 true，但不改变第一次位置。rule 的 preload 恒 true。
4. reasons 只描述最终保留mode，按seed/DFS遇到顺序记录；via=parent时mode是被展开的父mode、from是声明extends的子mode，conditionIndex=null；via=detect时conditionIndex是detect.any中首个命中位置，其余from/conditionIndex均null。重复seed的各来源仍保留。不进入正文。diagnostics 首版成功为空数组；失败抛错，不成功返回半个 plan。

compile 不采集文件或联网；输入 plan 与 resources 返回的 VerifiedResourceSet（绑定文件已读成字节）。必须确认二者 configDigest/lockDigest 一致；不在 Adapter 重算 plan。公开 CLI resolve 也先离线验证资源，随后输出 plan；render/hook/run 复用同一个准备流程。

协议 `modeck-context/1` 的正文顺序及标点固定：

- 第一行 `# modeck-context/1`；其后依次 `agent: <codex|claude>`、`selection: <selectionDigest>`、`modes: <canonical JSON modeIds>`，空行。不写整配置或整锁摘要。
- 每个 rule 按最终有序资源中的 rule 顺序：`## rule <id>`、空行、规范化全部正文、空行。
- `## skills`，空行，固定一行 `Skill paths resolve from the indexed root; scripts are not run automatically.`，空行；每个 skill 按最终 skill 顺序一行 canonical JSON，字段为 `id,name,description,root,entry,preload`；root 是内容库 tree 的绝对路径，entry 为 root + `/SKILL.md`。JSON 字符串引用路径，不能裸拼路径到指令/shell。
- 每个 preload skill：空行、`## skill <id>`、空行、去掉 frontmatter 后的完整正文。
- 尾部恰一个 LF；无 skills 时保留空 skills 节。不将诊断、wrapper 标记、用户已有 developer instructions 放入这份正文。

rule/preload 文本按 UTF-8 fatal 解码，去单个 BOM，CRLF/CR统一LF，去末尾连续换行后加一个LF；内部空格/空行不重排。description 使用 YAML 解析后的字符串，JSON escape 换行，不产生额外正文行。正文总上限为9,000 UTF-16单位且32,768 UTF-8 bytes，两者都检查；超限 `E_CONTEXT_SIZE`，不截断、摘要化或偷偷关闭 preload。所有 render/hook/wrapper 一致执行该上限；它让 Claude 的10,000字符 spill 阈值留有余量。Codex handler 设 additionalContextLimit=0，依靠本工具硬上限避免其默认2,500 token spill。完整技能树不受正文上限限制，默认只索引按需读取。

`lockDigest = sha256(canonical(已校验锁))`，只用于输入一致性校验、resolve/JSON诊断，不参与稳定正文。按本轮稳定性补充，这一契约优先于architecture中将整锁变化视为上下文变化的早期描述。`selectionDigest = sha256(canonical({protocol,agent,modeIds,resources}))`，其中resources严格取plan最终有序绑定，逐项仅为`{id,kind,treeDigest,preload}`；不取全配置、全锁、detector、选择原因、source URL/ref或Git commit。treeDigest覆盖选中资源完整树及execute语义，因此未preload的skill资产/脚本变化也能改变身份；Git固定commit变了但同一选中树不变则正文不变。

`contentDigest = sha256(实际 text UTF-8 bytes)`，text自己不包含contentDigest，避免递归。RenderedContext同时返回selectionDigest/text/contentDigest/byteLength；其中configDigest/lockDigest只是诊断元数据，禁止被Adapter再拼进注入正文。在同一state绝对位置内，只要选中mode顺序、选中资源绑定/树/preload、agent和协议相同，text与contentDigest必须相同：无关detector或未选资源的合法变更即使改变configDigest/lockDigest，也不扰动正文。整JSON输出的诊断字段可以不同，验收比较text/selectionDigest/contentDigest，不比较整个render JSON。


这个摘要只覆盖本工具text。Codex/Claude原生skill初始索引也可能包含绝对路径；迁移HOME或原生skill安装位置会改变agent自己的model-visible prompt，即使本工具text/digest不变也不能声称完整前缀相同。不得为了缓存比较从原生索引里删去实际资源定位。

## 6. 公共导出类型与函数（core 独占）

`src/contracts/index.ts` 只含下列类型、只读协议常量与无副作用 JSON解析/canonical/hash/path词法/错误工厂函数；所有属性/数组语义为 readonly。这里用紧凑 TS 声明固定字段，实施必须用深层只读类型表达，不得增删字段或以 any 擦除契约。外部未经校验的输入一律 unknown。

```ts
type Id = string;
type Sha256 = string;
type Agent = "codex" | "claude";
type Kind = "rule" | "skill";
type Source = { type: "local"; path: string }
  | { type: "use"; url: string; path: string };
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
type RenderedContext = { schemaVersion: 1; protocol: "modeck-context/1"; agent: Agent; configDigest: Sha256; lockDigest: Sha256; selectionDigest: Sha256; modeIds: Id[]; text: string; contentDigest: Sha256; byteLength: number };
type HookEvent = { hook_event_name: "SessionStart"; cwd: string; session_id: string; source: "startup" | "resume" | "clear" | "compact" | "fork" };
type HookReply = { hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string } } | null;
type RunMarker = { version: 1; agent: Agent; configRoot: string; stateRoot: string; cwd: string; contentDigest: Sha256; ownerPid: number };
type FileImage = { data: string; encoding: "utf8" | "base64"; mode: number };
type FileChange = { path: string; category: "shared-json" | "owned"; beforeDigest: Sha256 | null; beforeMode: number | null; after: FileImage | null };
type InstallPlan = { schemaVersion: 1; operation: "install" | "uninstall"; agent: Agent; targetHome: string; owner: "modeck/v1"; changes: FileChange[]; conflicts: Diagnostic[]; warnings: Diagnostic[]; planDigest: Sha256 };
type ManagedFile = { path: string; digest: Sha256; mode: number };
type InstallRecord = { schemaVersion: 1; owner: "modeck/v1"; agent: Agent; configRoot: string; stateRoot: string; runtimeDigest: Sha256; files: ManagedFile[]; hookFile: string; hookGroup: unknown; beforeHookFile: FileImage | null; afterHookFileDigest: Sha256 };
type LockParser = (value: unknown) => ResourceLock;
type ImportValidator = (stagingRoot: string) => Promise<void>;
type LoadConfigRequest = { configRoot: string };
type CollectFactsRequest = { cwd: string; stateRoot: string };
type ResolveRequest = { context: ConfigContext; facts: ProjectFacts; lockDigest: Sha256 };
type CompileRequest = { plan: ResolvedPlan; resources: VerifiedResourceSet; agent: Agent };
type InitConfigRequest = { destination: string; initialConfig: Config };
type ImportConfigRequest = { url: string; ref: string; destination: string; validate: ImportValidator };
type ReadResourcesRequest = { context: ConfigContext; stateRoot: string; parseLock: LockParser };
type PrepareRequest = { configRoot: string; stateRoot: string; cwd: string; agent: Agent };
type PreparedContext = { plan: ResolvedPlan; rendered: RenderedContext };
type EncodeHookRequest = { event: HookEvent; rendered: RenderedContext; marker: RunMarker | null; configRoot: string; stateRoot: string };
type PlanInstallRequest = { agent: Agent; targetHome: string; configRoot: string; stateRoot: string; runtimeRoot: string };
type PlanUninstallRequest = { agent: Agent; targetHome: string };
type ApplyInstallPlanRequest = { plan: InstallPlan; expectDigest?: Sha256 };
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
| resources/index | `readResources({context,stateRoot,parseLock})` | Promise<VerifiedResourceSet>；只读、离线、完整验证 |
| integration/index | `prepare({configRoot,stateRoot,cwd,agent})` | Promise<{plan:ResolvedPlan,rendered:RenderedContext}>；唯一 load/read/facts/resolve/compile 编排 |
| integration/index | `encodeHook({event,rendered,marker,configRoot,stateRoot})` | HookReply；纯编码/身份与摘要检查，marker:RunMarker\|null；pid存活检查在hook I/O入口完成 |
| integration/index | `planInstall({agent,targetHome,configRoot,stateRoot,runtimeRoot})` | Promise<InstallPlan>；runtimeRoot为包根，预览无写入 |
| integration/index | `planUninstall({agent,targetHome})` | Promise<InstallPlan>；读取record、共享JSON及现状 |
| integration/index | `applyInstallPlan({plan,expectDigest})` | Promise<void>；expectDigest可省略，提供则校验；始终复验本工具重建的计划，不接收CLI任意JSON计划 |
| integration/index | `runAgent({agent,configRoot,stateRoot,cwd,argv,executable})` | Promise<{exitCode:number\|null,signal:NodeJS.Signals\|null}>；exec必须绝对路径/已解析PATH实体 |
| cli/main | `main(argv: string[])` | Promise<number>；bin负责设置exitCode，禁止module import时自动启动 |

上列Request/Return类型也全由core从contracts/index导出，函数参数使用对应命名类型；不让三路对着inline object猜测。resources 不依赖 core 校验器，因此 parseLock 和 import validate 从 integration 显式注入；import validate 必须 loadConfig，若有 lock 则 parseLock 并比对 resourceSpecDigest/集合/描述，但不联网、不要求内容库。资源层自己完成锁与配置/树语义交叉校验。ModeError 用公共工厂 `modeError(code:ModeErrorCode,message:string,details:Readonly<Record<string,unknown>>):ModeError` 导出，避免跨 Module 的 instanceof 失效。`src/cli/main.ts`可导入而不执行；单独`src/cli/bin.ts`作为构建的可执行入口，调用main并处理退出码/信号。

## 7. CLI 契约

仅支持下表；未知参数/重复标量参数报 E_USAGE。公共参数必须在命令之后、run 的 `--` 之前；不支持用位置参数猜目录。`--cwd` 默认入口 cwd，只用于 resolve/render/run；hook 必须用 stdin cwd，禁止用进程 cwd替代。所有 flag value 的 `--x=y` 与 `--x y` 等价。`--help`/`--version` 不读取配置、不联网/写状态。普通JSON输出都是完整单个对象加LF。

| 命令 | 参数与默认值 | stdout / 结果 |
| --- | --- | --- |
| `init` | 必需 `--dir` | `{schemaVersion:1,configRoot}`；新目录，最小配置+git init |
| `import` | 必需 `--from`,`--dir`；`--ref HEAD` | 同init；校验成功才发布 |
| `resolve` | `--config`,`--state`,`--cwd` | ResolvedPlan（始终JSON，不另设 --json） |
| `render` | 同resolve；必需 `--agent`；`--format text\|json` 默认text | text 原样；json为RenderedContext |
| `hook` | 必需 `--agent`；`--config`,`--state` | stdin事件→一次HookReply JSON；去重/跳过stdout空，exit0 |
| `install` | 必需 `--agent`,`--target-home`；`--config`,`--state`；`--format text\|json` 默认text；可选 `--apply`、与apply联用的`--expect <digest>` | 默认预览InstallPlan，不写；apply前重建计划，提供expect时核验，成功仍输出本次InstallPlan |
| `uninstall` | 必需 `--agent`,`--target-home`；format/apply/expect 同install | 输出InstallPlan；无record且无本工具遗留内容时返回空changes幂等计划 |
| `run` | 必需 `--agent`；`--config`,`--state`,`--cwd`；可选 `--executable`；`--` 后 agent argv 原样分词 | stdio继承，退出码/信号见wrapper契约 |

`--target-home` 是显式HOME根，不是`.codex`/`.claude`目录，禁止省略；本参数替代旧草案的target-root，不保留含糊别名。Codex固定写`<target-home>/.codex/hooks.json`；Claude固定写`<target-home>/.claude/settings.json`。不安装入口skill。manifest/runtime固定在该HOME的`.modeck/<agent>/`下。不跟随安装进程继承的CODEX_HOME/CLAUDE_CONFIG_DIR重定向写入。产品允许用户通过显式target-home和apply安装到真实HOME，无额外永久拒绝或real-home绕过flag；所有权/路径/权限冲突仍拒绝。当前任务仅获准在隔离HOME内调用产品，不能因此增加产品禁令。原生agent验证由验证进程显式设置HOME及相应CODEX_HOME/CLAUDE_CONFIG_DIR到隔离布局，工具不改父进程环境。hook命令固定带绝对config/state路径，不受后来环境变量改变。

除 run 透传外，exit0成功；2=usage/config/selector/resolve/size；3=资源/Git/锁/路径/IO；4=安装冲突/陈旧计划/busy；5=hook事件非法或wrapper能力/冲突；错误 stderr 为 `{error:{code,message,details}}` 单行JSON，不在stdout夹日志。hook内部失败统一exit1，stderr同格式，stdout空；不伪装成功的空规则。install冲突预览仍输出完整plan但exit4；apply不要求expect，expect未与apply联用是E_USAGE，提供但不匹配是E_PLAN_STALE。hook输入最多1MiB，session_id为非空string（最多256，无控制字符），忽略agent额外已知/未来字段，只严格校验本工具消费字段，hook_event_name/source不支持则E_HOOK_INPUT。hook入口先把stdin cwd校验并realpath规范化，再构造传给prepare/encodeHook的HookEvent；禁止退回进程cwd。

## 8. 两个 Adapter 与去重

依据为本轮提供的 `/tmp/mode-codex-hooks.md`、`/tmp/mode-claude-hooks.md`、`/tmp/mode-codex-skills-jina.md`，以及本机只读核查 `codex --help/debug --help/app-server generate-json-schema`（0.162.1）、`claude --help`（2.1.296）。不是运行真实模型的证据。[Codex skills官方文档](https://developers.openai.com/codex/skills/)明确USER为`$HOME/.agents/skills`，REPO为cwd至repo根各层`.agents/skills`；不能把只写旧`.codex/skills`当发现成功。其他原始出处见architecture.md；实施时不把临时依据路径写进产品。

两个hook文件均采用一个独立 matcher group：`matcher = "^(startup|resume|clear|compact|fork)$"`，`hooks` 中只有本工具一个 `type:"command"` handler，timeout=15秒。Codex 写 `<target-home>/.codex/hooks.json` 的 hooks.SessionStart；Claude 写 `<target-home>/.claude/settings.json` 同一字段；输出均为 `{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:text}}`。Codex handler另有additionalContextLimit=0。不得假造 managed/trusted 状态，不写信任存储，不生成 bypass-hook-trust 参数；安装预览/结果警告其新/变更定义须在真实会话 `/hooks` 审阅，否则可能跳过。Claude首次响应等待SessionStart完成，但退出失败不阻止请求；Codex也不能把hook失败一概说成fail-closed。

命令使用安装内固定 runtime 的 Node 绝对路径与CLI绝对路径，分别做POSIX单引号转义，不依赖npx临时路径、PATH同名程序、git root或cwd。根目录有空格/单引号也必须可执行；资源路径不拼入命令。runtime CLI 以bundled单文件安装，不复制未解析的 node_modules 引用。

去重分两层，不把“同session已经注入过”当通用依据：

1. 安装幂等：record中保存完整hook group，重复install复用/替换该组而不是append；保留其他handler/group及其相对顺序。一个target-home内每个agent只允许一个配置绑定，换config/state须先uninstall该agent。识别同runtime/owner的重复或手工改写组即冲突，不猜测并删除。Codex该层同时存在inline hook时保留它并警告；不得擅自迁移。
2. wrapper去重：仅在spawn已准备好完整附加指令时，将 canonical RunMarker 放入子进程环境 `MODECK_RUN_V1`（不写父环境/正文）。hook入口检查marker结构与ownerPid存活，再prepare并验证资源；encodeHook检查真实cwd/config/state/agent及contentDigest全部匹配，才返回null/exit0。marker非法、父wrapper已死、摘要/cwd不一致时抛E_WRAPPER_CONFLICT，不能当没看见然后追加第二份。wrapper子进程后续clear/compact在同配置/目录下仍由持久system/developer指令覆盖，匹配marker时继续跳过；wrapper路径不支持会话中切换mode/cwd，要重启。

纯hook路径的resume/clear/compact/fork每次重新注入，不落持久session去重文件；避免第二次compact或不同会话丢规则。一次安装保证本工具在该target只有一个组；首版不承诺对手工复制到多个config层/第三方plugin的重复hook去重，预览发现已知多来源时告警。不能用`session_id+source`永久缓存假装解决这一问题。支持的部署方式为每个agent一个生效的modeck安装；多层手工复制属于冲突配置，须清理后使用。

## 9. wrapper 契约与 Codex 有效配置

wrapper只支持创建本地新会话及Claude `-p/--print`、Codex `exec`；不包装维护/登录/远程/共享daemon/已有session操作。检测argv必须在消费flag值的语法下进行，不能把prompt里出现的 `-C` 子串当flag。实现两套小型、显式arity的已核查参数表；拒绝未知flag/子命令（能力不明则失败），支持已知flag的 `--x=y`。prompt和 `--` 后面全部是数据，禁止扫描误伤。完整允许表写在integration的adapter内，仅允许下述支持集，不能另放共享contracts副本：

- Codex：新交互会话或 `exec`/`e`；根级 `-m/--model`、`-s/--sandbox`、`-a/--ask-for-approval`、`--search`、`--no-alt-screen`、`--no-daemon`、`-c/--config`；exec另允许`--json`,`--skip-git-repo-check`,`-o/--output-last-message`、最后一个prompt（`-`保留stdin）。允许`-C/--cd`仅用于等值核验；不支持`-p/--profile`、`--worktree`、`--remote`、resume/fork/review、多值image/add-dir及不明别名。
- Claude：新交互会话或`-p/--print`；`--model`,`--effort`,`--permission-mode`,`--output-format`,`--input-format`,`--max-budget-usd`,`--verbose`,`--no-session-persistence`，最后一个prompt。接受`--append-system-prompt`或`--append-system-prompt-file`单个值作为用户附加正文，二者互斥，不直接透传（合并后只发一个append）。拒绝替换system prompt的所有形式、resume/continue/fork、worktree/tmux、远程/desktop、--settings/--setting-sources/--agent/--bare/--safe-mode等改变加载来源/提示语义的参数。

shell以外调用方若要更广参数，先扩展契约再实现，不能默默透传已知会改变目录/提示来源的参数。现有argv逐token解析；除消费掉的等值cwd、用户append及Codex developer override之外，其余支持token保留原顺序、值与字节（不重新shell分词）。重复标量安全相关flag一律拒绝；Codex -c 允许重复不同key，同key也拒绝。

根级维护/配置子命令及Codex exec下的resume/review等已有会话路由均须拒绝，按已核查CLI的完整保留命令集合处理，不能只列少量黑名单。已知保留命令若是字面prompt，调用者须放在显式agent `--`之后；该分界之后始终是数据。其他裸prompt发送给agent前也插入真正的`--`数据边界，保证未来新增子命令不会把prompt解释成维护操作。检查只读help及假进程argv，不实际执行维护命令。

cwd唯一来源是CLI `--cwd`的realpath；Codex用户的 -C/--cd（包括=形式）解析后必须与它相等，否则E_WRAPPER_CONFLICT（不擅自选一方）；相等则移除，最终固定注入一个 `-C <cwd>`，spawn也用同cwd。拒绝可能另建worktree/切换session的参数。Claude使用spawn cwd而无额外切目录参数；原生额外目录不代表mode选择根，首版不支持。解析冲突在prepare/启动之前完成。

Claude：读取用户唯一append字符串或文件的原字节UTF-8文本（文件不要求在配置根，但必须显式指定且普通文件，不能symlink），保持它的字符内容；若非空，加 `\n\n` 后接mode text，通过单个 `--append-system-prompt` 传给CLI。无用户append则值严格为mode text。保留默认系统提示、cwd、原生CLAUDE.md及既有settings。首版wrapper拒绝resume，是因为本机help指出system prompt snapshot可能复用旧append，不能承诺新mode被纳入旧会话。合并值超过64KiB bytes时E_LIMIT，不经shell或临时路径降级。

Codex不能自己猜测`~/.codex/config.toml`的层叠规则。固定有效配置探测协议：

1. 使用同一已解析codex executable、相同env/CODEX_HOME、同cwd、用户原始全部`-c key=value`启动独立`codex [这些-c] app-server --stdio`，不连接proxy/daemon。仅交换本地JSON-RPC，不创建thread、不请求模型、不调用config/write。
2. newline JSON messages：`initialize` id1，params为 `{clientInfo:{name:"modeck",version:<包版本>},capabilities:{experimentalApi:false}}`；成功后`initialized`通知；`config/read` id2，params为 `{cwd:<real cwd>,includeLayers:true}`。这是0.162.1生成的ConfigReadParams契约；ConfigReadResponse含config、origins及请求的layers。只接受对应id的result，不把notification当result；总10秒、响应上限8MiB、错误即终止探测进程并报E_CODEX_CONFIG。
3. 取`result.config.developer_instructions`。string原样保留，null/缺失仅在有效layers均无该配置时视为空；类型不符、响应缺layers、发现层中有值但effective缺失、disabledReason不明导致无法判定时拒绝。不从调试prompt里提取/重复原生AGENTS.md，不靠JSON中第一条developer消息猜基线。logs不得输出已有指令正文。
4. `-c` key只接受无引号的 `[A-Za-z_][A-Za-z0-9_.-]*` 后接`=`，value原样交给Codex解析；拒绝`profile`、`model_instructions_file`、`instructions`及其下级，防止替换基础提示；developer_instructions只允许精确顶层key，值由config/read解释。启用的layers中若指定model_instructions_file或不可解释的开发者指令替代来源，也拒绝，保留不了原生语义就不覆盖。用户-c和层中已有developer_instructions可为多行/引号/backslash，必须保持内容前缀不变。
5. 合并值是 baseline +（非空时`\n\n`）+ mode text；不规范化baseline。删除原argv里精确developer_instructions override，其他-c原样保留；最终生成一个`-c developer_instructions=<JSON.stringify(合并值)>`，JSON字符串仅作为TOML基本字符串的编码（拒绝NUL/不合法Unicode；校验编码 round-trip），绝不作为shell quoting。合并值上限64KiB。启动前再次config/read并比对layers版本、effective值/origins，变化则E_CODEX_CONFIG；这是缩小竞态而非声称跨外部修改的原子快照。
6. 实际启动强制 `--no-daemon`、固定-C；同env中放RunMarker。共享daemon可能不继承本次wrapper marker，因此禁止该路径。若版本不支持config/read、--no-daemon或协议形状变更，明确拒绝该wrapper；hook适配仍可单独使用。已读内容仍由Codex自行加载原生instructions；不得使用model_instructions_file替换基础提示。

两个wrapper都用spawn(argv,{cwd,env,stdio:"inherit",shell:false})；不把stdin用于本工具探测（Codex探测使用独立pipe），保留用户stdin供agent。PATH选择后固定真实executable，不得解析回modeck自身。临时移除父进程已有MODECK_RUN_V1：若其存在则拒绝嵌套wrapper，避免错误去重。收到SIGINT/SIGTERM/SIGHUP时转发给子进程，等待退出后移除handler；正常退出保留exitCode，signal终止则bin以同信号终止自身（不能只返回0或吞信号）。spawn失败报E_IO。wrapper预检失败时绝不启动实际会话。

## 10. 安装、所有权与卸载

无record时，自有runtime根的既有占用必须报冲突，包括空目录；不能把空目录当作不存在并接管。record.hookGroup必须与该agent的固定matcher/handler字段、record的config/state、runtimeDigest对应的实际runtime入口交叉核对，不能只接受任意单command对象；身份漂移时整体拒绝。命令中的Node绝对路径允许是安装时的旧路径，不要求等于当前process.execPath，避免Node升级后无法安全卸载或重新安装。

每个显式target-home只管理下列位置；FileChange/ManagedFile/hookFile均相对此HOME，禁止把agent配置目录当路径根：

| 位置 | 所有权与内容 |
| --- | --- |
| `.codex/hooks.json`（Codex）/`.claude/settings.json`（Claude） | shared-json；仅record记载的独立SessionStart组归本工具 |
| `.agents/skills/modeck/`（Codex）/`.claude/skills/modeck/`（Claude） | 仅兼容旧record：完整校验已记录owned树后删除；未记录的同名skill不接管、不检查、不删除，旧owned树漂移则整体冲突 |
| `.modeck/<agent>/runtime/<runtimeDigest>/` | owned最小包布局：`dist/bin/modeck.mjs`、`schemas/`三份schema及`package.json` |
| `.modeck/<agent>/install.json` | owned InstallRecord；只记录本机绝对路径，可含安装前hook原字节；不进入config/lock |
| `.modeck/<agent>/install.lock` | apply期间exclusive锁，内容仅owner/version/pid；正常完成或成功回滚后清理，异常残留用于阻止再次盲写 |

同一HOME可分别安装两个agent，record/runtime/lock互相隔离；每个agent只删除其列出的路径。Codex卸载不得删除`.agents/skills`下其他内容，也不删除旧`.codex/skills`内容。所有父目录仍按第2节安全校验；hook与runtime必须由同一完整计划预览、复验和写入；旧入口清理由同一计划保护。

不得改AGENTS.md、CLAUDE.md、config.toml、其他native skill、信任文件或权限策略。npm包build生成的standalone JS bundle（第三方代码已打入）与schema数据必须包含在tarball，不包含入口skill。core从`dist/core`下的schema加载文件用`../../schemas/`相对import.meta.url读取；打包后入口在`dist/bin`仍是同样两级路径。安装保留上表最小包布局，因此不依赖源码路径、cwd或外部node_modules；版本从该包根package.json读取。runtimeRoot在普通bundle与安装bundle中都由入口URL上溯两级得到，不由工作目录推断。安装runtime从当前包的已校验固定路径复制，不下载、不npm install、不执行生命周期脚本。

Node绝对路径进入hook命令，升级Node后需重新预览安装。runtimeDigest=sha256(canonical(上述最小包布局各文件的相对path/digest/mode列表))，按path排序；不含时间/随机id。record的owned files不包含record自身，避免摘要自引用。加载record须校验全部字段/路径/文件集合；agent不符、未知owner、重复/越界path或不在上表可管理位置的文件一律冲突。record中hookGroup须经agent结构检查后使用，不能据不可信record删除任意target文件。初版允许同包同目标重复安装，升级时只替换记录的runtime及hook组，旧record中的未改入口skill随升级清理，旧runtime仅当它在owned清单且完整未改时删除。

预览是只读操作：读取包资源/目标/config，构造按相对path排序的FileChange；path均相对target，beforeDigest是现有文件原始字节摘要，beforeMode是权限低9位（文件不存在时两者都为null），after为完整内容或null删除。共有JSON对象保留所有未知key和其他hooks；只接受UTF-8严格JSON object，无JSONC/注释/重复key，hooks/SessionStart形状错误报冲突，不自动修复。更新共有文件用稳定pretty JSON；同包重复install如果语义已满足且owned无变化，changes为空且不为重排原文件格式而写回。conflicts在写之前收齐，禁止部分安装。

安装文件的mode为0..511整数，和资源锁只记录execute语义是不同契约：共享文件更新/恢复保持原0777权限，不得把0600配置扩大为0644；新共享JSON、record/lock/临时文件为0600，工具新建私有目录0700；自有普通产品文件0644、可执行产品文件0755。新target和`.modeck`目录0700，已有target目录权限不擅改；target及其下待操作目录须归当前uid且无group/other写权限，拒绝已有特殊权限位文件。manifest/lock权限不安全时拒绝读取/应用；beforeHookFile可能含其他工具私密配置，只存在受保护record内。回滚恢复权限也恢复内容，验证不能只比较execute位。

planDigest=sha256(canonical(plan除planDigest字段))，覆盖agent/target/operation/全部内容及警告冲突。JSON预览包含FileImage完整文本；text预览列path/action/before/after摘要及hook变更详情。apply重新按相同路径和包准备计划；expect可省略，提供时必须匹配重建的planDigest；不反序列化/执行用户提供的任意计划文件。未提供expect意味着按本次新计划执行，不沿用旧预览；仍须在exclusive锁下、每次写入前复查目标原字节/权限/真实父路径，变化报E_PLAN_STALE。目标及任一既有父段是symlink、目标由其他owner占用时E_INSTALL_CONFLICT；未被本工具record拥有的共享配置只合并本工具自己的hook组，其余内容保留，不添加force绕过。工具不承诺抵抗另一个具有相同用户权限、专门在lstat与rename间恶意替换目录的进程，但要在rename前再次校验父inode/realpath，避免普通竞态误写。

最小写入流程：拿exclusive锁→完整复验→将各待改文件原字节/权限及原缺失状态保存在进程内→逐文件在其父目录创建exclusive临时文件、写入/fchmod后rename替换（删除为校验后unlink）→record最后写入或删除→清理临时文件/锁。安装先写runtime，再合并hook，最后写record；卸载先移除自身hook，再删除未改owned文件，最后删除record。每文件替换是原子的，多文件整体不是原子的，不宣称crash-safe事务。

可捕获异常时按已成功操作的逆序做进程内回滚，恢复原字节/权限或删除本次新建文件；回滚前确认当前文件仍等于本次写入的after，发现第三方改动则停止覆盖、保留lock并报冲突及未恢复路径。回滚成功后清理本次创建且仍为空的目录；不递归删除target。异常退出/断电可能留下lock、临时文件或manifest与文件不一致；下一次预览/apply发现活跃lock报E_BUSY，残留无活跃进程的lock、孤立owned文件或manifest漂移报E_INSTALL_CONFLICT，供用户检查处理，不自动夺锁、重放或跨进程恢复。首版不实现持久crash journal/恢复授权协议；精确manifest、残留lock和现状校验只负责检测不一致，不能声称已经自动修复。无record时，owned前缀已有文件或共享JSON已有可识别的本工具hook组（引用本HOME内该agent的固定runtime前缀）均报冲突，即使字节相同；仅有第三方共享配置文件仍允许正常合并。

卸载重新解析当前共享JSON：若仍等于record.afterHookFileDigest则恢复beforeHookFile原字节（原先不存在则删除）；若他人已修改整个文件但本工具group仍完全相同，则只删除该group，保留其余key/组/顺序，移除本工具创建且现已为空的hooks/SessionStart容器；是否创建这些容器可由beforeHookFile判断。不能恢复整份旧备份盖掉新编辑。如果组丢失/变了、owned文件新增/变了、旧record拥有的入口skill树多出未记录文件，就整体冲突，不删他人内容；record保留供处理。完成后移除record、未改owned runtime及旧入口skill文件、属于本工具的空目录；不删内容库/配置/Git资源。不存在record且无本工具遗留文件时uninstall无操作；有record而缺owned文件或无record却有本工具孤立文件都是漂移冲突。

安装检查state/config准备成功，确保hook首轮能离线render；preview本身不调用同步。安装阶段不创建任何agent会话，不运行目标已有hook。Codex信任提醒、Claude失败不能block的限制进入plan.warnings（固定code与文本、无动态时间）。

## 静态 MCP JSON 与事务边界

静态 MCP 配置独立于 mode 和 hook。v2 `modeck-mcp.json` 将 portable 定义放在 `servers`，原生定义放在 `agents.claude.mcpServers` / `agents.codex.mcp_servers`；native 对象验证 JSON 可表示性及关键字段形状后保留完整值，包括可序列化扩展和 literal 参数/环境/请求头。该保留不承诺 agent 对扩展字段的支持。Codex 原生条目在写入 TOML 前执行 parse/stringify 往返等价检查；portable 的 SSE 与环境变量名映射约束仅作用于 portable 适配。

`manageStaticMcp` 仅读取 `modeck-mcp.json` 的 schemaVersion 2。`migrate` 从 agent 原生配置导入条目到对应字段，并保留已有 portable 声明。迁移结果无新增 native 项时仍会创建 JSON；匹配登记也会将 JSON 事务性设为 `0600`。原生目标字节不变，status 不写入。

migrate 事务写入中央 JSON 与私有 ownership，apply 事务写入原生目标与 ownership。ownership source、journal 和 stale lock 的 central 路径必须精确匹配当前 JSON；其他 central 路径及缺少 staging inventory 的旧锁会安全拒绝，不清理或接管。pending journal 可安全回滚，committed journal 只完成清理；journal 和 stale lock 必须通过原 agent、scope、home、cwd、配置及目标身份核验。native endpoint 指纹用于阻止端点身份漂移，观察快照与拓扑在提交前复核；apply 任一条目冲突时整批不写，migrate 可逐项部分成功且拒绝项保持原生不变。未管理项及中央已删定义不会自动删除。支持仅为 Claude user/project 与 Codex 默认 user scope；配置同步不进入多源 mode、插件或 SessionStart 组合。

## 11. hook 预载与交付限制

hook直接调用安装内统一CLI脚本预载，wrapper复用prepare；不再打包或安装入口skill。旧record兼容仅允许清理已记录owned且完整未改的入口skill；新增文件、摘要/权限变化或缺失均整体冲突，不接管用户手写同名skill。升级清理旧入口及runtime后移除本工具留下的空目录。产品可以经用户授权安装真实HOME，本次实施/验收仍只在隔离目标调用，不附带README/示例代码/仓库测试。
