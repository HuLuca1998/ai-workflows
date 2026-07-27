import { NavLink } from 'react-router';
import { NAV_COLLAPSE_WIDTH, NAV_ITEMS } from '../navigation.js';
import { useViewportWidth } from '../hooks/useViewportWidth.js';

/**
 * 主导航：固定 216px，窗口窄于 1360px 时收成图标栏。
 * 收起后文字隐藏，但链接的可访问名称保留——读屏用户不该因为窗口窄就失去信息。
 */
export function SideNav() {
  const width = useViewportWidth();
  const collapsed = width < NAV_COLLAPSE_WIDTH;

  return (
    <nav aria-label="主导航" className="side-nav" data-collapsed={collapsed ? 'true' : 'false'}>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === '/'}
          className="side-nav__item"
          title={collapsed ? item.label : undefined}
        >
          <span aria-hidden="true" className="side-nav__glyph">
            {item.glyph}
          </span>
          <span className={collapsed ? 'sr-only' : 'side-nav__label'}>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
