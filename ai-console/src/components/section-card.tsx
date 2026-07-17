import type { ReactNode } from "react";

export function SectionCard({
  title,
  description,
  action,
  children,
  className = "",
  id,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`section-card ${className}`.trim()} id={id}>
      <div className="section-card__header">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {action ? <div>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
