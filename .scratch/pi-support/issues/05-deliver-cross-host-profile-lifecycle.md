# 05 — 交付跨宿主 Profile 生命周期

**What to build:** 让 OMP 和 Pi 用户获得一致的 profile 配置、切换、reload 和路径激活体验，同时遵守 Pi 项目信任模型并动态更新虚拟 profile 模型。

**Blocked by:** 03 — 交付 Pi 最小可用路由

**Status:** ready-for-agent

- [ ] Profile 配置组装、默认配置和敏感项目层字段处理由共享行为实现。
- [ ] OMP 继续使用原有用户和项目配置位置，现有配置无需迁移。
- [ ] Pi 用户配置通过 Pi agent directory helper 解析，不硬编码发行版目录。
- [ ] Pi 项目配置只在 trusted project 中读取；untrusted project 被跳过并在 doctor 中说明。
- [ ] 用户配置与项目配置按既有优先级合并，同名 profile 行为保持兼容。
- [ ] 加载可信项目配置后，虚拟 Provider 模型列表立即反映新增、删除和修改后的 profile。
- [ ] `/auto-router reload` 同时替换 Runtime 配置和虚拟 Provider profile 模型。
- [ ] `/auto-router use` 通过模型注册表切换已注册 profile，不构造漂移的临时模型对象。
- [ ] Path activation 使用最长匹配规则，并能在 Pi session start 后切换对应 profile。
- [ ] 新的中性环境变量优先，旧 OMP 环境变量继续作为兼容 fallback。
- [ ] 配置错误保持非致命，并能通过 doctor 和 reload 回显解释。
- [ ] OMP 配置与 profile 行为回归测试继续通过。
- [ ] Pi Adapter 测试覆盖 trusted/untrusted、reload、Provider 更新、use 和 path activation。
