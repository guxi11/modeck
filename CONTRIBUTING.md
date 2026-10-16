# 参与开发 modeck

本文面向修改 CLI、资源加载和 agent 适配器的贡献者。使用与配置步骤见 [README](README.md)，模块设计和数据流见 [架构设计](docs/architecture.md)。

## 准备开发环境

需要 Node.js 20+、npm 和 Git，在 macOS 或 Linux 上开发。

1. 克隆并进入源码仓库：

   ```sh
   git clone https://github.com/guxi11/modeck.git
   cd modeck
   ```

2. 安装锁定的依赖：

   ```sh
   npm ci
   ```

3. 检查类型并构建 CLI：

   ```sh
   npm run typecheck
   npm run build
   ```

4. 核对构建产物的版本：

   ```sh
   node dist/bin/modeck.mjs --version
   ```

   输出应与 `package.json` 的版本一致。`dist/` 是生成产物，不直接修改。

## 查找实现

源码按以下职责组织：

| 目录 | 职责 |
| --- | --- |
| `src/contracts/` | 共享类型、协议、错误和摘要 |
| `src/core/` | YAML 配置校验、目录事实、自动选择、mode 解析和上下文编译 |
| `src/resources/` | 本地与 Git 资源、内容寻址存储和完整性验证 |
| `src/integration/` | 上下文准备、hook、绑定计划与应用、进程启动 |
| `src/cli/` | 命令入口、交互选择、初始化、扫描和迁移 |
| `schemas/` | 配置与资源 manifest 的 JSON Schema |

配置入口为 `modeck.yaml` 或 `modeck.yml`，同一配置目录只保留其中一个。自动选择脚本是 `modeck-auto.mjs`，保留这一拼写。JSON Schema、`src/contracts/types.ts` 和校验逻辑共同维护数据契约。

`resolve` 和 `compile` 保持纯函数；将文件系统、终端和进程副作用留在边界。修改绑定流程时，沿用计划与应用的分离，保留所有权、冲突和过期计划检查。

## 验证改动

提交前运行类型检查和构建，并核查文档中的命令及相对链接。仓库没有 `npm test` 脚本。

验证初始化、扫描、迁移和绑定时，使用临时配置目录、状态目录及隔离的 home，避免影响日常 agent 配置。原生 hook 的发现、信任和实际运行还需要对应 agent CLI 验证；生成 hook JSON 不代表模型已加载上下文。

提交时只暂存本次改动，保留工作区中的其他任务。涉及 schema 或协议变化时，同时更新相关文档并说明兼容性影响。

## 阅读设计记录

[架构设计](docs/architecture.md)解释模块边界、资源完整性、hook、绑定及设计取舍。`design/` 保存早期方案和验收记录，其中部分配置格式与命令属于历史设计，不作为使用参考。
