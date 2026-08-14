# 01 — 验证 Pi Mode A 公开流委托

**What to build:** 建立一个最小但完整的 Pi Mode A tracer bullet：用户选择一个虚拟 auto-router profile 后，请求通过 Pi 的公开扩展、模型注册表和 Provider interface 委托给真实 target。该验证必须证明后续共享 Router Runtime 不需要访问 Pi 私有实现。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 以 Pi 0.84.1 作为初始研究基线，提炼完成该委托所需的最小公开 capability set，而不是建立精确版本依赖。
- [x] 至少一个满足该公开 capability set 的 Pi 版本能注册并选择虚拟 auto-router profile 模型。
- [x] 虚拟模型能通过公开 interface 将请求委托给一个真实 target，并流式返回正文。
- [x] 委托流能完整返回 thinking、工具调用、terminal message 和真实 usage。
- [x] target 使用自身的 API Key、OAuth 结果、headers、动态 base URL 和 provider environment；虚拟 Provider 的认证字段不会泄漏给 target。
- [x] AbortSignal 能取消真实 target 流，且取消被识别为用户中止而不是 target failure。
- [ ] 验证自定义 Provider 与内置 Provider 均可通过有效 Provider interface 调用。（当前有公开 Provider contract test；需要带真实认证 target 的手工验证）
- [ ] 验证 delegated request 对 Pi provider request/response hooks 的可见性，并记录公开 interface 的实际限制。（需要带真实 HTTP target 的手工验证）
- [x] 实现只使用 Pi 公开导出，不访问 ModelRegistry 私有 runtime、内部模块路径或其他未文档化字段。
- [x] 实现和验证过程不修改、patch、monkey-patch、vendor、复制或覆盖 Pi/OMP 源码及安装目录。
- [x] 可选能力通过 capability probe 检测；缺失时产生明确诊断而不是基于版本号猜测。
- [x] 自动化契约测试覆盖文本、工具调用、认证、usage、error、abort，以及 capability present/absent 两种宿主。
- [x] 若公开 interface 无法满足 Mode A，ticket 输出明确的阻断结论，不以私有接口或宿主源码修改绕过。
