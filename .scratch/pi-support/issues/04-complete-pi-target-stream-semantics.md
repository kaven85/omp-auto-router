# 04 — 完善 Pi target 流语义

**What to build:** 将 Pi 最小路由扩展为可安全用于真实多 Provider profile 的 Mode A 实现，使认证、模型作用域、thinking、failover、错误和取消语义与 Router Runtime 的约定一致。

**Blocked by:** 03 — 交付 Pi 最小可用路由

**Status:** ready-for-agent

- [x] Target 仅通过 Pi 公开的有效模型注册表和 Provider interface 解析，支持 built-in、custom model 和 Provider override。
- [x] 未认证、不可用或不在 session scoped models 内的 target 不进入 eligible candidate chain。
- [x] 空 scoped models 表示允许全部可用模型；非空 scoped models 作为真实 allowlist。
- [x] auto-router target 被拒绝，无法递归调用虚拟 Provider。
- [x] Target API Key、OAuth、headers、动态 base URL 和 provider environment 正确应用，虚拟认证字段被剥离。
- [x] 行为型 stream options 和 AbortSignal 在公开接口允许的范围内透传。
- [x] Target 和 tier thinking 作用于真实 delegated request，并按照 target thinking capabilities clamp。
- [x] 429、可重试 5xx、overload、timeout、socket、quota 和 billing failure 能在实质输出前切换候选。
- [x] Thinking-only partial 不阻止 failover，失败候选的缓冲内容不会进入最终回复。
- [x] Text、image 或 tool call 开始后不再 failover，避免合并两个模型的输出。
- [x] 用户取消不触发 cooldown 或 circuit failure。
- [x] Runtime 抛错被转换为结构完整的 Pi assistant error event。
- [x] 所有 host-version 差异通过 capability probe 或公开 interface 的 Adapter strategy 处理，不读取版本私有实现。
- [x] 自动化测试覆盖认证转发、作用域、thinking、custom Provider、failover、error shape、abort 和 capability degradation。
- [ ] 真实 Pi smoke 验证至少一次首选 target 失败后切换候选,且不 patch 宿主流实现。(failover 语义由 tests/pi-adapter/stream-contract.test.ts 覆盖;真实 provider smoke 需人工执行)
