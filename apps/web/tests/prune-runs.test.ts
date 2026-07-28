import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/prune-runs.mjs` 的守卫。
 *
 * 它删的是用户跑过的真实记录，误删没有撤销 —— 所以两件事必须压住：
 * 默认不删，以及删的时候**真的把事件一起带走**。
 *
 * 后者是踩过的坑：`sqlite3` 命令行默认不开外键（PRAGMA foreign_keys
 * 的缺省值就是 OFF），于是 `DELETE FROM run` 不级联，表面上「已删掉
 * 6 次运行」，实际留下 111 条指向不存在的运行的孤儿事件。
 */

const 脚本 = join(import.meta.dirname, '../../../scripts/prune-runs.mjs');

function 建库(): string {
  const db = join(mkdtempSync(join(tmpdir(), 'aiwf-prune-')), 'aiwf.sqlite');
  execFileSync('sqlite3', [
    db,
    `CREATE TABLE run (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT, started_at TEXT, workdir TEXT);
     CREATE TABLE run_event (
       id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER
     );
     INSERT INTO run VALUES ('r1','w','succeeded','2026-01-01T00:00:00Z',NULL),
                            ('r2','w','failed','2026-01-02T00:00:00Z',NULL),
                            ('r3','w','succeeded','2026-01-03T00:00:00Z',NULL);
     INSERT INTO run_event VALUES ('e1','r1',1),('e2','r2',1),('e3','r3',1),('e4','r3',2);`,
  ]);
  return db;
}

const 跑 = (db: string, ...args: string[]) =>
  execFileSync('node', [脚本, db, ...args], { encoding: 'utf8' });

const 数一下 = (db: string, sql: string) =>
  Number(execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim());

describe('prune-runs', () => {
  it('默认只预览，一条都不删', () => {
    const db = 建库();
    const out = 跑(db, '--keep', '1');

    expect(out).toContain('这是预览');
    expect(数一下(db, 'SELECT COUNT(*) FROM run')).toBe(3);
    expect(数一下(db, 'SELECT COUNT(*) FROM run_event')).toBe(4);
  });

  it('--yes 之后按 keep 保留最近的几次', () => {
    const db = 建库();
    跑(db, '--keep', '1', '--yes');

    expect(数一下(db, 'SELECT COUNT(*) FROM run')).toBe(1);
    // 保留的是最近插入的那一条（按 rowid 倒序），不是 status 最好的那条
    expect(execFileSync('sqlite3', [db, 'SELECT id FROM run'], { encoding: 'utf8' }).trim()).toBe(
      'r3',
    );
  });

  it('事件跟着运行一起删 —— 不留孤儿', () => {
    // sqlite3 命令行默认不开外键，不显式 PRAGMA 的话删了运行、
    // 事件还在，而且指向一个不存在的 run
    const db = 建库();
    跑(db, '--keep', '1', '--yes');

    expect(数一下(db, 'SELECT COUNT(*) FROM run_event')).toBe(2);
    expect(
      数一下(db, 'SELECT COUNT(*) FROM run_event WHERE run_id NOT IN (SELECT id FROM run)'),
    ).toBe(0);
  });

  it('keep 大于总数时什么都不删', () => {
    const db = 建库();
    const out = 跑(db, '--keep', '99', '--yes');

    expect(out).toContain('没有要删的');
    expect(数一下(db, 'SELECT COUNT(*) FROM run')).toBe(3);
  });

  it('keep 不是非负整数时拒绝执行', () => {
    // `--keep -1` 会让 slice 从末尾数起，删掉的正好是最该留的那几条
    const db = 建库();
    expect(() => 跑(db, '--keep', '-1', '--yes')).toThrow();
    expect(数一下(db, 'SELECT COUNT(*) FROM run')).toBe(3);
  });
});
