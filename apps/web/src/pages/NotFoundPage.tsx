import { Link } from 'react-router';

/** 空态而不是白屏：每个异常路径都要有一条回去的路。 */
export function NotFoundPage() {
  return (
    <article className="page">
      <header className="page__head">
        <h1>找不到这个页面</h1>
        <p className="page__summary">链接可能过期了，或者这一屏还没做。</p>
      </header>
      <Link to="/">回到概览</Link>
    </article>
  );
}
