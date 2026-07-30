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
  // 收起态只有图标，文案要进 title / aria-label，所以先取出来
  const permissionPreset = permission?.preset ?? '未设置权限档';
  const permissionDetail = permission?.detail ?? '首次配置时授权工作目录并选择权限档';
  const environmentText = environment?.text ?? '环境尚未检查';

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
        {/*
          * 收起的是**标签**，不是**信息**。
          *
          * 这两块此前在窄窗口下一个整块不渲染、一个只剩图标：用户不知道
          * 自己开的是哪一档权限（那一档决定了 AI 能不能改他的文件），
          * 也不知道那个红色感叹号在说什么 —— 悬停没有 title，读屏念不出。
          */}
        <div
          className="side-nav__permission"
          aria-label={`权限档：${permissionPreset}`}
          title={`权限档：${permissionPreset} —— ${permissionDetail}`}
        >
          <p className="side-nav__permission-title">
            <i className="ph ph-shield-check" aria-hidden="true" />
            {collapsed ? null : permissionPreset}
          </p>
          {collapsed ? null : (
            <p className="side-nav__permission-detail">{permissionDetail}</p>
          )}
        </div>

        <p
          className="side-nav__env"
          data-ok={environment?.ok ? 'true' : 'false'}
          aria-label={`环境：${environmentText}`}
          title={`环境：${environmentText}`}
        >
          <i
            className={`ph ${environment?.ok ? 'ph-heartbeat' : 'ph-warning-circle'}`}
            aria-hidden="true"
          />
          {collapsed ? null : <span>{environmentText}</span>}
        </p>
      </div>
    </nav>
  );
}
