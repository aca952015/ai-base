import Link from "next/link";

export const dynamic = "force-dynamic";

const messages: Record<string, { title: string; detail: string }> = {
  denied: {
    title: "企业微信认证已取消",
    detail: "平台账号没有发生变化。可以返回企业微信工作台后重新打开 AI Base。",
  },
  expired: {
    title: "认证请求已过期",
    detail: "请重新发起认证，不要在企业微信或平台登录页面停留过久。",
  },
  conflict: {
    title: "企业微信身份已被占用",
    detail: "该企业微信身份已经关联其他平台账号，请联系管理员处理。",
  },
  invalid: {
    title: "企业微信身份校验失败",
    detail: "认证票据无效、已使用或不属于当前企业，请重新打开应用。",
  },
  failed: {
    title: "企业微信认证暂时不可用",
    detail: "请稍后重试；如果问题持续存在，请联系管理员检查中继和系统认证配置。",
  },
};

export default async function WeComAuthStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string | string[] }>;
}) {
  const query = await searchParams;
  const result = typeof query.result === "string" ? query.result : "failed";
  const message = messages[result] || messages.failed;
  return (
    <main className="auth-status-page">
      <section className="auth-status-card" aria-live="polite">
        <span className="auth-status-card__eyebrow">AI Base · 企业微信</span>
        <h1>{message.title}</h1>
        <p>{message.detail}</p>
        <Link className="button button--primary" href="/auth/wework">重新认证</Link>
      </section>
    </main>
  );
}
