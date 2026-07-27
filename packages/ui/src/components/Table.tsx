import type { ReactNode } from 'react';

export interface TableColumn<Row> {
  key: keyof Row & string;
  header: string;
  width?: string;
  render?: (row: Row) => ReactNode;
}

export interface TableProps<Row extends { id: string }> {
  /** 表格用途说明；同时作为无障碍名称。 */
  caption: string;
  columns: TableColumn<Row>[];
  rows: Row[];
  /** 空态文案——设计要求每个列表都有空态，不留白屏。 */
  empty?: string;
  onRowClick?: (row: Row) => void;
}

export function Table<Row extends { id: string }>({
  caption,
  columns,
  rows,
  empty = '暂无数据',
  onRowClick,
}: TableProps<Row>) {
  return (
    <table className="aiwf-table">
      <caption className="aiwf-table__caption">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} scope="col" style={column.width ? { width: column.width } : undefined}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="aiwf-table__empty">
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              data-clickable={onRowClick ? 'true' : undefined}
            >
              {columns.map((column) => (
                <td key={column.key}>{column.render ? column.render(row) : String(row[column.key] ?? '')}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
