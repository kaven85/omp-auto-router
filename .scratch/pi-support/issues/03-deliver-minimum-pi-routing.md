# 03 — 交付 Pi 最小可用路由

**What to build:** 让 Pi 用户能够安装同一个包、看到并选择 auto-router profile，并通过共享 Router Runtime 将真实请求发送到配置 target，形成第一个可实际使用的 Pi 纵向切片。

**Blocked by:** 02 — 建立共享 Router Runtime seam

**Status:** ready-for-agent

- [x] 包声明 Pi 扩展入口，Pi 只加载 Pi Adapter，OMP 只加载 OMP Adapter，且不要求修改任一宿主的源码或安装文件。
- [x] Pi Adapter 从用户级配置创建虚拟 auto-router Provider，并为每个 profile 注册模型。
- [x] Profile 模型能出现在 Pi 模型选择流程中并可成功选中。
- [x] 用户选择虚拟 profile 后，真实 prompt 通过 Router Runtime 委托给配置 target。
- [x] Shortcut 控制 token 在 target 请求前被移除。
- [x] 正文和工具调用能够从真实 target 完整返回 Pi agent loop。
- [x] Terminal message 保留真实 target provider、model 和 usage 元数据。
- [x] 至少支持 `/auto-router status`、`profiles`、`current` 和 `use`，且 profile 切换解析已注册的虚拟模型。
- [x] 无 UI 的 print/JSON 模式不会因通知、状态栏或 Widget 调用失败。
- [x] 自动化测试覆盖 Provider 注册、profile 选择、最小路由、工具调用和 required capability 缺失诊断。
- [ ] 真实 Pi smoke 能完成一次虚拟 profile 文本请求和一次工具调用,全程只使用公开 extension interface。(自动化契约测试与 `./node_modules/.bin/pi --list-models -e .` 模型发现探测通过;带真实认证的端到端 smoke 需人工执行)
