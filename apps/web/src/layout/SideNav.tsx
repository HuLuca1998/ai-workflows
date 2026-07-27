import { NavLink } from 'react-router';
import { NAV_COLLAPSE_WIDTH, NAV_ITEMS } from '../navigation.js';
import { useViewportWidth } from '../hooks/useViewportWidth.js';

export interface SideNavProps {
  /** 各类计数，用于导航项徽标；为 0 的不显示。 */
  counts?: { waitingApproval?: number; activeRuns?: number };
  /** 当前权限档与已授权目录数（功能文档 §7 的权限三档）。 */
  permission?: { preset: string; detail: string };
  /** 环境状态行；未检查时显示提示而不是假的「正常」。 */
  environment?: { ok: boolean; text: string };
}

/**
 * 主导航：固定 216px，窗口窄于 1360px 时收成图标栏。
 * 收起后文字隐藏，但链接的可访问名称保留——读屏用户不该因为窗口窄就失去信息。
 *
 * 底部两块是图纸里的固定元素：当前权限档与环境状态。它们常驻的理由是
 * 「显式权限」——用户任何时候都该看得见现在授权到什么程度。
 */
export function SideNav({ counts, permission, environment }: SideNavProps) {
  const width = useViewportWidth();
  const collapsed = width < NAV_COLLAPSE_WIDTH;

  return (
    <nav aria-label="主导航" className="side-nav" data-collapsed={collapsed ? 'true' : 'false'}>
      {collapsed ? null : <p className="side-nav__group">工作区</p>}

      <div className="side-nav__items">
        {NAV_ITEMS.map((item) => {
          const count = item.badge ? counts?.[item.badge] : undefined;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className="side-nav__item"
              title={collapsed ? item.label : undefined}
            >
              <i className={`ph ${item.icon}`} aria-hidden="true" />
              <span className={collapsed ? 'sr-only' : 'side-nav__label'}>{item.label}</span>
              {count ? (
                <span className="side-nav__badge" aria-label={`${count} 项待处理`}>
                  {count}
                </span>
              ) : null}
            </NavLink>
          );
        })}
      </div>

      <div className="side-nav__foot">
        {collapsed ? null : (
          <div className="side-nav__permission">
            <p className="side-nav__permission-title">
              <i className="ph ph-shield-check" aria-hidden="true" />
              {permission?.preset ?? '未设置权限档'}
            </p>
            <p className="side-nav__permission-detail">
              {permission?.detail ?? '首次配置时授权工作目录并选择权限档'}
            </p>
          </div>
        )}

        <p className="side-nav__env" data-ok={environment?.ok ? 'true' : 'false'}>
          <i
            className={`ph ${environment?.ok ? 'ph-heartbeat' : 'ph-warning-circle'}`}
            aria-hidden="true"
          />
          {collapsed ? null : <span>{environment?.text ?? '环境尚未检查'}</span>}
        </p>
      </div>
    </nav>
  );
}
