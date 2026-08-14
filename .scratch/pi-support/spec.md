---
title: Support Pi alongside OMP through a shared routing runtime
labels:
  - ready-for-agent
status: ready-for-agent
tracker: github:kaven85/omp-auto-router
---

## Problem Statement

当前 auto-router 只能作为 OMP 扩展运行。使用 Pi 的用户无法安装同一个包、选择 `auto-router/<profile>` 虚拟模型，也无法复用现有的复杂度分级、策略约束、同请求 failover、预算、评分、冷却、熔断、决策解释和状态持久化能力。

现有路由算法已经基本与宿主解耦，但请求编排、状态、命令、配置、Provider 调用和 UI 逻辑仍集中在 OMP Adapter 中，并直接依赖 OMP 的模型 facade、认证存储、事件和流式接口。直接复制 OMP Adapter 会形成两套会持续漂移的实现，也会使后续的 failover、预算和分类修复必须重复完成。

Pi 与 OMP 的公开扩展接口相近，但并不相同。主要差异包括模型注册表、认证结果、状态栏方法签名、配置与项目信任、流返回类型、模型作用域、会话生命周期，以及 Pi 公开接口不提供 OMP usage report 配额能力。改造必须在不破坏 OMP 现有行为的前提下，通过公开接口支持 Pi，并明确降级不可移植的宿主能力。

本项目不得修改、patch、monkey-patch、vendor 或复制 OMP/Pi 宿主源码，也不得依赖私有字段、内部模块路径或单一版本的实现细节。兼容性必须建立在公开 interface、运行时 capability probe 和明确的降级路径之上。

## Solution

将项目改造成一个同时声明 OMP 和 Pi 扩展入口的双宿主包。保留纯路由 core，新增共享 Router Runtime，统一承担请求编排、路由决策、failover、状态、命令、日志和 Widget 行为；OMP Adapter 与 Pi Adapter 只负责将各自宿主的公开能力映射到一个共享 Host interface。可选能力通过 capability probe 检测，缺失时走可解释降级，不修改宿主源码。

Pi 用户安装同一个包后，可以在模型选择器中选择 `auto-router/<profile>`，并获得与 OMP 一致的 profile、tier、target candidate chain 和 Mode A 流委托体验。Pi Adapter 使用 Pi 的公开 ModelRegistry、Provider 和认证接口委托到真实 target，保留文本、thinking、图片、工具调用、usage、错误和中止语义。

不能通过 Pi 公开接口实现的 OMP usage-report UVI 能力将显式标记为 unavailable，而不是访问 Pi 私有字段或伪造配额。其余本地预算、实际 target 成本、Provider 余额和决策解释继续可用。

共享 Router Runtime 是主要行为 seam。业务行为在该 seam 测试一次；Pi 和 OMP Adapter 只补充模型解析、认证转发、流转换、生命周期和 UI 映射的契约测试。

## User Stories

1. As an existing OMP user, I want the package to retain its OMP extension entry, so that upgrading does not remove my current integration.
2. As an existing OMP user, I want routing decisions to remain behaviorally compatible, so that my profiles continue choosing the same tiers and targets.
3. As an existing OMP user, I want my existing configuration paths to keep working, so that I do not need an immediate migration.
4. As an existing OMP user, I want existing OMP-prefixed environment variables to remain supported, so that automation and shell configuration do not break.
5. As an existing OMP user, I want legacy persisted decision entries to be restored, so that sticky tier and explain behavior survive the upgrade.
6. As a Pi user, I want to install the same package as a Pi package, so that I do not need a separate fork.
7. As a Pi user, I want each configured profile to appear as an `auto-router/<profile>` model, so that profile selection uses Pi's normal model workflow.
8. As a Pi user, I want to switch profiles with `/auto-router use`, so that I can change routing policy without editing configuration.
9. As a Pi user, I want path activation to select the appropriate profile, so that projects can automatically use different routing policies.
10. As a Pi user, I want user-level configuration, so that I can share profiles across projects.
11. As a Pi user, I want trusted project-level configuration to override user configuration, so that repositories can define local routing policy safely.
12. As a Pi user, I want untrusted project configuration to be ignored, so that opening a repository does not silently influence provider routing.
13. As a Pi user, I want reloading configuration to update the virtual profile models immediately, so that newly added profiles appear without restarting Pi.
14. As a Pi user, I want configured targets resolved through Pi's effective model registry, so that built-in models, custom models and provider overrides all work.
15. As a Pi user, I want unavailable or unauthenticated targets excluded, so that routing does not select models that cannot run.
16. As a Pi user, I want `enabledModels` and `--models` scope respected, so that auto-router cannot bypass my model restrictions.
17. As a Pi user, I want auto-router targets prevented from recursively targeting the virtual provider, so that invalid configuration cannot recurse indefinitely.
18. As a Pi user, I want target authentication resolved through Pi's public interface, so that API keys, OAuth, headers, dynamic base URLs and provider environment are handled correctly.
19. As a Pi user, I want virtual-provider credentials kept separate from target-provider credentials, so that dummy auto-router authentication is never forwarded upstream.
20. As a Pi user, I want target Provider streams invoked through Pi's effective Provider, so that custom Providers and model overrides retain their behavior.
21. As a Pi user, I want AbortSignal propagated to target streams, so that pressing Escape cancels the active request promptly.
22. As a Pi user, I want an aborted request excluded from cooldown and circuit failure accounting, so that user cancellation does not make a healthy model unavailable.
23. As a user of either host, I want prompts classified into trivial, simple, standard and complex tiers, so that model strength follows task complexity.
24. As a user of either host, I want shortcut pins removed before delegation, so that `@fast`, `@swe`, `@reasoning`, `@long`, `@vision` and profile controls do not reach the target model.
25. As a user of either host, I want policies and constraints applied before target selection, so that provider, billing, time and capability requirements remain enforceable.
26. As a user of either host, I want candidate ordering to include budgets, latency, circuits, cooldown and ratings, so that routing adapts to operating conditions.
27. As a user of either host, I want same-request failover before substantive output, so that transient target failures can recover without resubmitting my prompt.
28. As a user of either host, I want thinking-only output buffered until a substantive event, so that a failed candidate's private reasoning does not contaminate the replacement response.
29. As a user of either host, I want failover disabled after substantive text, image or tool-call output begins, so that responses from different models are never merged.
30. As a user of either host, I want 429, transient 5xx, overload, timeout, socket, quota and billing failures considered for failover, so that recoverable provider failures do not terminate the task unnecessarily.
31. As a user of either host, I want a failed target placed on cooldown and recorded by the circuit breaker, so that following requests avoid repeatedly rediscovering the same failure.
32. As a user of either host, I want a successful target to clear cooldown and circuit state, so that recovered models return to normal eligibility.
33. As a user of either host, I want per-target first-visible-output latency measured from that target's own start, so that failover delays do not pollute the successful target's ranking.
34. As a user of either host, I want actual settled-target usage and cost recorded, so that budgets and session usage describe the model that answered rather than the virtual model.
35. As a user of either host, I want tier and target thinking preferences applied to the delegated target, so that complexity controls both model selection and reasoning effort.
36. As a Pi user, I want thinking levels clamped using target model capabilities, so that unsupported reasoning levels are not sent to the provider.
37. As a user of either host, I want mixed-phase prompts optionally adjudicated by an LLM, so that ambiguous design-and-implementation requests can receive a better tier.
38. As a user of either host, I want adjudication failures to fail open, so that routing continues with the deterministic classifier.
39. As a user of either host, I want test and build failures to temporarily raise the tier floor, so that debugging follow-ups can use stronger targets.
40. As a user of either host, I want routing decisions persisted in the session branch, so that explain and sticky behavior follow Pi/OMP tree navigation.
41. As a Pi user, I want state restored after new, resume, fork, tree navigation and reload lifecycle transitions, so that routing state follows the active session.
42. As a user of either host, I want circuit and latency snapshots persisted outside the session, so that restarting the host does not discard operational history.
43. As a user of either host, I want `/auto-router explain` to show the selected tier, target, candidate chain, confidence, rating data and reasoning, so that decisions remain auditable.
44. As a user of either host, I want `/auto-router doctor` to report host-specific capabilities, so that unsupported integration surfaces are distinguishable from configuration errors.
45. As a Pi user, I want missing usage-report quota support shown as an explicit degradation, so that I do not mistake absent UVI data for unused quota.
46. As a Pi user, I want local budgets and session cost to keep working without UVI, so that the lack of host quota reports does not disable cost controls.
47. As a Pi user, I want supported Provider balance endpoints to keep working, so that prepaid balances can still be inspected through public authentication APIs.
48. As a user of either host, I want status and Widget output to use the host's supported UI contract, so that routing remains visible in TUI and safe in headless modes.
49. As a user of either host, I want Widget render suppression scoped to the runtime instance, so that one session cannot suppress another session's initial display.
50. As a Pi user in print or JSON mode, I want UI operations to degrade to no-ops, so that non-interactive execution does not fail.
51. As a Pi user in RPC mode, I want notifications and string widgets to use supported RPC behavior, so that automation can observe router status.
52. As a maintainer, I want one shared routing runtime, so that fixes to failover, budgets and decision recording apply to both hosts.
53. As a maintainer, I want host authentication hidden behind the Host interface, so that core and runtime modules never handle credentials.
54. As a maintainer, I want both Adapters to use only documented public interfaces, so that OMP and Pi upgrades do not depend on private implementation details.
55. As a maintainer, I want OMP and Pi type checks isolated, so that each host can compile against its own package namespace.
56. As a maintainer, I want shared behavior tested through a fake Host, so that most tests do not need OMP or Pi runtime mocks.
57. As a maintainer, I want Adapter tests limited to host translation contracts, so that tests remain stable when runtime implementation changes.
58. As a maintainer, I want the package manifest to declare both extension entries, so that each host loads only its own Adapter.
59. As a maintainer, I want neutral state and environment names for new writes, so that shared modules do not continue accumulating OMP-specific terminology.
60. As a maintainer, I want backward-compatible reads for old OMP state and variables, so that neutral naming does not create a breaking migration.
61. As a maintainer, I want a real Pi smoke test before completing the refactor, so that the public Provider delegation approach is proven before substantial code movement.
62. As a maintainer, I want every extraction step to preserve a passing OMP suite, so that dual-host support does not hide regressions until the end.
63. As a maintainer, I want the extension to avoid modifying, patching, vendoring or copying OMP/Pi source, so that host installations remain independently upgradeable.
64. As a maintainer, I want optional host behavior selected through capability probes, so that one extension build can work across multiple compatible host versions.
65. As a maintainer, I want compatibility verified against more than one representative host version where practical, so that support is not inferred from a single local installation.

## Implementation Decisions

1. The package will support OMP and Pi concurrently. Pi support will be additive; OMP support will not be replaced.
2. Pi 0.84.1 is the initially observed compatibility baseline, not a hard runtime dependency. The implementation targets documented public interfaces and capability sets shared by supported OMP/Pi releases. Compatibility with differently namespaced distributions is not implied unless they expose the same documented package contracts.
3. The pure routing core remains host-independent and continues to own classification, profile resolution, policies, constraints, candidate partitioning, budgets, UVI mathematics, circuit breaking, latency tracking and generic failover semantics.
4. A shared Router Runtime module will be introduced above core. It will own request orchestration, runtime state, commands, configuration replacement, decision persistence, usage accounting, provider-balance orchestration, Widget composition and lifecycle-independent behavior.
5. Router Runtime is the primary seam. It will expose boot, stream, command, tool-result, quota-refresh, configuration-replacement and shutdown behaviors without exposing OMP or Pi context types.
6. A single Host interface will represent the capabilities needed by Router Runtime: model discovery, model eligibility, target streaming, virtual-profile switching, context usage, optional quota reports, authenticated Provider JSON fetching, branch entries, custom entries and UI output.
7. The Host interface will expose target streaming rather than API-key retrieval. Authentication details, headers, base URLs, OAuth refresh and provider environment remain private to each Adapter.
8. Runtime models will use a normalized representation containing provider, model ID, canonical key, model capabilities, pricing and optional supported thinking levels. Native host model objects remain Adapter-private.
9. OMP Adapter will be reduced to a mapping from the existing OMP extension surface into the Host interface. OMP-specific structural types and host-bundled pi-ai shims remain isolated in that Adapter.
10. Pi Adapter will use Pi's official extension types directly. It will not add ambient replacements for Pi packages.
11. Pi will register a virtual `auto-router` Provider with one model per profile. Virtual models retain zero cost because actual cost is recorded from the settled target stream.
12. Provider registration will be repeatable. Loading trusted project configuration or running configuration reload will re-register the virtual Provider so profile additions and removals are reflected immediately.
13. Profile switching will resolve the registered virtual model through the host model registry instead of constructing an ad hoc model object.
14. Pi target discovery will use the effective model registry and respect the session's scoped models. An empty scoped list means all available models; a non-empty list is an allowlist.
15. Targets whose provider is the virtual `auto-router` Provider are invalid and will be excluded to prevent recursive delegation.
16. Pi target streaming will resolve the effective Provider and request authentication through public ModelRegistry methods. Virtual Provider authentication fields will be removed before target authentication fields are applied.
17. Dynamic authentication base URLs will be applied to the delegated model value; target API key, headers and provider environment will be passed to the effective Provider stream.
18. Behavioral stream options such as cancellation, response callbacks, cache settings and session metadata will be forwarded where supported, while virtual credentials and virtual reasoning values will not be forwarded.
19. The Pi Adapter will convert Router Runtime's async event iterable into Pi's AssistantMessageEventStream using the public event-stream factory.
20. Runtime-generated failures will be thrown as normalized router errors. Each Adapter will convert them into a valid host assistant error event with zero usage and an error message.
21. Successful delegated terminal messages will retain the real target provider and model metadata so Pi/OMP session usage and cross-provider replay describe the model that answered.
22. Failover continues to buffer all pre-substantive events. Thinking events do not settle a candidate; text, image completion, tool-call lifecycle and successful completion do.
23. Thinking effort will be passed directly to the delegated target stream. Global session thinking mutation will not be the default shared mechanism.
24. Pi thinking support will be derived from model metadata, including model-specific thinking maps. Target-level configuration remains the highest-precedence override, followed by tier-level configuration.
25. If OMP runtime validation proves that direct reasoning options do not preserve existing behavior, OMP Host may retain its current set-and-restore compatibility mechanism internally without exposing that difference to Router Runtime.
26. User configuration is loaded before the initial virtual Provider registration. Pi project configuration is loaded only after session start and only when the project is trusted.
27. Pi configuration and state directories will be resolved through Pi's public agent-directory and config-directory helpers rather than hardcoded paths.
28. OMP configuration and state paths remain unchanged.
29. Project configuration continues to be treated as less trusted than user configuration. Sensitive target balance-endpoint overrides remain disallowed in the project layer.
30. New custom session entries will use host-neutral, versioned custom types. OMP restoration will also recognize legacy OMP custom types.
31. New environment variables will use a host-neutral auto-router prefix. OMP-prefixed variables remain fallback aliases; host-specific Pi aliases may also be recognized after neutral values.
32. Pi's public interface does not expose OMP usage reports. Pi Host therefore advertises quota capability as unavailable and returns no quota snapshots.
33. UVI-dependent routing adjustments are disabled when the Host cannot provide quota snapshots. The doctor and usage commands explicitly report this capability degradation.
34. Local budget tracking, actual token cost, feedback, balance endpoints, cooldown, circuit and latency remain enabled when host quota reports are unavailable.
35. Provider balance requests will use an authenticated Host operation rather than exposing API keys to Router Runtime.
36. Pi lifecycle handling will follow session start, tree navigation and session shutdown. Timers are started only after session start and are cleaned up idempotently on shutdown.
37. OMP-specific subagent context adoption remains in the OMP Adapter only. It will not be generalized into Router Runtime or copied to Pi.
38. Widget duplicate-render state moves into the runtime instance rather than module-global state.
39. Commands remain a single `/auto-router` command group with existing subcommands and argument completion. Command behavior is shared; Adapter registration is host-specific.
40. Doctor output becomes capability-driven and identifies the active host. Unsupported capabilities are warnings, while required Provider/model/stream failures remain errors.
41. The package manifest declares both OMP and Pi extension entries. Host packages are peer dependencies. Development fixtures may use reproducible versions, but runtime compatibility is defined by public capabilities rather than an exact host build.
42. Core, shared Runtime, OMP Adapter and Pi Adapter receive separate type-check targets so host package namespaces do not leak across module sets.
43. A compatibility spike is a hard gate before the main extraction. It must prove Pi virtual Provider registration, nested target streaming, auth forwarding, cancellation, text, thinking, tool calls and terminal usage through public interfaces.
44. Modifying, patching, monkey-patching, vendoring or copying OMP/Pi source is prohibited. The extension must not write into host installation directories or replace host modules at runtime.
45. Private host access is prohibited, including private object fields, undocumented internal imports and assumptions about internal source layout. If public delegation cannot satisfy the spike, implementation must stop and reassess instead of bypassing the host interface.
46. Host-version differences are handled by public capability probes and narrow Adapter strategies. Missing optional capabilities produce explicit degradation; missing required streaming capabilities make that Adapter unsupported with an actionable diagnostic.
47. A set-model-before-agent fallback is not the planned implementation because it cannot preserve same-request Mode A failover. It is considered only as an explicitly degraded alternative after the spike fails.
48. Work will be split into incremental changes that keep the OMP suite green: compatibility spike, Host/state extraction, Router Runtime extraction, shared commands/configuration, Pi Adapter, Pi lifecycle/degradation, then documentation and smoke verification.

## Testing Decisions

1. Good tests assert externally observable routing behavior: selected target order, emitted stream events, persisted decisions, UI output, capability reporting and host calls. They do not assert private helper structure or internal method call order unless that order is part of the stream contract.
2. The highest and primary testing seam is Router Runtime with a fake Host. This exercises the complete behavior from profile plus prompt to delegated event stream and persisted outcome without binding tests to either extension framework.
3. The project will avoid duplicating Router Runtime behavior tests in both Adapter suites. Classification, shortcut stripping, policies, candidate ordering, failover, cooldown, circuit, latency, budgets, feedback, usage and Widget behavior are tested once through the Runtime seam.
4. Existing pure core tests remain prior art for deterministic module behavior and continue to test lower-level algorithms where their interfaces already form established seams.
5. Existing OMP router, commands, host-ports and index tests are prior art for Adapter harnesses. Behavior-oriented cases will migrate upward to Router Runtime; OMP-specific translation cases remain in the OMP Adapter suite.
6. Router Runtime tests cover profile selection, context-token input, mixed-phase adjudication fallback, policy precedence, empty candidate diagnostics, shadow ordering and decision reasoning.
7. Router Runtime tests cover failover before substantive output, thinking-only failure, non-retryable errors, all-candidates-failed aggregation, no failover after substantive output and clean abort handling.
8. Router Runtime tests verify per-target latency starts at each target attempt rather than at the start of the whole candidate chain.
9. Router Runtime tests verify usage and estimated cost are attributed to the settled target, including cache read/write pricing and absent pricing.
10. Router Runtime tests verify test/build failure escalation and successful test clearing through the public tool-result handler.
11. Router Runtime tests verify persisted decision restoration follows the active branch and accepts legacy OMP custom entry types.
12. Router Runtime tests verify Widget duplicate suppression is instance-local and that missing quota data does not render misleading UVI information.
13. Shared configuration tests cover default, user and project layering; profile replacement; validation fallback; and removal of project-layer sensitive balance endpoints.
14. Shared environment tests cover neutral variable precedence, OMP fallback compatibility, invalid numeric values and minimum refresh/cooldown bounds.
15. Pi Adapter contract tests use a Pi-shaped mock at the Adapter seam. They verify extension registration and context translation rather than rerunning routing policy tests.
16. Pi model contract tests cover available model discovery, scoped model intersection, unauthenticated targets, custom models, current virtual model and recursive target exclusion.
17. Pi authentication contract tests verify target API key, headers, base URL and environment are forwarded, and virtual credentials are never forwarded.
18. Pi stream bridge tests cover text, thinking, image, tool call, done, terminal error, thrown router error and cancellation.
19. Pi terminal error tests assert a valid AssistantMessage shape, including provider, model, stop reason, error message, timestamp and complete zero usage structure.
20. Pi lifecycle tests cover trusted and untrusted project configuration, Provider re-registration, path activation, reload, tree restoration and idempotent shutdown.
21. Pi UI tests cover namespaced status and Widget IDs, notifications, headless no-op behavior and capability-aware doctor output.
22. OMP regression tests verify existing Provider registration, main-session context adoption, configuration paths, state restoration, status behavior and quota integration remain unchanged.
23. Manifest and type-check tests ensure each host loads only its declared Adapter and that Adapter code imports only documented public package entrypoints.
24. A real Pi smoke test is required in addition to unit tests. It must select a virtual profile, execute a text response and tool call, strip a shortcut, switch profile, cancel a request and exercise at least one failover.
25. A real OMP smoke test remains required after the shared Runtime migration to catch host-loader behavior that structural mocks cannot validate.
26. The compatibility spike must specifically verify whether Pi provider request/response callbacks remain observable for delegated target requests. Any public-interface limitation is documented before implementation continues.
27. Compatibility contract tests cover capability-present and capability-absent hosts, proving that optional methods are probed before use and degrade predictably.
28. Where practical, smoke verification runs against the oldest declared compatible version and a current supported version rather than only the developer's installed version.
29. Tests and build scripts must never edit host source trees or installed host packages.
30. All implementation slices must pass the full core, Runtime and OMP suites; Pi Adapter tests and Pi type checking become mandatory once the Pi Adapter is introduced.

## Out of Scope

1. Supporting Pi distributions that use a different package namespace or materially different extension interface.
2. Replacing or removing the existing OMP extension entry.
3. Renaming the npm package in the first dual-host release.
4. Reimplementing OMP usage-report quota discovery through Pi private internals.
5. Adding provider-specific Pi quota integrations beyond existing authenticated balance endpoints.
6. Changing the core complexity-classification vocabulary or tier ladder.
7. Redesigning profile, tier, target, policy, budget or activation configuration schemas except where host-neutral naming is required.
8. Implementing set-model-before-agent Mode B as the primary Pi routing strategy.
9. Adding new custom tools, shortcuts, custom TUI components or Provider service-tier controls.
10. Solving general Pi built-in retry policy or changing users' global retry settings.
11. Guaranteeing that third-party extensions observing provider hooks can see nested delegated target requests unless the Pi public interface demonstrably forwards those hooks.
12. Migrating OMP state files into Pi state directories; each host retains separate operational state.
13. Publishing the package to npm as part of this implementation.
14. Refactoring unrelated classifier heuristics, task-boundary semantics or analytics beyond what is necessary for dual-host support.
15. Supporting a host version by patching, forking, modifying, vendoring or copying that host's source.

## Further Notes

- The repository currently has no domain glossary or ADR directory. This spec uses the established project vocabulary from the README and source: profile, tier, target, candidate, candidate chain, routing decision, HostPorts, Mode A, failover, cooldown, circuit, UVI, shadow and adjudication.
- The installed and reviewed Pi version is 0.84.1 and serves only as the initial research baseline. Its public ModelRegistry exposes model lookup, effective Provider access, authentication resolution and completion, but does not expose a public streaming method on ModelRegistry itself. The compatibility spike validates direct effective-Provider streaming, then records the minimum public capability set rather than coupling support to 0.84.1 internals.
- The public Pi extension lifecycle explicitly recreates extension state around new, resume, fork and reload flows. Pi Adapter should follow that lifecycle rather than copying OMP's process-global subagent protections.
- Pi package installation expects host packages to be peer dependencies. Runtime dependencies such as YAML remain normal package dependencies. Peer ranges and compatibility claims describe tested public contracts rather than an exact local host build.
- Development tooling may use reproducible fixture versions, but release compatibility must be verified through a small version matrix and capability probes; no build or test may patch installed host packages.
- The intended first release should be versioned as a feature release, with release notes clearly identifying Pi UVI quota degradation, the tested version range and the required public capabilities.
- The primary success criterion is not merely that Pi can select a target. It is that one shared Router Runtime preserves Mode A stream delegation and same-request failover without creating two behavior implementations.
