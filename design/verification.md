# 独立验收记录 · 2026-10-16

历史记录：以下结论对应所列提交及旧包版本；包名、命令、路径和摘要保留当时实测值，不代表 modeck 当前版本的验收结果。

结论：PASS，本机离线协议、分发及安全边界的必要场景通过，无剩余已知阻断。独立阅读三份设计及全部源码，核对作者提交和随后修订；依据最终契约 `0797848`。验收期间未修改产品源码。

- 产品提交：`3c6d1146a61d6759f63a95155a3b1877ff002e58`；`src` Git tree：`7d9e9ee8ddc16a82df5e9c23a61145e3232a4428`。构建及写记录前工作树干净。
- 版本：`@guxi11/agent-modes@0.1.0`，Node `v20.19.5`，Darwin `25.5.0 arm64`，Codex CLI `0.162.1`，Claude Code `2.1.296`。
- 全新隔离目录：`/private/tmp/mode-review-final-3c6d114`（以下称 R）；首轮证据：`/private/tmp/mode-review-20261016`。HOME、config、state、target、原生 agent 配置和临时故障注入均在隔离目录内。
- 新 tarball：`/private/tmp/mode-review-final-3c6d114/pack/guxi11-agent-modes-0.1.0.tgz`。
- SHA-256：`b23db610110063ea90a64bdf75a6085c927465b8eb540a081e40696ad55f8381`。

## 实际命令与证据

仓库执行以下构建/打包命令，使用 `PATH=/Users/zyy/.nvm/versions/node/v20.19.5/bin:$PATH`、`HOME=$R/home`：

```sh
npm run typecheck
npm run build
npm pack --pack-destination /private/tmp/mode-review-final-3c6d114/pack --json
npm install --ignore-scripts --no-audit --no-fund --prefix /private/tmp/mode-review-final-3c6d114/installed /private/tmp/mode-review-final-3c6d114/pack/guxi11-agent-modes-0.1.0.tgz
```

临时脚本均实际用上述 Node/PATH、隔离 HOME 和 `REVIEW_ROOT=$R` 执行；脚本及对应 `*-results.json` 保留在 R。`summary.json` 汇总 90 项通过检查，无未解决失败；另实际导入四个包导出，并调用安装后 `.bin/agent-modes --version`。

| 临时脚本 | 实际覆盖及结果 |
|---|---|
| `resources-core.mjs` | init/import 的新可提交 Git 仓库；完整本地 skill、脚本/二进制 asset/reference/隐藏文件/空目录/exec；缺锁、任意 CAS 新增/坏 asset 离线失败；nearest selector、worktree、非 Git 边界、全图循环、禁父冲突及顺序；同 state 不同 cwd 字节相等，无关 detector/未选资源合法更新不扰动正文，所选树/exec/顺序/agent 改摘要，超限无部分输出。 |
| `git-resources.mjs`、`git-casefold.mjs` | Git 完整树及 exec，reuse/update/frozen 分离，移动 ref 仍锁旧 commit，空 state 补固定对象、锁原字节不变，同树换 commit 不改正文；不可取 commit、symlink 和 casefold 冲突失败；直接构造 Git 空目录对象验证保留。 |
| `install.mjs`、`lock-recheck.mjs` | 默认 preview 零写，apply 带/不带 expect，stale 拒绝；两 agent 原生目录共存，重复安装零变化；独立 runtime 无源码/node_modules 仍能执行带空格及单引号路径的 hook；第三方 JSON/hook 编辑保留，own 漂移/evoloop/symlink/危险权限拒绝，精确卸载保留 state/config/其他 skill；有效锁区分活跃与残留。 |
| `wrappers.mjs`、`revised-hooks.mjs` | multiline/引号/backslash/空 baseline 和 append/file；安全 argv/cwd，未知或冲突参数拒绝；stdin、退出 37、SIGINT/SIGTERM/SIGHUP；marker 去重仍完整验证资源，纯 hook 每次 compact 注入；JSON、字段类型、绝对 cwd、输入上限及 help arity。 |
| `final-regressions.mjs` | 首轮阻断修复逐项复验；维护/已有会话命令启动前拒绝，未来未知裸 prompt 自动插入 agent `--`；显式分界及 append `--help` 保持数据；空 owned 根拒绝；record 身份漂移拒绝，历史不存在且含引号的 Node 路径仍可卸载/重装；八类 FIFO 和三个 reader 的 lstat→open 替换竞态快速失败；atomic 父目录 inode 替换不覆盖第三方目录。 |
| `rollback.mjs`、`rollback-parent.mjs` | 两次成功写入后注入 EIO，恢复原字节/权限/缺失状态并清理新目录和锁；回滚时父目录替换且文件字节相同仍拒绝覆盖，保留第三方内容和冲突锁，后续安装拒绝盲写。 |
| `additional.mjs`、`security-extra.mjs` | 空配置仍须锁、扫描限额/排除/依赖、严格 JSON/selector、路径及 config/state containment、只读零写、YAML alias、orphan/重复 hook/绑定漂移、Git 外部 hooks/filter 配置隔离、非法 import 无半成品。 |
| `real-codex.mjs`、`hybrid.mjs` | 真实 app-server 只交换 initialize、initialized、config/read；effective baseline 原文保留。wrapper 两次真实配置探测后由假会话进程截获 argv；真实 `codex debug prompt-input` 离线确认 `.agents/skills/agent-modes` 原生发现及生成 TOML 指令字符串可解析。 |

锁检查初次临时 fixture 漏写 `schemaVersion`，产品正确拒绝该畸形锁；补齐版本后 `lock-recheck-results.json` 验证活跃/残留锁均通过。原始结果和这项替代关系保留在 `summary.json`，未作为产品豁免。

tarball 的 66 个条目包含三 schema、完整入口 skill、JS/声明模块和 standalone bundle；无 src 或原仓库路径依赖。真实原生离线输出保留在 `native-prompt.json`、`native-combined-prompt.json`、`real-codex-rpc.json`；故障证据见 `fifo-final-outcomes.json`、`fifo-race-outcomes.json`、`rollback-parent-results.json`。

lead 补充实测（不计入上述独立 90 项）：Node `v20.19.5` 下使用同一产品版本 bundle，从公网 HTTPS 获取 `octocat/Hello-World` 的 README rule，固定完整 commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`；禁用 Git 执行后的离线 render 正文相同，全新 state 的 frozen 同步获取同一 commit 且锁原字节不变，模型请求为零。reviewer 已核读 `/private/tmp/agent-modes-lead-https.mjs` 的实际调用/assertions 及 `/private/tmp/agent-modes-https-lead-xP28UV/results.json`，未重复执行公网操作。

## 首轮 NOTPASS 与修复复验

| 首轮问题 | 修复提交 / 当前位置 | 第二轮证据 |
|---|---|---|
| P1：维护子命令被当 prompt 透传 | `3c6d114`；`src/integration/run.ts:21` | R1 两项：已知命令启动前拒绝、未知裸 token 和显式 prompt 分界正确。 |
| P2：无 record 的空 owned 根被接管 | `c077149`；`src/integration/install.ts:130` | R2：两个 agent 的 skill/runtime 空根，preview/apply/uninstall 全部拒绝且零写。 |
| P2：record.hookGroup 漂移会删第三方 hook | `3c6d114`；`src/integration/install.ts:104` | R3：八种 hook/绑定/runtime 身份漂移整体拒绝；旧 Node 安装路径兼容性通过。 |
| P2：FIFO 在类型检查前阻塞 open | `19a7585`、`a82737b`、`3c6d114`；三个模块的文件 reader | R4：配置/selector/lock/CAS manifest/共享配置/record/append/rule 全部快速失败，三路替换竞态确认 O_NONBLOCK/O_NOFOLLOW 和 fstat 拒绝。 |
| P2：prompt 中 `--help` 被工具误判 | `55ec740`、`ecc4bef`；`src/cli/main.ts:116` | 新 bundle 的显式 prompt `--help`、append `--help` 和外层 help arity 通过；`0d6906e` 的严格 hook 字段也通过。 |
| 追加：写入/回滚需复核父目录身份 | `5606e65`；`src/integration/fs.ts:66` | 正常故障回滚、写前父目录替换和回滚父目录替换三条实际路径通过。 |

## 未执行项与结论边界

未调用真实付费模型、未发起任何模型请求；未验证真实模型上下文加载或缓存命中。真实 Codex 证据止于本地配置 RPC 和离线 prompt 渲染，假进程证据仅证明参数、stdio、退出及信号行为。contentDigest 只证明工具输出字节，不是 provider cache hit。

未执行 Linux 实机、私有 SSH Git 认证、真实交互会话的 `/hooks` 审阅信任及完整原生 hook 调度；公网 HTTPS 已由 lead 补充实测，reviewer 仅核读其证据。Claude 验证止于原生安装位置、只读 help、hook 协议和假进程 wrapper；没有用协议通过冒称真实模型效果。未改真实 HOME，未 npm 发布或 push；临时脚本/fixture 未进入仓库。
