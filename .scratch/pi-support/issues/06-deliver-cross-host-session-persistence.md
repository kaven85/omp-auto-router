# 06 — 交付跨宿主 Session 与持久化

**What to build:** 让 routing decision 和运行健康状态正确跟随 OMP/Pi session 生命周期，使用户在 tree navigation、恢复和重启后继续获得一致的 sticky tier、explain、circuit 和 latency 行为。

**Blocked by:** 03 — 交付 Pi 最小可用路由

**Status:** ready-for-agent

- [x] 新写入的 profile state 和 routing decision 使用宿主中性、带版本的 custom entry 类型。
- [x] OMP 能继续读取旧 OMP custom entry 类型，升级不会丢失现有 session decision。
- [x] Pi session start 从当前 branch 恢复 routing decisions，而不是读取无关 branch。
- [x] Pi 在 new、resume、fork、tree navigation 和 reload 后使用当前 session 的 Runtime 状态。
- [x] `lastDecision` 在 branch/tree 切换后不会错误引用旧 branch。
- [x] Circuit 和 first-visible-output latency 在 session shutdown 时持久化，并在新 Runtime 中恢复。
- [x] 每个宿主使用自己的 agent state directory，不自动交叉迁移运行状态。
- [x] Runtime 持有的 Host 引用在 session replacement 后不会继续使用旧 context。
- [x] Timer 只在 session start 后创建，并在 shutdown 中幂等清理。
- [x] OMP 主会话与 subagent context 采纳规则保留在 OMP Adapter，不复制到 Pi 或共享 Runtime。
- [x] Widget duplicate-render 状态属于 Runtime 实例，新的 session 会正常产生首次渲染。
- [x] 自动化测试覆盖 branch restore、legacy state、session replacement、tracker persistence 和 timer cleanup。
