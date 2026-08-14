# dsh-github-workflow

GitHub 深度工作流工具集 —— 把 GitHub 从「API 调用」升级成「懂开发流程的业务工具」，让 DeepSeek Harness 的 Coding Agent 能高质量完成 **Issue → 分析 → 写代码 → 草稿 PR → CI → Review** 闭环。

## 定位

- **目标用户**：用 DeepSeek Harness 做 Coding Agent 的开发者和小团队。
- **第一版目标**：Agent 能比较靠谱地完成「分析 Issue + 创建高质量草稿 PR + 基础 Review」。
- **与通用 GitHub 工具的区别**：每个工具都面向开发流程的某一环输出**结构化的、可直接行动的产物**，而不是裸 API 响应。

## 差异化点（v1 已实现）

1. **更懂上下文**：`gh_analyze_issue` 自动拉取四类上下文——关联 PR（引用该 Issue 的）、历史 PR（同关键词的过往尝试）、类似 Issue（重复与相关报告）、代码引用（正文反引号标识符的 code search），并标注检索关键词。
2. **结构化输出**：`gh_review_pr` 的 Review 按 **Blocker（阻断）/ Suggestion（建议）/ Polish（优化）** 三级组织，配文件清单与可 focus 的 diff，而不是散乱评论；分析结果可一键 `post: true` 提交。
3. **流程友好**：`gh_create_draft_pr` 自动携带规范模板（Summary / Changes / Commits / Test plan / Related）与关联 Issue（`Closes #N`），标题与正文从 Issue 或 base…head 真实 diff 推导，无需手工编写。
4. **可追踪**：所有关键操作（PR 创建、Review 提交、以及每次被权限闸口拒绝的写操作）以结构化事件 `github-workflow/operation` 追加进**所属 session 的 append-only 日志**（`src/utils/trace.ts`），从会话历史即可审计完整工作流，与模型可见的工具结果相互独立。

## 工具一览

| 工具 | 方向 | 作用 |
| --- | --- | --- |
| `gh_get_repo_context` | 读 | 仓库全景：默认分支、语言、近期提交、开放的 PR/Issue 数 |
| `gh_analyze_issue` | 读 | 深入分析 Issue：问题理解、影响范围、实现建议、潜在风险四维脚手架 + 候选需求 + 关联 PR / 历史 PR / 类似 Issue / 代码引用 |
| `gh_search_related` | 读 | 开工前查重：重复 Issue、历史尝试、跟踪 Issue（可限定仓库） |
| `gh_create_draft_pr` | 写 | 创建带规范模板的草稿 PR：标题/正文可从 Issue 或 base…head 真实 diff 推导，自动带 `Closes #N` |
| `gh_check_ci_status` | 读 | 一个 ref / PR 的 CI 全景：combined status + 全部 check run |
| `gh_review_pr` | 读/写 | 结构化 Review：文件清单 + diff（可 focus）+ 阻断/建议/优化三级脚手架；`post: true` 时把评论提交到 GitHub |

## 安全设计（v1 必选，已实现）

所有写操作（`gh_create_draft_pr`、`gh_review_pr post:true`，以及未来新增的合并 PR / 关闭 Issue / 删除分支等）统一经过 `src/utils/permission.ts` 这一个闸口，按顺序检查：

1. **只读模式**：配置 `readOnly: true` 时所有写操作直接拒绝（查询/分析不受影响）。
2. **默认需用户确认**：`requireApprovalForMutations`（默认 `true`）通过宿主 approval 服务向用户提问，只有 `allowed-once` 才放行；approval 服务缺失、无 agent 上下文、超时一律 **fail-closed**。
3. **Token 权限范围可配置**：`requiredTokenScopes`（如 `['repo']`）在每次写操作前通过 `GET /user` 的 `x-oauth-scopes` 头校验；无法验证的 token（fine-grained PAT 不返回该头）同样 fail-closed。

> 每一次被闸口拒绝的操作都会以 `outcome: denied` 事件写入 session log（审计可见），即使 GitHub 上什么都没发生。

> 合并 PR、关闭 Issue、删除分支等更多写工具规划在 v2，全部走同一个闸口，安全面只有一处。

## 安装与认证

### 1. 构建

```bash
npm install        # 或 pnpm install
npm run build      # tsc 输出到 lib/
```

`@deepseek-ai/*` 包是 peerDependencies，需与宿主 Harness 同版本；本地开发可把插件目录 link 进宿主环境（见下）。

### 2. 认证

Token 通过宿主 `credentials` 缝（`ctx.credentials`）按**每次调用**解析：环境变量 → `$DSH_HOME/.credentials.yaml` → 项目/用户 `.env`。配置项 `apiTokenEnv`（默认 `GITHUB_TOKEN`）只写引用名，不写值：

```bash
export GITHUB_TOKEN=ghp_xxx
# 或写入 $DSH_HOME/.credentials.yaml（owner-only，热加载）
```

无 token 时读工具匿名可用（60 次/小时 IP 限流），写工具会以明确错误拒绝。

### 3. 挂载

在宿主组合（host composition）或 agent preset 中加入一行（该插件只注册工具与 prompt 段、不发布服务，可像 `tool-bash` 一样松放）：

```yaml
- id: github-workflow
  name: dsh-github-workflow
  config:
    apiTokenEnv: GITHUB_TOKEN
    requireApprovalForMutations: true
    # requiredTokenScopes: [repo]
```

本地测试组合见 [`examples/cordis.yml`](examples/cordis.yml)：

```bash
dsh --profile <profile> --patch ./examples/cordis.yml
```

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `apiTokenEnv` | `GITHUB_TOKEN` | token 的环境变量引用名（经 credentials 缝解析） |
| `baseUrl` | `https://api.github.com` | REST API 基址；GitHub Enterprise Server 请覆盖（如 `https://gh.example.com/api/v3`） |
| `timeoutMs` | `60000` | 单请求超时（1000–300000） |
| `readOnly` | `false` | 只读模式：只允许查询与分析 |
| `requireApprovalForMutations` | `true` | 写操作默认经 approval 服务向用户确认 |
| `requiredTokenScopes` | `[]` | 写操作要求的 token 权限范围，校验失败即拒绝 |

## 典型流程

1. **熟悉仓库**：`gh_get_repo_context(owner, repo)`
2. **分析 Issue**：`gh_analyze_issue(owner, repo, N)` → 按脚手架产出问题理解 / 影响范围 / 实现建议 / 潜在风险
3. **查重**：`gh_search_related(query, owner, repo)`，确认没有重复工作
4. **实现**：用文件系统与 shell 工具改代码（插件不代劳实现）
5. **提草稿 PR**：`gh_create_draft_pr(owner, repo, head, issueNumber?)` —— 不传 title/body 时从 Issue 或真实 diff 推导规范描述，自动带 `Closes #N`
6. **看 CI**：`gh_check_ci_status(owner, repo, pullNumber)` 或 `ref`
7. **Review**：`gh_review_pr(owner, repo, N, focus?)` 产出分级审查 → `gh_review_pr(..., post: true, body, event)` 提交评论

## 设计说明

- **传输层**：用宿主运行时自带的全局 `fetch`（Node ≥ 20）封装了约 20 个 REST 端点（`src/github-client.ts`），刻意不引入 Octokit 依赖；如后续需要 GraphQL / 批量操作，可在同一接口后面替换实现。
- **凭证**：每次调用经 `ctx.credentials.resolve(apiTokenEnv)` 现取现用，token 变更无需重启，也绝不进入工具参数或文件。
- **输出**：全部为纯文本 markdown（`src/utils/format.ts`），确定性渲染，模型可直接消费。
- **可追踪**：写操作成功与每次被拒都经 `src/utils/trace.ts` 以 `github-workflow/operation` 事件写入所属 session 的 append-only 日志（事件类型通过 `declare module '@deepseek-ai/dsh-session/types'` 合并进会话事件词表）；追加失败只记日志，不影响操作本身。

## Roadmap（v2+）

- 合并 PR、关闭 Issue、删除分支、请求 reviewers（走同一权限闸口）
- GraphQL 批量查询（check runs 详情、review 评论线程）
- 仓库规则感知（CODEOWNERS、CONTRIBUTING、branch protection）
- 评论回复与迭代闭环、Issue 自动打标签/指派
- 按仓库缓存的上下文（默认分支、常用路径）

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run build       # 输出 lib/
node smoke.mjs      # 冒烟测试：真实 cordis 挂载 + stub fetch，覆盖 6 工具与全部安全闸口
```

`smoke.mjs` 用 stub 的 `fetch` 与 stub 服务在真实 cordis Context 上跑完整执行路径（含 approval 放行/拒绝、只读模式、token scope 校验、session 追踪事件），不需要真实 GitHub 凭据。

> **依赖解析**：`@deepseek-ai/*`（cordis / dsh-tools / dsh-session / dsh-credentials / dsh-user-approval / schemastery）是宿主运行时同版本包。仓库里的 `node_modules/@deepseek-ai/*` 当前是**指向本地 Harness checkout 的符号链接**（`vendor/cordis`、`packages/core/tools` 等），这也是推荐做法：不要对这些目录执行会清空它们的 `npm install`；要安装时请用 `npm install --no-prune` 或 pnpm，或先备份链接。若 `@deepseek-ai/schemastery@^3.18.0` 等可以从 registry 安装，也可以删掉对应链接后走正常安装。

## License

MIT
