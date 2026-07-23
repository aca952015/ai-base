# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-07-21
- Primary product surfaces: AI 基础设施总览、组件门户、Agent 管理、模型配置、MCP配置、集成管理、连接器配置、能力管理、数据与知识、评测、可观测、认证管理、系统设置
- Evidence reviewed: `/Users/aca/dev/ai-fde/.omx/plans/sme-agent-infrastructure-v0.1.md`、`ai-console/src/app/(console)`、`ai-console/src/components`、`ai-console/src/lib/server/component-data.ts`、Envoy AI Gateway 1.0 standalone 配置契约、用户确认的 Next.js 技术栈与工具链边界

## Brand

- Personality: 精确、安静、可信，像一套为企业 AI 基础设施延伸设计的 macOS 系统设置
- Trust signals: 明确的健康状态、更新时间、影响范围、版本、环境和审计记录
- Avoid: 赛博霓虹、暖色营销渐变、高亮玻璃拟态、密集无层级的仪表盘堆叠、只依赖颜色表达状态；使用 macOS 式材质与控件精度，但不复制 Apple 标志、系统图标或消费级设置内容

## Product goals

- Goals: 让平台管理员在一分钟内判断系统健康；通过一个 Portal 找到、打开和配置整套组件；让 Agent 开发者管理模型、工具、连接和知识；让业务负责人看到质量、成本和影响
- Non-goals: 首版不提供通用 Docker/Kubernetes 生命周期编排；不在浏览器回显密钥；Envoy AI 管理覆盖模型渠道和 MCP 上游路由，不扩展为成本分析、流量分析或评测产品；AI Console 只承接 Open Connector 的高频连接生命周期，不复制其 Action 调试、Runtime Token、策略和运行日志能力；不复制 Jaeger、Promptfoo 与 SilverBullet 的专业管理能力
- Success signals: 关键组件状态可见；全局能力网关的功能入口状态可见；每个组件都能从 Portal 进入工作台或对应的内部管理页；模型渠道与 MCP 服务可以保存、测试并自动应用到 Envoy AI；Open Connector Provider 可搜索、连接凭据可按上游 Schema 动态配置、OAuth 可完成授权；异常能定位到受影响 Agent；所有高风险动作有明确确认和审计语义

## Personas and jobs

- Primary personas: 平台管理员、Agent 开发者、业务负责人
- User jobs: 检查健康、发现组件、打开专业工作台、配置端点、管理 Agent 依赖、同步知识、运行评测、追踪故障、控制预算
- Key contexts of use: 桌面端日常运维与配置；移动端仅保证基础可读与可访问

## Information architecture

- Primary navigation: “工作台”组包含总览、组件门户、Agent、能力、数据、评测、可观测、认证；与其同级的“设置”组包含模型配置、MCP配置、集成管理、连接器配置和系统设置
- Core routes/screens: `/`、`/components`、`/agents`、`/capabilities`、`/data`、`/evaluations`、`/observability`、`/authentication`、`/model-channels`、`/mcp`、`/integrations`、`/connectors`、`/settings`
- Content hierarchy: 待处理事项 > 常用组件入口 > 核心运行指标 > Agent 运行矩阵 > 依赖与服务状态 > 近期变化 > 快捷操作

## Design principles

- Principle 1: 运行态优先。首先回答“哪里有问题、影响什么、下一步做什么”。
- Principle 2: 配置与生产发布分离。保存草稿、连接测试和生产生效具有不同语义。
- Principle 3: 状态可解释。“未配置”“离线”“异常”“健康”分别表达，不能都显示为红色。
- Principle 4: Portal 负责导航与治理，专业组件负责深度操作。所有外部工作台以明确的新窗口动作打开，内部管理语义留在 ai-console。
- Principle 5: 数据诚实。组件未配置、未产生结果或能力尚未落地时显示真实空状态，不使用演示通过率、成本、切片或告警填补界面；配置页将关键数量集中在顶部摘要，避免在管理区重复展示同一数据和低决策价值说明。
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
- New/changed components: ComponentPortal、PortalSummary、PortalCard、GatewayChannelManager、GatewayMcpManager、IntegrationManager、ConnectorManager；ComponentPortal 的资源卡片是全局唯一卡片视觉基准，分组容器、摘要/指标、资源列表、可操作设置和抽屉内工具卡片统一复用其石墨渐变卡面、细冷灰边框、14px 圆角、轻微内高光与克制阴影 token，仅按信息密度调整尺寸和内边距；模型、MCP、集成和连接器管理区沿用组件门户的“分组标题 + 直接卡片网格”结构，不再用 SectionCard 包裹整个资源列表；集成管理固定显示飞书、企微、钉钉三个分组，分组标题使用与应用卡片一致的平台彩色图标底座增强识别，每组直接添加多个企业应用；应用配置包含应用名称、App ID、App Secret 和可选备注，紧凑资源卡片展示应用名称、App ID、最多两行备注，并在底部弱化显示密钥状态和更新时间；点击卡片进入编辑，不展示存储实现或重复操作控件；侧栏使用系统蓝整行选中态和彩色图标底座，不添加无操作意义的窗口控制装饰；资源状态使用小型状态圆点和文字；ComponentPortal 将 Caddy 全局能力网关作为功能入口组件展示，但不将其误作 UI 网关；AppShell 使用“工作台/设置”分组导航和无顶部栏的全局内容布局，所有控制台路由均从窗口内容区顶部开始，不为产品名、搜索或环境状态预留空白横条；所有模块的 PageHeader 直接以页面标题为第一层可见内容，不显示产品名、数据时间或技术栈 eyebrow 小标签；模型、MCP、集成和连接器配置分别使用独立页面、卡片管理区和占满视口高度的右侧编辑抽屉，抽屉头部和底部固定、中间内容独立滚动；连接器抽屉先选择 Open Connector Provider，再从其 `auth` Schema 选择认证类型并动态生成凭据或 OAuth 表单；Provider 在编辑时固定，认证类型可切换；Open Connector MCP 使用带“系统内置”标识的只读卡片；总览和管理页面读取真实数据快照；空状态明确标注未配置项
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
- Disabled: 解释为什么不可操作；系统托管的 Open Connector MCP 不提供启停、编辑和删除控件，仅保留连接测试
- Offline/slow network, if applicable: 健康检查超时后保留最后成功时间并标记“状态未知”

## Content voice

- Tone: 简洁、直接、可执行
- Terminology: 使用“Agent”“模型配置”“MCP配置”“大模型渠道”“能力”“连接”“知识空间”“评测”“Trace”；Envoy AI 作为组件产品名使用
- Microcopy rules: 按钮使用完整动词；危险操作包含具体对象；密钥只显示“已配置/未配置”

## Implementation constraints

- Framework/styling system: Next.js 16 App Router、React 19、TypeScript、原生 CSS、Lucide 图标
- Design-token constraints: token 集中在 `globals.css`；卡片必须使用 `--card-*` 语义 token，不在页面组件中复制阴影、边框或圆角值；不引入 Tailwind 或重量级 UI 套件
- Performance constraints: 首屏不加载大型图表库；默认 Server Component，仅交互区域使用 Client Component
- Compatibility constraints: Node.js 22；现代 Chrome、Edge、Firefox、Safari；Envoy AI Gateway 模型与 MCP 配置使用 v1beta1 原生资源并通过只读共享卷注入
- Test/screenshot expectations: ESLint、TypeScript、Vitest、Next production build；桌面浏览器为主验证；`/model-channels`、`/mcp`、`/integrations` 与 `/connectors` 的卡片布局、新增草稿、右侧抽屉、密钥不回显、动态字段、OAuth 授权和保存后再展示完成交互 smoke test

## Open questions

- [ ] 企业现有 OIDC 提供方与角色声明格式 / 平台负责人 / 影响登录与 RBAC
- [ ] 真实部署是否允许控制台调用 Docker API / 运维负责人 / 影响服务启停能力
- [ ] 成本数据的结算币种和供应商账单口径 / 财务与平台负责人 / 影响预算页面
- [ ] 多客户模式还是单企业模式 / 产品负责人 / 影响 Open Connector 与知识空间隔离方式
