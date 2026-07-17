import { ArrowLeft, SearchX } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty-page">
      <span><SearchX size={30} /></span>
      <h1>没有找到这个页面</h1>
      <p>对象可能已被删除，或链接指向尚未发布的配置。</p>
      <Link className="button button--primary" href="/"><ArrowLeft size={15} /> 返回总览</Link>
    </div>
  );
}
