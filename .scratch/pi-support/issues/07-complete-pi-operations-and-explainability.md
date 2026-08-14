# 07 — 补齐 Pi 运维与可解释能力

**What to build:** 为 Pi 用户补齐日常操作、成本控制、反馈、故障诊断和可见性，使 Pi 支持除宿主配额报告外的主要 OMP auto-router 使用体验。

**Blocked by:** 04 — 完善 Pi target 流语义；05 — 交付跨宿主 Profile 生命周期；06 — 交付跨宿主 Session 与持久化

**Status:** ready-for-agent

- [ ] Pi 支持现有 auto-router command group 的 status、list、show、explain、doctor、budget、shadow、rate、usage、rules 和 help 行为。
- [ ] Explain 展示 profile、tier、confidence、真实 target、candidate chain、估算 tokens、ratings 和 decision reasoning。
- [ ] 实际 settled target 的 calls、thinking levels、token usage 和 estimated cost 被记录。
- [ ] 本地 daily/monthly budget 在 Pi 下参与 candidate eligibility 和告警。
- [ ] 用户 rating 持久化并按照既有门槛影响 candidate chain demotion。
- [ ] Test/build tool failure 临时提高下一请求 tier floor，成功结果清除 escalation。
- [ ] Cooldown、circuit 和 first-visible-output latency 在 Pi candidate chain 中生效并可解释。
- [ ] 支持已有 Provider balance endpoint，并通过 Host 的 authenticated fetch 能力获取数据。
- [ ] Pi 不伪造 OMP usage-report quota；UVI command、usage 和 doctor 明确显示 public interface unavailable。
- [ ] 缺少 UVI 时，本地 budget、balance、rating、cooldown、circuit 和 usage 继续正常工作。
- [ ] Status 使用宿主 namespaced slot，Widget 展示 decision、budget、circuit 和可用的 balance 信息。
- [ ] Widget 相同内容不重复渲染，且不同 Runtime/session 之间互不抑制。
- [ ] TUI、RPC、print 和 JSON 模式均安全降级，不因 UI 能力差异抛错。
- [ ] Doctor 区分 required failure 与 optional host capability degradation，并显示当前 host。
- [ ] Runtime 行为测试覆盖命令、预算、反馈、测试升级、Widget 和 quota degradation。
- [ ] Pi Adapter 测试仅覆盖命令注册、UI 映射和 host-specific capability reporting。
