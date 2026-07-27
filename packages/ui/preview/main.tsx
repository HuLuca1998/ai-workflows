import { StrictMode, isValidElement, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/index.css';

/**
 * 组件画廊：不依赖任何编辑器插件，直接用 Vite dev server 看全部组件。
 *
 * 自动收集 src/components/*.stories.tsx 里的每个命名导出：
 * 既支持 CSF 的 { args } 形式，也支持直接返回 JSX 的函数形式。
 * 这样一份 stories 同时服务 Preview.js 与这个画廊，不用维护两套用例。
 */

type StoryModule = {
  default?: { component?: (props: never) => ReactNode };
  [name: string]: unknown;
};

const modules = import.meta.glob<StoryModule>('../src/components/*.stories.tsx', { eager: true });

interface Story {
  file: string;
  name: string;
  render: () => ReactNode;
}

const groups = Object.entries(modules)
  .map(([path, mod]) => {
    const file = path.split('/').pop()?.replace('.stories.tsx', '') ?? path;
    const Component = mod.default?.component;
    const stories: Story[] = [];

    for (const [name, value] of Object.entries(mod)) {
      if (name === 'default') continue;

      if (typeof value === 'function') {
        const Story = value as () => ReactNode;
        stories.push({ file, name, render: () => <Story /> });
        continue;
      }

      // CSF：{ args } 交给模块默认导出的 component 渲染
      if (value && typeof value === 'object' && 'args' in value && Component) {
        const args = (value as { args: Record<string, unknown> }).args;
        stories.push({
          file,
          name,
          render: () => <Component {...(args as never)} />,
        });
      }
    }

    return { file, stories };
  })
  .filter((group) => group.stories.length > 0)
  .sort((a, b) => a.file.localeCompare(b.file));

function Gallery() {
  const [active, setActive] = useState<string>(groups[0]?.file ?? '');
  const current = groups.find((g) => g.file === active);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', minHeight: '100vh' }}>
      <nav
        style={{
          borderRight: '1px solid var(--color-divider)',
          padding: 'var(--space-6) var(--space-4)',
          display: 'grid',
          gap: 'var(--space-1)',
          alignContent: 'start',
        }}
      >
        <p
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--color-text-muted)',
            margin: '0 0 var(--space-3)',
          }}
        >
          组件
        </p>
        {groups.map((group) => (
          <button
            key={group.file}
            type="button"
            onClick={() => setActive(group.file)}
            style={{
              textAlign: 'left',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12.5,
              background:
                group.file === active
                  ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)'
                  : 'transparent',
              color: group.file === active ? 'var(--color-accent-300)' : 'var(--color-text)',
            }}
          >
            {group.file}
          </button>
        ))}
      </nav>

      <main style={{ padding: 'var(--space-8)', display: 'grid', gap: 'var(--space-8)', alignContent: 'start' }}>
        {current?.stories.map((story) => (
          <section key={story.name} style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <h2 style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>{story.name}</h2>
            <div
              style={{
                padding: 'var(--space-6)',
                border: '1px solid var(--color-divider)',
                borderRadius: 'var(--radius-md)',
                // Dialog 这类固定定位组件需要一个定位上下文，否则会铺满整页
                position: 'relative',
                isolation: 'isolate',
                minHeight: 60,
              }}
            >
              <Boundary>{story.render()}</Boundary>
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

/** 单个用例出错不该炸掉整个画廊。 */
function Boundary({ children }: { children: ReactNode }) {
  if (!isValidElement(children) && typeof children !== 'object') {
    return <span style={{ color: 'var(--color-status-failed)' }}>用例未返回可渲染内容</span>;
  }
  return <>{children}</>;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}
