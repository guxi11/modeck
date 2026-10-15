# agent-modes standard 实施任务

依赖 `architecture.md` 与 `detailed-design.md`（2026-10-16 hard设计，已由ultra修订收口）。本文是交给3名standard的任务包。实现均不新增测试代码/README；本次实施/验收只在隔离HOME/config/state调用，不修改真实HOME/agent配置，不发布npm、不加远端、不推送。产品仍允许用户显式target-home+apply安装真实HOME，不能把本次授权范围写成永久产品禁令。

## 1. 文件所有权（互不重叠）

| owner | 独占文件 | 明确不归它 |
| --- | --- | --- |
| core | `package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore`；`schemas/**`；`src/contracts/**`；`src/core/**` | resources/integration/CLI/skill |
| resources | `src/resources/**` | 全部公共types/schema/包配置、core与integration |
| integration | `src/integration/**`、`src/cli/**`、`skills/agent-modes/**` | contracts/schema、包配置/lock、资源下载实现 |

`design/**` 本轮设计owner保有，实现者不改；`dist/**`、node_modules、内容库、fixture和验收临时记录不能提交。尚无其他产品文件，不自行新增第四个共享utils目录。公共错误、版本、限额、hash/path词法工具也属于core。各owner可以在自身目录内拆小文件，不跨区重构，不新建测试代码。新增第三方依赖需求报给core owner，由它统一写package/lock；另两人不得npm install改变lock。

package最低契约：Node>=20、ESM/strict TS，bin指向`dist/bin/agent-modes.mjs`；exports至少`./contracts`、`./core`、`./resources`、`./integration`对应dist JS和.d.ts；files只纳入dist、schemas、skills及npm元数据。`typecheck`使用tsc --noEmit；`build`先tsc输出模块/声明，再esbuild把`src/cli/bin.ts`构建为Node20 ESM standalone JS bundle到dist/bin/agent-modes.mjs（node: builtin external，其余依赖打入）；bin须有shebang，main.ts仅导出无启动副作用。包无ai-rulez；schema验证用Ajv2020，受限frontmatter用yaml，tsc/esbuild及@types/node为开发依赖。schema和package.json用相对模块URL定位，普通包/安装runtime布局一致。版本由core统一确定/锁定，不让3人各自写一套构建方式。

## 2. 执行依赖和集成节奏

1. core首先完成C0：contracts、schema与package骨架，提交只含自己文件的契约commit。types必须包括详细设计第6节所有函数的命名Request/Return类型，所有参数名/默认值/错误码一次定清。不得只交口头接口或留any/TODO。
2. resources、integration从C0开始可并行；core继续C1/C2。C0之后改共享Interface需先由三人确认影响，只有core动文件并发出新commit；不让另两人自行兜底兼容或创建同名类型。
3. 各自工作树/分支仅改所属文件；上游整合可依次cherry-pick C0、core剩余、resources、integration，不自动合并无关文件。若用同工作树也只精确stage所属文件；禁止git add -A。
4. 单人最初可对自己目录做编译检查；集齐三个Module后统一typecheck/build/真实临时场景/npm pack。谁拥有出错文件谁修；最终由白板hard独立验收，不靠实现者自述替代。

## 3. core 任务包（可直接派发）

负责唯一公共contracts、配置校验、事实采集、纯resolver和稳定编译器。只改所有权表core文件，不写测试代码，不实现CLI/下载/安装。完整阅读detailed-design第2–7节；尤其不得靠对象枚举、mtime或绝对项目路径影响正文。

**C0：按ultra审定版本先发布公共契约，后写Implementation。**

- 落3份输入JSON Schema（modes/selector/lock），声明规范化TS类型、所有Request/Return、错误工厂、PROTOCOL/SCHEMA_VERSION/LIMITS、parseJson/canonical/sha256/checkRelativePath。Schema与TS的optional/default语义一致；输入unknown，输出深层readonly。parseJson是全Module唯一严格JSON/重复key读取工具。
- 定公共exports及build/typecheck/pack文件清单，统一Ajv2020/yaml等依赖和lock。忽略dist/node_modules及临时产物；不能新增README/样例/测试。
- 发C0 commit hash及共享导出清单给另外两名；实际函数不完成也可先并行写，但contracts必须已可导入/类型检查，不用冒充已有Implementation的空函数stub。

**C1：配置与纯解析。**

- loadConfig安全读取UTF-8/重复key检测/schema/默认补齐/引用和DAG全图校验；parseLock仅做锁自身结构校验。selector nearest查找、Git worktree边界、非Git仅cwd、受限扫描/排除、依赖读取、超限失败。
- resolve按defaults→priority/id推断→selector的seed顺序，声明顺序parent DFS，disable父依赖冲突，稳定去重及skill preload OR；完整reasons，成功diagnostics=[]。
- configDigest来自规范配置，rawConfigDigest来自原始文件，二者不可混用。无I/O纯resolve/compile，不导入resources运行时。

**C2：稳定编译。**

- VerifiedResourceSet与plan身份一致，严格按正文协议生成rule/skill索引/preload；目录/入口路径能直接使用，不写cwd/原因/时间到正文。
- selectionDigest只覆盖协议/agent/选中mode顺序/有序选中资源的id-kind-treeDigest-preload；正文不写configDigest/lockDigest。未选资源合法更新并sync、无关detector变化不改正文；Git commit变化但选中树不变也不改正文。contentDigest覆盖实际输出bytes，state位置不同则可不同，不伪称跨机相同。9000 UTF-16和32768-byte上限均报错，不截断。

完成标准：导出完全匹配C0；临时fixture下显式/自动/禁用/DAG/顺序可解释；不同cwd相同选中结果的text/digest一致；无关detector/未选资源更新不变，选中树（含asset/exec位）/顺序/agent变化才改变身份。完整性错误仍失败，不能以输出稳定为由绕过local未同步修改；size/非法输入失败。只写临时fixture/脚本不进仓库。集成后typecheck/build通过。提交自己文件，回传commit、导出清单、验证命令/结果和真实限制。

## 4. resources 任务包（可直接派发）

负责`src/resources/**`的init/import、资源锁/完整技能树/本地和Git安全物化；只用C0公共contracts，不改package/schema/core/integration。完整阅读详细设计第2/4/6节；core运行时校验通过parseLock/validate函数参数注入，禁止反向导入core。

**R1：内容树和离线读取。**

- rule固定content.md、skill完整树含scripts/references/assets/隐藏文件/空目录/execute语义；拒绝所有symlink/gitlink及.git内容、越界父目录、casefold冲突、不安全/超限条目。
- 按规范生成entries/treeDigest/sourceDigest；校验SKILL frontmatter和全配置skill name唯一/保留名；完整验证内容库manifest、文件集合、原始bytes、execute位及本地源，不能只看目录名或SKILL.md。
- readResources只读、离线，缺锁/缺对象/描述不符/摘要损坏即明确失败；传出entryBytes及解析skill metadata/body，不执行来源内容。不得为read偷偷mkdir或修复缓存。

**R2：同步和Git。**

- sync reuse/update/frozen三态严格分离，空配置也须锁；锁含完整commit，frozen锁原字节不动但可补固定对象；本地漂移必须失败，除非显式update。
- Git隔离环境、argv、URL/ref限制、无checkout/filter/hook/submodule/script；通过Git对象提取安全树，保留exec。固定commit不可用就失败，不跟进ref新头；工具获取只发生sync/import。
- exclusive锁、staging、原子CAS发布、失败旧锁不动、源/旧锁提交前复核。对象损坏报错，不能默默重写；临时不引用对象可留，不做GC。

**R3：配置仓库创建/导入。**

- init安全新目录+最小modes.json+git init，无README/规则/样例/锁。
- import远端或显式本地Git到新目录，完整安全tracked tree、origin/main/HEAD/index一致；拒绝已有destination、unsafe entries，validate回调成功才rename；不自动同步/安装。调用Git不能使用来源hooks/templates或真实全局配置。

完成标准：临时本地源与临时Git仓库（包括带空格路径）能首次sync、frozen重建、分享后复现；Git ref移动frozen仍旧commit；local/Git完整skill脚本保留exec；改内容库任意asset/新增文件/本地源或lock均检测；缺锁离线失败；拒绝symlink和非法源，失败不改旧锁/不留半成品destination。用临时fixture/脚本，不提交测试。集成后typecheck/build通过。只提交自己文件，回传commit和验证证据。

## 5. integration 任务包（可直接派发）

负责`src/integration/**`、`src/cli/**`、产品入口`skills/agent-modes/SKILL.md`。只导入C0 contracts及core/resources公开index，禁止改共享contracts/package/锁/schema。完整阅读详细设计第6–11节，复用prepare，禁止Adapter各算一套mode。

**I1：CLI与入口。**

- 固定第7节命令/flags/JSON/exit code/配置优先级；init输入最小Config经parseConfig规范化后交resources；import的validate回调负责core配置/锁校验。所有缺省路径只在入口解析一次。
- prepare为loadConfig→readResources→collectFacts→resolve→compile；只读命令不联网、不修复缓存，不将诊断写进正文。JSON stdout无日志。
- skill为统一管理入口，保持与实际命令一致，不声称skill能保证首轮执行；资源脚本只按任务显式调用。

**I2：两套hook和wrapper。**

- Codex hooks.json、Claude settings.json输出真实SessionStart group/JSON；有上限且CodexadditionalContextLimit=0；/hooks信任警告，不写信任或bypass参数。
- 安装幂等+RunMarker身份/digest去重，hook依然校验资源，纯hook每次compact重新注入，不用永久session+source缓存。明确单生效安装限制和多层复制警告。
- arity解析使用审定后的允许集，拒绝冲突cwd/未知改变来源的flag，prompt内同名字符串不误判。Claude保留用户append并追加，不替换system；不支持resume snapshot。
- Codex独立app-server initialize/initialized/config/read探测effective developer_instructions及layers，保留原文；不可可靠读取/层变化就拒绝；精确移除原developer override并生成一个安全TOML字符串追加。强制--no-daemon、固定cwd，避免共享daemon丢marker。
- argv无shell、stdio/exit/signals透传、嵌套wrapper拒绝。实际模型调用不属于本轮验收，使用临时假agent程序记录启动参数与模拟配置RPC，但不得把fake验证说成真实模型行为。

**I3：最小安装与卸载。**

- target-home必填且表示HOME根，产品允许用户显式target-home+apply安装真实HOME；本次所有调用仅用隔离目录。Codex写`.codex/hooks.json`和`.agents/skills/agent-modes`，Claude写`.claude/settings.json`和`.claude/skills/agent-modes`。record/runtime/lock按`.agent-modes/<agent>/`隔离，两agent可共存。默认preview无写；apply的expect可选，提供时匹配当前planDigest，未提供时执行本次重建并复验的计划。预览包含完整JSON合并差异，未知共享字段/其他hooks保留。
- standalone JS runtime保留最小包布局（dist/bin入口、3schema、完整入口skill、package.json），schema/版本从入口URL定位；不能只复制bundle后丢失数据。精确InstallRecord所有权；拒绝evoloop标记/symlink/无record同名文件，不能force覆盖。
- exclusive锁+前置摘要/权限/路径复验+逐文件原子替换+record最后；原字节和权限仅为可捕获异常保存在进程内，失败逆序回滚，第三方新编辑不覆盖。保持共享文件完整权限，0600不能扩大为0644，record/lock/临时文件0600、私有目录0700。不实现持久crash journal、重放或恢复授权；残留lock/孤立文件/manifest漂移报冲突，不能声称多文件原子或crash自动恢复。卸载只动完整未改owned文件与精确自身hook组，保留他人后续编辑，缺失或篡改冲突而非全目录删除。
- 同包重复install应空变化；无record且无本工具遗留文件的卸载为空变化，发现孤立文件仍报冲突；卸载不删state/config/CAS。包内资源路径必须在npm pack tarball安装后也成立。

完成标准：临时HOME/config/state/target下所有CLI闭环；预览不写、带/不带expect都能显式apply、陈旧expect拒绝、合并/二次安装/卸载对称、编辑其他hook后仍保留、改own内容冲突、进程内异常回滚、崩溃残留检测后报冲突；两个hook JSON及marker匹配/不匹配/纯hook重复compact；wrapper的有效baseline（含多行/引号/空值）、cwd冲突、prompt数据、argv/stdin/exit/signals、probe失败不启动；tarball独立安装运行且入口skill和bundle依赖完整。只用临时fixture，不提交测试代码。真实模型未调用写清楚。只提交自己文件，回传commit与证据。

## 6. 合并后的检查与白板 hard 验收输入

首轮独立验收补充的阻断边界：core/resources/integration各自的外部文件读取须以普通文件预检、非阻塞且不跟随链接的open、已打开handle类型复检拒绝FIFO；包装器须拒绝维护/已有会话子命令，并为裸prompt增加agent数据分界；无record的空owned根不接管；record hook身份须与固定runtime及配置绑定交叉验证。这些修复仍归各原owner，只用临时fixture，不新增仓库测试代码。

每人提交前只stage自己文件并检查git diff --cached；不整理其他人的未提交修改。最终集成者运行typecheck/build/npm pack；临时目录解包/安装tarball，从产品bin完成闭环。npm pack产生tarball放临时目录，不在仓库提交验收产物；无npm publish/git push。

白板hard从干净配置开始独立检查以下结果；这是一份验证清单，不是要求新增测试代码：

| 场景 | 必须看见的证据 |
| --- | --- |
| init/import分享 | 新Git目录可提交；导入锁复用，无真实HOME变化/来源代码执行 |
| JSON/解析 | 重复key/未知引用/未选中DAG循环报错；最近.mode、不跨边界；禁父冲突与顺序固定 |
| 稳定正文 | 同state下两个cwd选中mode/树/顺序相同则text逐字节相等；无关detector、已sync未选资源、同树Git换commit不改正文；选中树/顺序/agent变化改digest；resolve/JSON诊断可变，绝对项目路径不入正文 |
| 技能定位 | root/entry实际存在；scripts/reference/assets全在且exec保留；preload正文准确；超限失败无截断 |
| frozen完整性 | lock不变；移动Git ref仍取旧commit；坏/缺对象、本地漂移、增删asset均失败；只sync能补对象 |
| hook | JSON shape、15秒timeout、Codex信任警告、Claude首轮等待依据、失败不保证阻断；compact不被旧标记吞掉 |
| 原生skill发现 | 隔离HOME/CODEX_HOME下验证Codex读到`.agents/skills/agent-modes`，不能以旧`.codex/skills`落盘替代；可用`codex debug prompt-input`离线检查model-visible prompt，原生绝对路径索引仍属于缓存边界 |
| wrapper | baseline不丢、cwd不分叉、unknown/替换prompt参数拒绝、marker不双注入、--no-daemon、stdin/exit/signals真实进程行为 |
| 安装安全 | preview零写、expect可选且提供时校验、symlink/evoloop拒绝、重复安装零变化、第三方JSON保留、own漂移不删、进程内失败回滚、崩溃残留只报冲突；全部实际调用仅在隔离HOME验证 |
| 分发 | pack含所有exports/standalone bundle/3schema/入口skill；临时安装bin可启动，无源码/node_modules路径泄漏 |

白板hard把发现回派所属owner，禁止越区直接改。最终验收记录由上游按需求另行授权保存；本次只写两份设计。协议与argv已验证但没有真实付费请求时，交付必须明确“未验证真实模型加载/缓存命中”，不能把digest或CLI参数当KV缓存证明。
