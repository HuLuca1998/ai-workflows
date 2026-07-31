import { RichText } from './RichText.js';
import { Frame } from './_frame.js';

export default {
  title: 'Components/RichText',
  component: RichText,
};

export const Typical = () => (
  <Frame>
    <div style={{ maxWidth: 520 }}>
      <RichText
        text={[
          '## 分析结论',
          '共发现 **3 处**问题，其中 `race condition` 那条*必须*先修。',
          '',
          '- 缓存层在并发写时丢更新',
          '- 重试没有上限',
          '- 日志里打出了完整令牌',
          '',
          '详见 [复现步骤](https://example.com/repro)。',
        ].join('\n')}
      />
    </div>
  </Frame>
);

export const CodeAndTable = () => (
  <Frame>
    <div style={{ maxWidth: 520 }}>
      <RichText
        text={[
          '```rust',
          'let answer = store.get(&id)?;',
          'assert_eq!(answer.status, "approved");',
          '```',
          '',
          '| 用例 | 结果 |',
          '| --- | --- |',
          '| 回答原样带回 | 通过 |',
          '| 拒绝不带答案 | 通过 |',
        ].join('\n')}
      />
    </div>
  </Frame>
);

export const HostileInput = () => (
  <Frame>
    <div style={{ maxWidth: 520 }}>
      {/* 渲染通道关着：HTML 按原文显示，javascript: 链接不成链接 */}
      <RichText
        text={['<img src=x onerror=alert(1)>', '', '[看起来无害的链接](javascript:alert(1))'].join(
          '\n',
        )}
      />
    </div>
  </Frame>
);
