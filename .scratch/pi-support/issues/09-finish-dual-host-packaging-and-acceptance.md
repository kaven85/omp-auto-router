# 09 — 完成双宿主打包与真实验收

**What to build:** 将已经完成的双宿主实现整理成可安装、可验证、可维护的交付版本，让 OMP 和 Pi 用户都能按文档完成安装、配置、诊断和升级。

**Blocked by:** 08 — 收缩旧 OMP 专属编排

**Status:** ready-for-agent

- [ ] Package manifest 同时声明 OMP 和 Pi 扩展入口，并包含 Pi package discoverability metadata。
- [ ] Host packages 作为 peer dependencies 声明；兼容范围由公开 capability contract 和测试矩阵定义，而不是锁死本机单一版本。
- [ ] Core、Router Runtime、OMP Adapter 和 Pi Adapter 有清晰的独立 type-check/test 命令，并提供一个全量验证命令。
- [ ] 中文和英文文档说明 OMP 与 Pi 的安装方式、配置位置、profile 选择、reload 和卸载方式。
- [ ] 文档说明 Pi scoped models 需要同时允许虚拟 profile 和真实 targets。
- [ ] 文档列出中性环境变量、旧 OMP fallback 和优先级。
- [ ] 文档明确 Pi usage-report UVI 不可用，但 local budget、usage、balance 和 failover 可用。
- [ ] 示例配置使用双宿主中性术语，并提醒用户替换成模型注册表中真实存在的 provider/model。
- [ ] Doctor 和故障排查文档覆盖模型不存在、未认证、scope 排除、project untrusted、全链 cooldown 和 Provider error。
- [ ] Routing analytics 脚本能够针对 OMP 或 Pi state directory 工作，或接受明确的日志路径。
- [ ] Pi 真实验收覆盖安装、模型选择、profile 切换、shortcut 剥离、文本、工具调用、failover、abort、reload 和 session restore。
- [ ] OMP 真实验收覆盖原有安装、profile 路由、failover、quota、commands 和 state restore。
- [ ] 文档明确禁止通过修改、patch、monkey-patch、vendor 或复制 OMP/Pi 源码来启用兼容性。
- [ ] 在可行范围内，真实验收覆盖最老声明兼容版本和当前支持版本，并记录 required/optional capability matrix。
- [ ] Release notes 标明测试过的 OMP/Pi 版本范围、公开 capability 边界、状态命名兼容和 UVI 降级。
- [ ] 构建、测试和安装流程不会写入或覆盖 OMP/Pi 安装目录。
- [ ] 不在本 ticket 发布 npm 包或删除旧 OMP 支持。
