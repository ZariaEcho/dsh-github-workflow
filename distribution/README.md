# 分发清单

仓库已就绪的部分：`dsh.bundle.patch`（一条命令安装即挂载）、`dsh-plugin` 等 15 个 topic、v0.1.0 Release、与 0.1.x / 0.2.x 双版本线兼容的 peer 声明。

剩下的是**让别人看见**。

## 收录渠道

| 渠道 | 规模 | 收录机制 | 你要做什么 |
| --- | --- | --- | --- |
| [awesome-dsh-hub](https://github.com/ukinch605/awesome-dsh-hub) | registry | **全自动**：仓库打了 `dsh-plugin` topic 就会在下一轮（每小时）出现 | 已加 topic，等自动收录 |
| [awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) | 353+ | auto-sync CI；README 明示「官方发现渠道 = npm + `dsh-plugin` topic」 | 等自动；如要手动补，按 [`plugins/workflow-automation.md`](https://github.com/kejixiaoliang/awesome-dsh-plugins/blob/main/plugins/workflow-automation.md) 既有行格式提 PR |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/) | **4460** | **手动**：PR 一个 YAML 到 `data/plugins/` | 用 [`awesome-dsh-plugin.yml`](awesome-dsh-plugin.yml)，目标路径 `data/plugins/ZariaEcho__dsh-github-workflow.yml` |
| [WhaleHub](https://github.com/vvlife/whalehub-dsh) | 170 | Issue 表单 / PR `registry/plugins.json` / 上游 PR 次日自动同步 | 用 [`whalehub-issue.md`](whalehub-issue.md) |
| [dshbase.com](https://dshbase.com/plugins/) | 目录站 | 站内有提交入口 | 打开站点找 Submit |
| [dshplugin.store](https://www.dshplugin.store/) | 目录站 | 站内有提交入口 | 打开站点找 Submit |
| npm | — | 官方发现渠道之一，且预构建安装免 `allowBuilds` 审批 | 见下方发布步骤 |

> 提交 awesome-dsh-plugin 的 PR 时注意：只加**你自己的那一个文件**，不要碰 README（它是生成的），也不要改别人的条目——这是被打回的最常见原因。

## npm 发布

```bash
npm login
npm install          # 见下方「已知阻塞」
npm run build
npm publish
```

npm 包会比 GitHub 源码安装体验好一个量级：预构建安装跳过 `allowBuilds` 构建授权（`dsh plugin add github:...` 首次安装会要求授权并让用户重试）。而且仓库 `homepage` 已经指向 npm 页面。

### 已知阻塞（本机实测，发布前必须先解决）

`node_modules/@deepseek-ai/cordis` 是指向 `~/deepseek/vendor/cordis` 的**软链**（你的 DSH 源码 checkout），而该目录没有构建产物 `lib/`。后果有两个：

1. `npm test` 直接 `ERR_MODULE_NOT_FOUND: .../cordis/lib/index.js`（89 项冒烟跑不起来）；
2. `npm install` 触发 npm arborist 崩溃：`Cannot read properties of null (reading 'package')`——因为 npm 要把它替换成 registry 上的 4.0.4。

任选一条路解决：

```bash
# A. 跳过 peer 自动安装，不动这个软链（最省事，先试这个）
npm install --legacy-peer-deps

# B. 临时移走软链，让 npm 装 registry 版（与运行时一致），事后 link 回去
mv node_modules/@deepseek-ai/cordis /tmp/cordis-link-backup
npm install && npm link @deepseek-ai/cordis

# C. 先在 ~/deepseek 里把 vendored cordis 构建出来
```

`npm publish` 会跑 `prepare` → `tsc`，所以必须先有一次成功的 `npm install` 把 `typescript` 装上，否则发布会在打包阶段失败。

### 不发 npm 的备选

把预构建 tarball 挂到 GitHub Release，然后在收录条目里加一行（必须是 GitHub Release 托管的 https `.tgz`）：

```yaml
tarball: https://github.com/ZariaEcho/dsh-github-workflow/releases/download/v0.1.0/dsh-github-workflow-0.1.0.tgz
```

⚠️ 用 `latest/download/` 时文件名不能带版本号，否则下次发版就 404。

## ⚠️ 装完必做：删掉 profile 里的手写挂载行

`~/.dsh/profiles/web/cordis.patch.yml` 里现在有手写的一行：

```yaml
- insert:
    - id: github-workflow
      name: dsh-github-workflow
```

改走 bundle 通道后**必须删掉它**，否则会重复挂载（两个插件实例、两套工具注册）。参考插件的原话是「two Node halves, two sidebars」。

## 验证是否真的激活

```bash
dsh --profile web --dump-config | grep -A3 github-workflow
```

配置里有它，且新会话中能看到 `gh_get_repo_context` 等 12 个 `gh_*` 工具，才算真正加载。**「装了但工具没出现」几乎总是 peer 版本被判不兼容**——行会变成 `disabled: true`（见 README「版本兼容」一节）。
