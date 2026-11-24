# 本机应用查看任务状态（2026-11-19）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

本机 Agent API v1 可选追加 `device/activity` 与 `device/session/focus`，供外接硬件的伴随进程
（Stream Deck、宏键盘、ESP32 等）显示任务状态并打开任务，来源见 makecindy/cindy#11188。
`capabilities` 只在宿主提供对应能力时声明 `features.deviceObserve` 及这两个 method；旧版
Cindy 对它们返回 `METHOD_UNSUPPORTED`，旧客户端不调用即不受影响，既有令牌、恢复句柄与
工具策略不变。

应用授权记录可选保存 `observeLocalTasks: true`，缺省与旧授权均为关闭，`grants.json` 仍为
schema 2；不认识该字段的旧版本读取后按关闭处理，再次写入会丢掉它，升级后需重新开启。
设置操作 `local-agent:set-observe-local-tasks` 只接受本机受信 Renderer，不进入 device-link 的
invoke 白名单，RPC 参数不能开启。未开启时两个 method 返回 HTTP 403 与
`DEVICE_OBSERVE_DISABLED`，且不读取任务。

任务条目只有 `id`、`title`、`agentKind`、`status`、`lastActivityAt`、`startedAt`；
服务端按白名单重新投影，消息正文、工具参数、当前动作摘要与路径不出进程。
`agentKind` 是执行引擎，使用与 `models[].engine` 相同的 `claude-code`、`codex`、`pi`、
`acp`（插件提供的引擎）；客户端对未知值原样显示。
`status` 取值 `running`、`awaiting`、`error`、`done`、`idle`，客户端遇到不认识的值按 `idle`
显示。后续只追加可选字段。`cursor` 是不透明的单调整数，跨实例不复用。

本项只读：发送、中断、回答交互属于另一项独立授权，不随此开关开放。协议与验证入口见
[本机 Agent API](../../local-agent-api.md)。
