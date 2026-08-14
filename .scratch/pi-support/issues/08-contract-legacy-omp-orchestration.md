# 08 — 收缩旧 OMP 专属编排

**What to build:** 在所有共享行为已经通过 Router Runtime 服务 OMP 和 Pi 后，删除旧的重复编排和过渡 interface，使两个 Adapter 都成为只负责宿主映射的薄 Adapter。

**Blocked by:** 07 — 补齐 Pi 运维与可解释能力

**Status:** ready-for-agent

- [x] 所有 routing、state、command、configuration、Widget 和 balance 通用行为只有一个共享实现。
- [x] OMP Adapter 只保留 OMP lifecycle、模型/认证/stream、UI、quota 和 subagent context 映射。
- [x] Pi Adapter 只保留 Pi lifecycle、模型/认证/stream、UI、trust 和 capability 映射。
- [x] 旧 HostPorts 形式通过 contract 阶段删除或收窄，不再向共享层暴露 API Key。
- [x] 删除已无调用方的重复 OMP router、state、command 和 config 编排代码。
- [x] 删除过渡期间保留的旧 interface、兼容 wrapper 和死事件处理器。
- [x] 共享 Runtime 和 core 不包含 OMP、Pi、具体 package namespace import、宿主源码副本或私有内部 import。
- [x] OMP 专属 ambient shims 不进入 Pi 或共享类型检查范围。
- [x] OMP/Pi Adapter 均只使用公开 interface，不修改、patch、monkey-patch、vendor 或覆盖宿主模块。
- [x] OMP 与 Pi Adapter 均有独立类型检查，且共享 Runtime 只有一套行为测试。
- [x] 全量 core、Runtime、OMP Adapter 和 Pi Adapter 测试通过。
- [ ] OMP 真实 smoke 确认原有 profile、failover、commands、quota 和 Widget 无回归。(580 项自动化测试与三层独立 type-check 通过;真实 OMP 会话 smoke 需人工执行)
- [ ] Pi 真实 smoke 确认收缩后仍可完成 profile 路由、工具调用和 failover。(契约测试通过;真实 Pi 会话 smoke 需人工执行)
