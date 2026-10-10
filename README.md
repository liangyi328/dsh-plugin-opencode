# dsh-plugin-opencode

DSH (DeepSeek Harness) 的 OpenCode Zen 免费模型接入插件。

注册 `opencode-free` provider：把本机运行的 OpenCode 后台服务的会话 API 桥接给 DSH，
免费使用 Zen 免费档模型（免费额度只对 OpenCode 客户端开放，因此经本机服务中转）。
选中其模型时，会话输入框旁显示该模型的上下文窗口（只读药丸）。

> provider id 是 `opencode-free` 而不是 `opencode`：后者是 DSH 内建的
> keyed OpenCode Zen provider，二者不能重名。

## 前提

本机安装并运行 OpenCode，其后台服务已在本地监听。

## 登录与凭据

登录发生在 OpenCode 那边，不在 DSH 里：正常安装 OpenCode、登录、启动后台服务
（`opencode serve`）。免费档身份由该服务持有，DSH 只经其 session API 中转，**无需 API key**。

连接信息按以下顺序解析（每次请求重新读取）：

1. **显式配置**（可选）：Config 的 `servicePasswordEnv` 凭据引用（存入 DSH
   凭据服务或设环境变量）+ `serviceUrl`（默认 `http://127.0.0.1:49374`）
2. **自动发现**：读 `~/.config/opencode/service.json`（CLI 写入的端口与口令）；
   亦可用 `OPENCODE_CONFIG_DIR` 指向其它配置目录

服务没跑时报 `no background service found`：跑一次 `opencode` 让它写出 service.json 即可。


## 安装

方式一（推荐）——插件页安装：

1. DSH → 插件 → 安装
2. 粘贴本仓库地址，例如：`https://github.com/<your-name>/dsh-plugin-opencode`

方式二——命令行：

```
dsh plugin install github:<your-name>/dsh-plugin-opencode
```

无构建脚本，依赖由 pnpm 自动安装；装好后在插件页出现卡片，可随时开关。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里用 id-targeted 覆盖（`- id: llm-opencode / config: {...}`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `agent` | `build` | `plan` 为只读代理：把"帮我装 X"变成步骤说明而非实际动作 |
| `debugLogPath` | 未设置 | 诊断日志文件；不设置则静默 |

## 兼容性

DSH `>=0.2.0-rc.2`（见 `package.json` 的 `dsh.engines`）。MIT License。
