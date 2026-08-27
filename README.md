# dsh-keep-awake 防休眠

任意 DSH agent、subagent 或后台任务运行时，阻止操作系统进入休眠；全部空闲后按可配置的宽限期自动释放。带 Web 设置页（设置 → 防休眠 Keep Awake）。

## 活动判定

- **运行中的 agent**：`agents.list()` 中 `status === 'running'` 的 agent（覆盖主 agent、subagent、workflow 子代理）
- **后台任务**：`jobs.list()` / `jobs.list(agent)` 中 `running`/`stopping` 的任务（覆盖 `run_in_background` 命令与后台 subagent 任务）

每 5 秒轮询 + `agent/status`、`subagent/start|end`、job 集变更事件即时重扫。

## 防休眠机制（每平台一个辅助进程，subprocess 服务管理）

| 平台 | 机制 |
|---|---|
| Windows | PowerShell `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)`（勾选“同时阻止屏幕关闭”时加 `ES_DISPLAY_REQUIRED`） |
| macOS | `caffeinate [-d] -i -s` |
| Linux | `systemd-inhibit --what=idle --mode=block sleep 1e8` |

## 设置（持久化在 profile 的 settings.yaml，namespace `keep-awake`）

- `enabled`：总开关（默认 true）
- `graceMs`：全部活动结束后的宽限期，15s–5m（默认 60s）
- `preventDisplaySleep`：同时阻止屏幕关闭（默认 false）
- `manualHold`：手动保持唤醒（默认 false）

## 多语言

界面跟随 DSH 全局语言（框架 `locale` 服务，namespace `keep-awake`，zh/en 字典）：未显式设置时自动跟随浏览器/系统语言，切换语言后即时生效（含侧边栏标签）。

## HTTP 路由（loopback）

- `GET /dsh-keep-awake/state` — 当前状态（活动计数、助手进程、配置）
- `PUT /dsh-keep-awake/config` — 更新配置，body `{ "section": {...} }`

## 安装

```sh
# profile 目录内（如 ~/.dsh/profiles/web）
pnpm add "dsh-keep-awake@link:<包路径>"
# 并把 "dsh-keep-awake" 加入 package.json 的 dsh.profile.bundles，然后 pnpm install
# 重启 profile
```
