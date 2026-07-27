import { StatusBadge } from './StatusBadge.js';
import { Table } from './Table.js';
import { Tag } from './Tag.js';
import { Frame } from './_frame.js';

interface Row {
  id: string;
  name: string;
  desc: string;
  version: string;
}

const rows: Row[] = [
  {
    id: '1',
    name: 'GitHub Issue 修复',
    desc: '读 Issue → 分析 → 审批 → worktree → 修复 → PR',
    version: 'v7',
  },
  {
    id: '2',
    name: '发布编排',
    desc: '计划 → 并行调用 3 个子工作流 → 审查 → 决策 → 汇总',
    version: 'v4',
  },
  { id: '3', name: '错误日志归因', desc: '解析 crash log → 定位模块 → 通知', version: 'v11' },
];

export const WorkflowList = () => (
  <Frame>
    <Table<Row>
      caption="全部工作流"
      columns={[
        { key: 'name', header: '名称', width: '28%' },
        { key: 'desc', header: '说明' },
        {
          key: 'version',
          header: '版本 · 状态',
          width: '22%',
          render: (row) => (
            <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Tag tone="accent">{row.version}</Tag>
              <StatusBadge status={row.id === '3' ? 'failed' : 'succeeded'} />
            </span>
          ),
        },
      ]}
      rows={rows}
    />
  </Frame>
);

export const Empty = () => (
  <Frame>
    <Table
      caption="运行记录"
      columns={[
        { key: 'a', header: '工作流' },
        { key: 'b', header: '状态' },
      ]}
      rows={[]}
      empty="先在编辑器点运行"
    />
  </Frame>
);
