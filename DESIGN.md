# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-07-17
- Primary product surfaces: AI 基础设施总览、组件门户、Agent 管理、大模型渠道、能力管理、数据与知识、评测、可观测、系统设置
- Evidence reviewed: `/Users/aca/dev/ai-fde/.omx/plans/sme-agent-infrastructure-v0.1.md`、`ai-console/src/app/(console)`、`ai-console/src/components`、`ai-console/src/lib/server/component-data.ts`、Envoy AI Gateway 1.0 standalone 配置契约、用户确认的 Next.js 技术栈与工具链边界

## Brand

- Personality: 可靠、克制、清晰，像一间友好的工业控制室
- Trust signals: 明确的健康状态、更新时间、影响范围、版本、环境和审计记录
- Avoid: 赛博霓虹、紫色渐变、大面积玻璃拟态、只依赖颜色表达状态、无决策价值的仪表盘堆叠

## Product goals

- Goals: 让平台管理员在一分钟内判断系统健康；通过一个 Portal 找到、打开和配置整套组件；让 Agent 开发者管理模型、工具、连接和知识；让业务负责人看到质量、成本和影响
- Non-goals: 首版不提供通用 Docker/Kubernetes 生命周期编排；不在浏览器回显密钥；大模型网关管理只覆盖渠道、端点、凭证和模型路由，不扩展为成本分析、流量分析或评测产品；不复制 Jaeger、Promptfoo、SilverBullet 和 Open Connector 的专业管理能力
- Success signals: 关键组件状态可见；每个组件都能从 Portal 进入工作台或对应的内部管理页；大模型渠道可以保存、测试并自动应用到 Envoy；异常能定位到受影响 Agent；所有高风险动作有明确确认和审计语义

## Personas and jobs

- Primary personas: 平台管理员、Agent 开发者、业务负责人
- User jobs: 检查健康、发现组件、打开专业工作台、配置端点、管理 Agent 依赖、同步知识、运行评测、追踪故障、控制预算
- Key contexts of use: 桌面端日常运维与配置；移动端查看异常和快速处置

## Information architecture

- Primary navigation: “工作台”组包含总览、组件门户、Agent、能力、数据、评测、可观测；与其同级的“设置”组包含模型配置和系统设置
- Core routes/screens: `/`、`/components`、`/agents`、`/capabilities`、`/data`、`/evaluations`、`/observability`、`/model-channels`、`/settings`
- Content hierarchy: 待处理事项 > 常用组件入口 > 核心运行指标 > Agent 运行矩阵 > 依赖与服务状态 > 近期变化 > 快捷操作

## Design principles

- Principle 1: 运行态优先。首先回答“哪里有问题、影响什么、下一步做什么”。
- Principle 2: 配置与生产发布分离。保存草稿、连接测试和生产生效具有不同语义。
- Principle 3: 状态可解释。“未配置”“离线”“异常”“健康”分别表达，不能都显示为红色。
- Principle 4: Portal 负责导航与治理，专业组件负责深度操作。所有外部工作台以明确的新窗口动作打开，内部管理语义留在 ai-console。
- Principle 5: 数据诚实。组件未配置、未产生结果或能力尚未落地时显示真实空状态，不使用演示通过率、成本、切片或告警填补界面；配置页将关键数量集中在顶部摘要，避免在管理区重复展示同一数据和低决策价值说明。
- Tradeoffs: 首版用紧凑表格和清晰分区承载高信息密度；减少复杂实时图表和动画；不通过嵌入 iframe 牺牲专业组件的兼容性与安全边界。

## Visual language

- Color: 深墨蓝侧栏、暖灰画布、青绿正常、琥珀关注、朱红故障；状态同时使用图标和文字
- Typography: 系统中文无衬线字体；数字、版本、Trace ID 和模型名使用等宽字体
- Spacing/layout rhythm: 4px 基础网格；页面间距 24–32px；表格行保持紧凑但可点击
- Shape/radius/elevation: 10–18px 圆角；细边框和轻阴影；不使用浮夸悬浮层
- Motion: 160–240ms 状态和抽屉过渡；遵守 `prefers-reduced-motion`
- Imagery/iconography: 使用线性图标和简化运行脉络，不使用装饰性插画

## Components

- Existing components to reuse: AppShell、PageHeader、SectionCard、StatusPill、ServiceTable、Button 和全局语义 token
- New/changed components: ComponentPortal、PortalSummary、PortalCard、GatewayChannelManager；AppShell 使用“工作台/设置”分组导航；大模型渠道使用独立页面、两张实时摘要卡片、紧凑管理区和右侧编辑抽屉；总览和管理页面读取统一真实数据快照；空状态明确标注未配置项
- Variants and states: default/hover/focus/disabled；healthy/degraded/offline/unconfigured/running
- Token/component ownership: 全局 CSS 自定义属性定义基础 token；组件使用语义 class，不增加独立设计系统依赖

## Accessibility

- Target standard: WCAG 2.2 AA
- Keyboard/focus behavior: 所有链接、按钮、表单和菜单可键盘访问；焦点轮廓清晰；跳过导航链接；渠道编辑抽屉打开时锁定焦点，支持 Escape 关闭并将焦点还原到触发控件
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
- Success: 使用页面内 `aria-live` 消息确认保存、连通性测试和网关重载状态，并在页面中反映最新配置；新增渠道在保存成功前保持为抽屉内草稿，不进入卡片列表或摘要统计；模型同步从当前渠道配置读取可用模型并只回填抽屉草稿，不自动保存或发布
- Disabled: 解释为什么不可操作
- Offline/slow network, if applicable: 健康检查超时后保留最后成功时间并标记“状态未知”

## Content voice

- Tone: 简洁、直接、可执行
- Terminology: 使用“Agent”“大模型网关”“大模型渠道”“能力”“连接”“知识空间”“评测”“Trace”；不在界面中使用英文旧名称，组件产品名作为次级标签
- Microcopy rules: 按钮使用完整动词；危险操作包含具体对象；密钥只显示“已配置/未配置”

## Implementation constraints

- Framework/styling system: Next.js 16 App Router、React 19、TypeScript、原生 CSS、Lucide 图标
- Design-token constraints: token 集中在 `globals.css`；不引入 Tailwind 或重量级 UI 套件
- Performance constraints: 首屏不加载大型图表库；默认 Server Component，仅交互区域使用 Client Component
- Compatibility constraints: Node.js 22；现代 Chrome、Edge、Firefox、Safari；Envoy AI Gateway 渠道配置使用 v1beta1 原生资源并通过只读共享卷注入
- Test/screenshot expectations: ESLint、TypeScript、Vitest、Next production build；桌面浏览器为主验证；`/model-channels` 卡片布局、渠道新增、右侧抽屉编辑、密钥不回显、连接测试、保存应用、组件刷新和 Portal 链接完成交互 smoke test

## Open questions

- [ ] 企业现有 OIDC 提供方与角色声明格式 / 平台负责人 / 影响登录与 RBAC
- [ ] 真实部署是否允许控制台调用 Docker API / 运维负责人 / 影响服务启停能力
- [ ] 成本数据的结算币种和供应商账单口径 / 财务与平台负责人 / 影响预算页面
- [ ] 多客户模式还是单企业模式 / 产品负责人 / 影响 Open Connector 与知识空间隔离方式
