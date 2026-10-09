# dsh-github-workflow

> 把 GitHub 从「API 调用」升级成「懂开发流程的业务工具」——让 DeepSeek Harness 的 Coding Agent 真正闭环完成 **Issue → 分析 → 写代码 → 草稿 PR → CI → Review → 合并 → 发布** 的全流程。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) · TypeScript · 12 个工具 · 零运行时依赖（仅宿主 peer）

---

## 为什么做这个

通用 GitHub API 工具只会「执行请求」：拉个 issue、贴个评论。但一个合格的 Coding Agent 需要的是**流程能力**——拿到一个 Issue 后，它要知道：

- 这个问题之前有没有人提过、有没有历史 PR 试过？（**查重**）
- 改动涉及哪些代码、仓库有哪些治理规则？（**上下文**）
- PR 描述怎么符合仓库规范、怎么自动关联 Issue？（**流程**）
- 合并前 CI 过了吗？评论线程回了没？（**闭环**）

`dsh-github-workflow` 把这套流程知识固化成 12 个垂直工具：每个工具输出**结构化、可直接行动的产物**（分析脚手架、按严重程度分级的 Review、由真实 diff 推导的 PR 描述），而不是裸 JSON。

## 差异化点

1. **更懂上下文**：`gh_analyze_issue` 一次拉取四层上下文——关联 PR、历史 PR、类似 Issue（关键词自动提取，**支持中文短语回退**）、代码引用（正文标识符 code search）。
2. **结构化输出**：Review 按 **阻断 / 建议 / 优化** 三级组织（附评论线程的 GraphQL 线程视图），而不是散乱评论。
3. **流程友好**：`gh_create_draft_pr` 自动携带规范模板（检测仓库 `pull_request_template.md`）+ 关联 Issue（`Closes #N`）+ 真实 diff 推导的 Changes/Commits/Test plan。
4. **可追踪**：每次写操作的成功与拒绝都以结构化事件写入所属 session 的 append-only 日志——整个工作流可从会话历史审计。

## 工具一览

| 工具 | 方向 | 作用 |
| --- | --- | --- |
| `gh_get_repo_context` | 读 | 仓库全景：默认分支、近期提交、开放 PR/Issue、CODEOWNERS、分支保护 |
| `gh_analyze_issue` | 读 | 四维分析脚手架（问题理解/影响范围/实现建议/潜在风险）+ 四层上下文 |
| `gh_search_related` | 读 | 开工前查重：重复 Issue、历史尝试（可限定仓库） |
| `gh_create_draft_pr` | 写 | 带规范模板与 `Closes #N` 的草稿 PR，标题/正文从 Issue 或真实 diff 推导 |
| `gh_check_ci_status` | 读 | CI 全景：combined status + check runs + 失败项 annotations |
| `gh_review_pr` | 读/写 | 阻断/建议/优化三级 Review + 既有评论线程；`post: true` 提交 |
| `gh_request_reviewers` | 写 | 请求 reviewers（用户 + 团队） |
| `gh_reply_comment` | 写 | 评论回复闭环，可一并 resolve 线程（GraphQL） |
| `gh_generate_release_notes` | 读 | 从两个 ref/tag 间的合并 PR 生成 changelog 草稿 |
| `gh_merge_pr` | 写 | GraphQL 合并（squash/merge/rebase），`markReady: true` 一键转 ready，可选删 head 分支 |
| `gh_close_issue` | 写 | 关闭 Issue/PR（带 state reason） |
| `gh_delete_branch` | 写 | 删除分支（拒绝默认分支与有开放 PR 的分支） |

## 快速开始

**一条命令安装并挂载**（推荐）：

```bash
export GITHUB_TOKEN=ghp_xxx      # 认证（经宿主 credentials 缝逐次解析）
dsh plugin --profile web add dsh-github-workflow
```

包内自带 `dsh.bundle.patch`（见 [`cordis.patch.yml`](cordis.patch.yml)），CLI 会把它作为 bundle 层激活——**不需要手改 profile 文件**。装完可用 `dsh --profile web --dump-config` 验证挂载。

从源码安装（开发用）：

```bash
git clone https://github.com/ZariaEcho/dsh-github-workflow && cd dsh-github-workflow
npm install && npm run build
dsh plugin --profile web add .
```

手动挂载（写进 host composition 或 agent preset）：

```yaml
- id: github-workflow
  name: dsh-github-workflow
  config:
    requireApprovalForMutations: true   # 写操作默认需用户确认
```

> ⚠️ 改走 bundle 通道后，请删掉 profile 里手写的这一行，否则会重复挂载。
> 本地测试组合见 [`examples/cordis.yml`](examples/cordis.yml)（`dsh --profile <p> --patch ./examples/cordis.yml`）。

### 版本兼容（重要）

`peerDependencies` 对 `@deepseek-ai/dsh-*` 声明为 `^0.1.0-rc.1 || ^0.2.0-rc.1`。

DSH 在导入插件前，会用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 把**每一个**声明的 DSH peer 范围与运行时版本逐一比对；只要有一个不匹配，该行就被静默禁用（变成 `disabled: true`，用户看到的现象是"装了但工具没出现"）。

坑在于 `^0.1.0-rc.0` 的上界是 `<0.2.0`——**装不下运行时 `0.2.0-rc.2`**。这是 0.1.x → 0.2.x 过渡期最常见的翻车点：插件在 0.1.x 上一切正常，升级 harness 后就无声失效。这里显式并列两条版本线，同时覆盖 `0.1.x-rc` 与 `0.2.x-rc`。

## 典型流程

```text
1. gh_get_repo_context           熟悉仓库（含 CODEOWNERS/分支保护）
2. gh_analyze_issue #N           深度分析（四维脚手架 + 相关上下文）
3. gh_search_related             开工前查重
4. （用文件/shell 工具实现）
5. gh_create_draft_pr            带模板 + Closes #N 的草稿 PR
6. gh_check_ci_status            盯 CI（失败项带 annotations）
7. gh_review_pr → post:true      分级审查并提交
8. gh_reply_comment              回评论线程（可 resolve）
9. gh_merge_pr markReady:true    转 ready 并合并（可删 head 分支）
10. gh_close_issue / gh_generate_release_notes   收尾与发布
```

## 安全设计（fail-closed）

所有写操作（7 个工具）收敛在**单一权限闸口**，按序检查：

1. **只读模式**：`readOnly: true` 时全部写操作拒绝
2. **默认需用户确认**：经宿主 approval 服务提问，非 `allowed-once` 一律拒绝（无 approval 服务 / 无 agent 上下文 / 策略 `never` 均 fail-closed）
3. **Token 权限范围可配置**：`requiredTokenScopes` 每次写操作前校验，无法验证的 token（fine-grained PAT）同样拒绝

每一次被拒的操作都会写入 session log（`outcome: denied` + 原因），审计可见。

## 真实环境验证

不是纸上谈兵：三个验证脚本全绿——**stub 冒烟 89 项**（离线可跑）+ **真实网络读验证**（octocat/Hello-World）+ **真实网络写验证**（一次性私有仓库跑全部 7 个写工具闭环，自动清理）。

真实验证还揪出了三个 GitHub「文档与实现打架」的行为，已修复进代码：

- REST `POST /pulls/{n}/merge` 对 OAuth token 返回 **404**（`gh api` 同现象）→ 合并走 GraphQL `mergePullRequest`
- REST `PATCH {draft: false}` 被**静默忽略**（200 但状态不变）→ 转 ready 用 GraphQL `markPullRequestReadyForReview`，封装为 `markReady` 参数
- 线程 resolve 的正确 mutation 是 `resolveReviewThread`（文档里常见的 `updatePullRequestReviewThread` 不存在）

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `apiTokenEnv` | `GITHUB_TOKEN` | token 的环境变量引用名（经 credentials 缝解析） |
| `baseUrl` | `https://api.github.com` | REST/GraphQL 基址；GitHub Enterprise Server 可覆盖 |
| `timeoutMs` | `60000` | 单请求超时 |
| `readOnly` | `false` | 只读模式 |
| `requireApprovalForMutations` | `true` | 写操作默认经 approval 服务确认 |
| `requiredTokenScopes` | `[]` | 写操作要求的 token 权限范围 |
| `contextCacheTtlMs` | `3600000` | 治理数据（CODEOWNERS/分支保护/PR 模板）缓存 TTL |
| `contextCachePath` | `''` | 缓存持久化 JSON 文件（跨进程复用，按配置命名空间隔离） |

## 项目结构

```
src/
├── index.ts              # 插件入口：注册 12 工具 + prompt section
├── config.ts             # schemastery 配置定义
├── github-client.ts      # fetch 封装（REST + GraphQL + 分页 + 限流提示）
├── types.ts              # GitHub API 类型定义（与传输层解耦）
├── tools/                # 12 个工具模块
└── utils/
    ├── permission.ts     # 唯一写操作闸口（readOnly → approval → scopes）
    ├── trace.ts          # 会话级追踪事件（github-workflow/operation）
    ├── cache.ts          # 命名空间化的治理缓存（可持久化）
    └── format.ts         # 确定性文本渲染
examples/
├── cordis.yml            # 本地测试组合
├── live-smoke.mjs        # 真实网络读验证（匿名可跑）
└── live-write-smoke.mjs  # 真实网络写验证（一次性仓库，自动清理）
```

## 开发与测试

```bash
npm run typecheck                      # tsc --noEmit
npm test                               # stub 冒烟（离线）
node examples/live-smoke.mjs           # 真实网络只读
GITHUB_TOKEN=$(gh auth token) node examples/live-write-smoke.mjs   # 真实写闭环
```

## Roadmap

- PR 模板占位符自动填充（`{{...}}` 推导）
- 组织级多仓库策略感知（批量操作、全局 CODEOWNERS 规则）
- webhook 驱动的状态跟踪（需常驻服务，当前以轮询等效）

## License

MIT
