# 自媒体推广文案

> 适用渠道：公众号 / 掘金 / 知乎 / 即刻 / 小红书。
> 使用方式：长文版可直接发布或节选；短版适合小红书/即刻。`[仓库链接]` 发布时替换为真实地址。

---

## 备选标题（按平台风格）

1. 公众号/掘金：**给 Coding Agent 装上「懂开发流程」的 GitHub 工具集，我踩了三个 GitHub 文档的坑**
2. 掘金/知乎：**AI 写代码不缺 API 工具，缺的是「流程感」——一个 12 工具的 GitHub 工作流插件**
3. 小红书：**让 AI Agent 自己提 PR、回评论、合并发布？这个插件真的做到了**
4. 即刻/朋友圈：**实测 GitHub 文档骗人：REST merge 返回 404，draft 转 ready 的 PATCH 是假的**

---

## 长文版（公众号/掘金/知乎，约 1500 字）

### 给 Coding Agent 装上「懂开发流程」的 GitHub 工具集

最近给 DeepSeek Harness 写了一个 GitHub 深度工作流插件 `dsh-github-workflow`，目标只有一个：让 Agent 真正闭环处理「Issue → 分析 → 写代码 → 草稿 PR → CI → Review → 合并 → 发布」整条链路，而不是把 GitHub 当一堆散装 API 调用。

**为什么通用 API 工具不够？**

普通工具会拉 Issue、会贴评论，但它不知道：这个问题以前有没有人提过？历史 PR 试过什么方案？仓库有没有 CODEOWNERS 谁必须 approve？合并前 CI 到底过没过？评论线程回了没？——这些「流程知识」才是 Agent 干活质量的分水岭。

**四个差异化点**

1. **更懂上下文**：分析一个 Issue 时自动拉四层——关联 PR、历史 PR、类似 Issue、代码引用。关键词自动提取，还支持中文短语回退（中文仓库不会静默失效）。
2. **结构化输出**：Review 按「阻断 / 建议 / 优化」三级组织，附 GraphQL 拉取的评论线程视图，不是一堆散乱评论。
3. **流程友好**：建草稿 PR 时自动检测仓库的 pull_request_template.md 并嵌入正文，从真实 diff 推导 Changes/Commits/Test plan，自动带 `Closes #N`。
4. **可追踪**：每次写操作的成功与拒绝都写入会话的 append-only 日志，整个工作流可审计。

**安全不是后置的**

7 个写操作全部收敛在一个权限闸口：只读模式 → 用户确认（fail-closed）→ token 权限范围校验。连 token 权限不够都会先拦住，不给你发请求的机会。

**最值的部分：真实验证把 GitHub 文档的坑踩出来了**

我建了个一次性私有仓库，跑完全部写操作的真实闭环（草稿 PR → 评论 → 回复 → 合并 → 关 Issue → 删分支 → 自动清理仓库），结果 GitHub 用三个「文档与实现打架」给我上了一课：

- **REST merge 端点对 OAuth token 返回 404**——连官方 `gh api` 都复现，改用 GraphQL `mergePullRequest` 才通；
- **`PATCH {draft: false}` 被静默忽略**——返回 200 但 PR 还是 draft，转 ready 必须走 GraphQL `markPullRequestReadyForReview`；
- **网上流传的 `updatePullRequestReviewThread` mutation 根本不存在**——正确名字是 `resolveReviewThread`。

这些坑 stub 测试测不出来，只有真实 API 会告诉你。现在插件代码和测试都把这些行为固化下来了。

**三个验证层**：89 项离线 stub 冒烟 + 真实网络只读验证 + 真实网络写操作闭环（一次性仓库自动清理，不污染账号）。工程上敢说「能用」，而不是「看起来能用」。

如果你也在用 DSH 跑 Coding Agent，或者想让 Agent 真的把 PR 闭环跑起来，欢迎来看看：[仓库链接]

---

## 短版（小红书/即刻，300 字内）

**让 AI Agent 自己提 PR、回评论、合并发布？这个插件真的做到了** 🤖

给 DeepSeek Harness 写的 GitHub 工作流插件 `dsh-github-workflow`：
- 12 个工具覆盖 Issue→分析→草稿 PR→CI→Review→合并→发布全链路
- 分析 Issue 自动拉关联 PR/历史 PR/类似 Issue/代码引用（中文仓库也能搜）
- Review 按阻断/建议/优化分级，还能一键提交+回评论+resolve 线程
- 建 PR 自动套仓库模板、自动 Closes 关联 Issue
- 所有写操作 fail-closed：只读模式/用户确认/token 权限三重闸口，全程写 session log

硬核点：用一次性仓库跑了全部写操作真实验证，发现 GitHub 三个文档坑——
⚠️ REST merge 对 OAuth token 返回 404
⚠️ PATCH draft:false 是假的（200 但没生效）
⚠️ 流传的 resolve mutation 名字是错的

89 项离线测试 + 真实写操作闭环全绿，安全可审计。Coding Agent 玩家值得一试：[仓库链接]

#AI编程 #CodingAgent #GitHub #开源 #开发者工具

---

## 即刻/朋友圈一句话版

GitHub 文档骗我三次：REST merge 404、draft PATCH 无效、mutation 名字是错的——全靠真实验证抓出来。于是我把这些坑固化进了一个 12 工具的 DSH GitHub 工作流插件，写操作闭环全部实测通过。[仓库链接]

---

## 配图建议

1. 封面：12 个工具的流程示意图（Issue → PR → Review → Merge 箭头闭环）
2. 中插 1：`gh_analyze_issue` 输出截图（四维脚手架 + 上下文区块）
3. 中插 2：`gh_review_pr` 三级分级 + 线程视图截图
4. 中插 3：真实写操作验证的终端输出截图（ok 列表 + LIVE WRITE SMOKE PASSED）
5. 结尾：一次性测试仓库自动清理的对比（6 个残留 → 0 个）
