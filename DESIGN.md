# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-13
- Primary product surfaces: AI 基础设施总览、组件门户、Agent 管理、账号绑定、配置指南、模型配置、MCP配置、集成管理、连接器配置、能力管理、数据与知识、评测、可观测、认证管理、系统设置及组件二级设置
- Evidence reviewed: `/Users/aca/dev/ai-fde/.omx/plans/sme-agent-infrastructure-v0.1.md`、`.omx/plans/model-mcp-observability-expansion.md`、`docs/observability-schema.md`、`ai-console/src/app/(console)`、`ai-console/src/components`、`ai-console/src/lib/server/observability.ts`、`vendor/open-connector/src/providers/wecom_bot`、Envoy AI Gateway 1.0 standalone 配置契约、用户确认的 Next.js 技术栈与工具链边界

## Brand

- Personality: 精确、安静、可信，像一套为企业 AI 基础设施延伸设计的 macOS 系统设置
- Trust signals: 明确的健康状态、更新时间、影响范围、版本、环境和审计记录
- Avoid: 赛博霓虹、暖色营销渐变、高亮玻璃拟态、密集无层级的仪表盘堆叠、只依赖颜色表达状态；使用 macOS 式材质与控件精度，但不复制 Apple 标志、系统图标或消费级设置内容

## Product goals

- Goals: 让平台管理员在一分钟内判断系统健康；通过一个 Portal 找到、打开和配置整套组件；让 Agent 开发者管理模型、工具、连接和知识；让业务负责人看到质量、成本和影响
- Non-goals: 首版不提供通用 Docker/Kubernetes 生命周期编排；不在浏览器回显密钥；Envoy AI 管理覆盖模型渠道和 MCP 上游路由，不扩展为金额成本或评测产品；AI Console 只承接 Open Connector 的高频连接生命周期，不复制其 Action 调试、Runtime Token、策略和运行日志能力；可观测页提供安全治理摘要与有界诊断样本，不复制 Jaeger waterfall、任意 tag/event 查询，也不把 Trace 冒充零丢失账本；不复制 Promptfoo 与 LightRAG 的专业管理能力
- Success signals: 关键组件状态可见；全局能力网关的功能入口状态可见；每个组件都能从 Portal 进入工作台或对应的内部管理页；模型渠道与 MCP 服务可以保存、测试并自动应用到 Envoy AI；Open Connector Provider 可搜索、连接凭据可按上游 Schema 动态配置、OAuth 可完成授权；异常能定位到受影响 Agent；所有高风险动作有明确确认和审计语义

## Personas and jobs

- Primary personas: 平台管理员、Agent 开发者、业务负责人
- User jobs: 检查健康、发现组件、打开专业工作台、配置端点、管理 Agent 依赖、同步知识、运行评测、追踪故障、控制预算
- Key contexts of use: 桌面端日常运维与配置；移动端仅保证基础可读与可访问

## Information architecture

- Primary navigation: “工作台”组包含总览、组件门户、Agent、能力、数据、评测、可观测、认证；与其同级的“设置”组包含模型配置、MCP配置、集成管理、连接器配置、账号绑定、配置指南和系统设置；普通员工仅显示账号绑定与配置指南
- Core routes/screens: `/`、`/components`、`/agents`、`/account`、`/client-setup`、`/capabilities`、`/data`、`/evaluations`、`/observability`、`/authentication`、`/model-channels`、`/mcp`、`/integrations`、`/integrations/wecom-authentication`、`/integrations/feishu`、`/integrations/dingtalk`、`/connectors`、`/settings`、`/settings/lightrag`；`/auth/wework` 与 `/auth/wework/complete` 是不进入导航的企微身份绑定事务入口
- Content hierarchy: 待处理事项 > 常用组件入口 > 核心运行指标 > Agent 运行矩阵 > 依赖与服务状态 > 近期变化 > 快捷操作

## Design principles

- Principle 1: 运行态优先。首先回答“哪里有问题、影响什么、下一步做什么”。
- Principle 2: 配置与生产发布分离。保存草稿、连接测试和生产生效具有不同语义。
- Principle 3: 状态可解释。“未配置”“离线”“异常”“健康”分别表达，不能都显示为红色。
- Principle 4: Portal 负责导航与治理，专业组件负责深度操作。所有外部工作台以明确的新窗口动作打开，内部管理语义留在 ai-console。
- Principle 5: 数据诚实。组件未配置、未产生结果或能力尚未落地时显示真实空状态，不使用演示通过率、成本、切片或告警填补界面；配置页仅在数据能辅助决策时使用顶部摘要，若内容只是重复表单当前值则省略，避免重复展示同一数据和低决策价值说明。
- Tradeoffs: 首版用紧凑表格和清晰分区承载高信息密度；减少复杂实时图表和动画；不通过嵌入 iframe 牺牲专业组件的兼容性与安全边界。

## Visual language

- Color: 冷中性炭黑窗口、半透明深灰侧栏、石墨色分组表面；系统蓝表示选择和主要操作，绿色表示正常，黄色表示关注，红色表示故障，状态同时使用图标和文字；深色卡片中的模型标签使用高亮浅蓝文字、低饱和深蓝底和细蓝灰边框，避免同色相前景与背景造成识别困难
- Typography: 系统中文无衬线字体；数字、版本、Trace ID 和模型名使用等宽字体
- Spacing/layout rhythm: 4px 基础网格；页面间距 24–32px；表格行保持紧凑但可点击
- Shape/radius/elevation: 参考 macOS 系统设置的 10–20px 连续圆角、0.5–1px 冷灰高光边、柔和低扩散阴影与轻微背景模糊；分组卡片保持贴合窗口，不使用明显上浮动效
- Motion: 160–240ms 状态和抽屉过渡；遵守 `prefers-reduced-motion`
- Imagery/iconography: Lucide 线性图标放入带色彩编码的圆角底座，形成类似系统设置的快速识别能力；不复制 Apple 系统图标和装饰性插画

## Components

- Existing components to reuse: AppShell、PageHeader、SectionCard、StatusPill、ServiceTable、Button 和全局语义 token
- New/changed components: ComponentPortal、PortalSummary、PortalCard、GatewayChannelManager、GatewayMcpManager、IntegrationManager、ConnectorManager、AccountIntegrationManager、McpClientSetupGuide、LightRagSettingsForm、WeComAuthSettingsForm、ObservabilitySummary、ObservabilityCallsTable、TraceDetail；账号绑定页在当前平台身份条下方使用同级状态条展示“企微身份已绑定/未绑定”、自动可见机器人数量和绑定/解绑操作，不展示 CorpID、UserID、OIDC Subject 或其他低决策价值摘要；ComponentPortal 的资源卡片是全局唯一卡片视觉基准，分组容器、摘要/指标、资源列表、可操作设置和抽屉内工具卡片统一复用其石墨渐变卡面、细冷灰边框、14px 圆角、轻微内高光与克制阴影 token，仅按信息密度调整尺寸和内边距；模型、MCP、集成和连接器管理区沿用组件门户的“分组标题 + 直接卡片网格”结构，不再用 SectionCard 包裹整个资源列表；可观测页按模型/MCP 分区展示固定指标与最多 50 条安全诊断样本，15m/1h/24h/7d 只影响规范摘要，Trace 搜索最多 24 小时并明确截断；Trace 详情只展示白名单时间线，完整 waterfall 通过受 Pomerium 管理员保护的 HTTPS Jaeger 新窗口打开；模型错误率或 TTFT 未被 probe 证明时显示“不可用”，不以估算值或 Trace 数补齐；其余资源与管理交互继续遵守现有组件和抽屉约定
- Integration directory: `/integrations` 只显示企业微信、飞书、钉钉三条带真实状态的目录入口；飞书与钉钉分别在 `/integrations/feishu`、`/integrations/dingtalk` 复用平台过滤后的 `IntegrationManager`，保存或重新加载后不得串入另一个平台的应用卡片。
- AppShell sidebar behavior: 参考 Codex App 使用固定品牌区、独立滚动导航区和固定账号区；导航区使用低对比度细滚动条并与主内容滚动完全分离；固定账号区以“账号名 + 管理员/员工 Badge / 邮箱”两行呈现，账号菜单从底部向上展开为紧凑操作列表，账户信息、安全和费用在能力落地前以“即将开放”占位，设置遵守管理员权限，退出登录保持可用
- Variants and states: default/hover/focus/disabled；healthy/degraded/offline/unconfigured/running
- Token/component ownership: 全局 CSS 自定义属性定义基础 token；组件使用语义 class，不增加独立设计系统依赖

## Accessibility

- Target standard: WCAG 2.2 AA
- Keyboard/focus behavior: 所有链接、按钮、表单和菜单可键盘访问；焦点轮廓清晰；跳过导航链接；配置抽屉打开时锁定焦点，支持 Escape 关闭并将焦点还原到触发控件
- Contrast/readability: 正文与状态文字满足 AA；状态不只依赖颜色
- Screen-reader semantics: 使用语义化 landmark、表头、`aria-live` 和可读按钮名称
- Reduced motion and sensory considerations: 降低动态效果时移除位移动画和持续脉冲

## Responsive behavior

- Supported breakpoints/devices: 360px 手机、768px 平板、1280–1600px 桌面
- Layout adaptations: 桌面固定侧栏；平板压缩导航；手机改为顶部品牌与横向导航，表格转换为卡片行
- Touch/hover differences: 触控目标最小 44px；关键信息不依赖 hover

## Interaction states

- Loading: 保留布局骨架并显示具体动作文本
- Empty: 区分尚未创建、筛选无结果、权限不足和服务未接入
- Error: 展示原因、影响和恢复动作，不只显示错误码
- Success: 使用页面内 `aria-live` 消息确认保存、连通性测试、OAuth 授权和网关重载状态，并在页面中反映最新配置；新增或编辑模型渠道、MCP 服务时由抽屉保存动作直接写入并应用 Envoy AI，成功前保持为抽屉内草稿，不进入卡片列表或摘要统计；卡片上的启停直接应用，删除经确认后直接应用，不设置页面级二次保存按钮；Open Connector 连接在上游成功前保持为抽屉内草稿；模型同步从当前渠道配置读取可用模型并只回填抽屉草稿，不自动保存或发布
- LightRAG apply: 保存前验证所选模型仍由启用渠道发布，并使用最小 Embedding 请求确认向量能力与维度；配置更新后等待 LightRAG 重新健康再显示成功，失败时回滚旧配置并保留表单内容
- WeCom auth apply: 在集成管理保存 CorpID、可选的新 App Secret 和固定 `/callbacks/wecom` 公网中继地址后，页面通过 `aria-live` 明确提示新绑定立即生效；编辑时不回显 Secret，留空保留已加密值；服务端 Schema 验证失败时保留草稿并显示具体字段错误。页面明确提示企微可信 IP 应配置中继固定公网出口，不再展示本地公开认证入口、直接/中继模式或企业邮箱域等无效字段。
- WeCom identity link: 企业微信工作台首页先通过主 Pomerium 确认当前平台会话，再由公网中继完成一次性企微身份证明；成功、取消、请求过期、身份冲突、企业不匹配和系统失败分别在 `/account` 以页面内 `aria-live` 消息表达。绑定中不展示授权 ID、加密结果、nonce、CorpID 或明文 UserID；解绑需明确确认“企微共享机器人将不再出现在 MCP 清单”，成功后立即刷新状态条。完成页仍位于主 Console，会再次校验当前平台身份。
- Disabled: 解释为什么不可操作；系统托管的 Open Connector 与企业知识库 RAG MCP 不提供启停、编辑和删除控件，仅保留连接测试和工具查看
- Offline/slow network, if applicable: 健康检查超时后保留最后成功时间并标记“状态未知”
- Observability degradation: Metrics 或 Trace 单侧不可用时保留另一侧结果并使用 `aria-live` 说明影响；无诊断样本区分尚未产生、导出失败与筛选无结果；100% sampling 不写成零丢失承诺

## Content voice

- Tone: 简洁、直接、可执行
- Terminology: 使用“Agent”“模型配置”“MCP配置”“大模型渠道”“能力”“连接”“知识空间”“评测”“Trace”；Envoy AI 作为组件产品名使用
- Microcopy rules: 按钮使用完整动词；危险操作包含具体对象；密钥只显示“已配置/未配置”

## Implementation constraints

- Framework/styling system: Next.js 16 App Router、React 19、TypeScript、原生 CSS、Lucide 图标
- Design-token constraints: token 集中在 `globals.css`；卡片必须使用 `--card-*` 语义 token，不在页面组件中复制阴影、边框或圆角值；不引入 Tailwind 或重量级 UI 套件
- Performance constraints: 首屏不加载大型图表库；默认 Server Component，仅交互区域使用 Client Component
- Compatibility constraints: Node.js 22；现代 Chrome、Edge、Firefox、Safari；Envoy AI Gateway 模型与 MCP 配置使用 v1beta1 原生资源并通过只读共享卷注入
- Test/screenshot expectations: ESLint、TypeScript、Vitest、Next production build；桌面浏览器为主验证；`/observability` 与 `/observability/traces/[traceId]` 需覆盖管理员权限、loading/empty/error/offline、截断、安全字段白名单、HTTPS Jaeger 深链、键盘和 360/768/1280px；`/model-channels`、`/mcp`、`/integrations`、`/integrations/wecom-authentication`、`/integrations/feishu`、`/integrations/dingtalk` 与 `/connectors` 继续覆盖卡片布局、平台隔离、表单草稿、密钥不回显、动态字段、OAuth 授权和保存后生效；`/account` 与 `/auth/wework` 还需覆盖主 Pomerium 精确 audience、中继不可用、票据篡改/过期/重放、同浏览器 Cookie、身份冲突、企业不匹配、取消、绑定/解绑和不展示明文 UserID

## Open questions

- [ ] 企业现有 OIDC 提供方与角色声明格式 / 平台负责人 / 影响登录与 RBAC
- [ ] 真实部署是否允许控制台调用 Docker API / 运维负责人 / 影响服务启停能力
- [ ] 成本数据的结算币种和供应商账单口径 / 财务与平台负责人 / 影响预算页面
- [ ] 多客户模式还是单企业模式 / 产品负责人 / 影响 Open Connector 与知识空间隔离方式
