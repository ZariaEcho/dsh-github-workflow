# WhaleHub 收录表单填写内容

提交地址：<https://github.com/vvlife/whalehub-dsh/issues/new?template=submit-plugin.yml>

| 字段 | 填写内容 |
| --- | --- |
| **GitHub 仓库地址** | `https://github.com/ZariaEcho/dsh-github-workflow` |
| **分类** | `integrations（集成与桥接）` |
| **一句话描述** | 面向 Agent 的 GitHub 工作流工具集：Issue 分析（带关联 PR/历史 Issue 上下文）、套用仓库模板的草稿 PR、分级 PR Review、CI 状态诊断与 GraphQL 合并，写操作全部走 fail-closed 审批闸口。 |
| **安装方式** | `dsh plugin add dsh-github-workflow` |
| **安装注意事项** | 兼容 Profile：`web`。需 `GITHUB_TOKEN`（或经 config 的 `apiTokenEnv` 指定其他变量名），由宿主 credentials 缝逐次解析，不缓存。写操作默认经 approval 服务确认；无 approval 服务时 fail-closed 直接拒绝。 |
| **提交前确认** | 全部勾选 |

## 备注

WhaleHub 的 `registry/plugins.json` 带有 `generatedAt` / `source` 字段，说明它由同步 workflow 自动生成，并「每日自动同步上游 [awesome-deepseek-harness-plugins](https://github.com/vvlife/awesome-deepseek-harness-plugins)」。

因此**两条路都可以**：

1. 直接提上面这个 Issue 表单（1 分钟）；
2. 或者给上游 `vvlife/awesome-deepseek-harness-plugins` 提 PR，WhaleHub 次日自动同步。

仓库已经打好 `dsh-plugin` topic，所以纯自动抓取的目录（如 [awesome-dsh-hub](https://github.com/ukinch605/awesome-dsh-hub)，每小时刷新）不需要任何人工提交。
