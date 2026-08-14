# 02 — 建立共享 Router Runtime seam

**What to build:** 在不改变 OMP 用户行为的前提下扩展一个宿主无关的 Router Runtime seam，并让一次完整 OMP 请求通过该 seam 完成分类、candidate chain、流委托、failover 和决策记录，为 Pi Adapter 提供可复用的纵向路径。

**Blocked by:** 01 — 验证 Pi Mode A 公开流委托

**Status:** ready-for-agent

- [x] 引入一个宿主无关的 Host interface，覆盖模型发现、target eligibility、target streaming、profile 切换、上下文用量、会话条目、UI 输出和公开 capability probes。
- [x] Host interface 以 stream target 表达委托能力，不向 Router Runtime 暴露 API Key 或 OAuth 细节。
- [x] 引入共享 Router Runtime，并通过 fake Host 形成主要行为测试 seam。
- [x] 至少一条完整 OMP 请求通过 Router Runtime 完成 prompt 提取、shortcut 剥离、复杂度分类、target 选择和流式响应。
- [x] 同一路径支持正文前 failover、thinking 缓冲、成功 settled 和错误记录。
- [x] Routing decision、usage 和 first-visible-output latency 仍归属于真实 settled target。
- [x] 现有 OMP 虚拟 Provider、profile 选择和用户可见输出保持兼容。
- [x] 新 seam 以 expand 方式加入，尚未迁移的旧 OMP 调用方可以继续工作。
- [x] 共享 Runtime 不导入任何 OMP/Pi 宿主包、私有内部模块或宿主源码副本。
- [x] 缺失的可选 Host capability 可显式降级，缺失的 required capability 返回可操作诊断。
- [x] 现有 core 与 OMP 测试全部通过，并新增 Runtime 级行为测试。
