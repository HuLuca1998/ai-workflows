// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  bestPorts,
  bezPath,
  curvePath,
  nearestPortTo,
  nodePorts,
  previewPath,
} from '../src/editor/edgeGeometry.js';

/**
 * 连线几何 —— 对着归档设计图「02 画布编辑器」的实现逐条验：
 *
 * ```js
 * ports(n) {
 *   const W = 210, H = 66;
 *   return [
 *     { x: n.x + W,   y: n.y + H/2, nx: 1,  ny: 0  },
 *     { x: n.x,       y: n.y + H/2, nx: -1, ny: 0  },
 *     { x: n.x + W/2, y: n.y + H,   nx: 0,  ny: 1  },
 *     { x: n.x + W/2, y: n.y,       nx: 0,  ny: -1 },
 *   ];
 * }
 * curve(a, b) {  // 4×4 组合取 Math.hypot 最小的一对
 * bez(p, q, d) { const k = Math.max(46, d * 0.42); ... }
 * ```
 *
 * 实现此前把边绑在 XYFlow 的 Handle 上，而同 Position 的多个 Handle 会被
 * 并排摆开 —— 端口点散落到卡片外，横向排列的节点之间线从底部绕出去再绕回来。
 */

const rect = (x: number, y: number, width = 210, height = 66) => ({ x, y, width, height });

describe('端口坐标（设计图的 ports）', () => {
  it('四条边的中点，各带外法向量', () => {
    const ports = nodePorts(rect(100, 200));
    expect(ports).toEqual([
      { x: 310, y: 233, nx: 1, ny: 0, side: 'right' },
      { x: 100, y: 233, nx: -1, ny: 0, side: 'left' },
      { x: 205, y: 266, nx: 0, ny: 1, side: 'bottom' },
      { x: 205, y: 200, nx: 0, ny: -1, side: 'top' },
    ]);
  });

  it('用实际测量尺寸，不硬编码 210×66', () => {
    const ports = nodePorts(rect(0, 0, 300, 100));
    expect(ports[0]).toMatchObject({ x: 300, y: 50, side: 'right' });
    expect(ports[2]).toMatchObject({ x: 150, y: 100, side: 'bottom' });
  });
});

describe('最近端口对（设计图的 curve）', () => {
  it('目标在正右方 → right → left', () => {
    const { p, q } = bestPorts(rect(0, 0), rect(400, 0));
    expect(p.side).toBe('right');
    expect(q.side).toBe('left');
  });

  it('目标在正下方 → bottom → top，不绕到右边', () => {
    const { p, q } = bestPorts(rect(0, 0), rect(0, 300));
    expect(p.side).toBe('bottom');
    expect(q.side).toBe('top');
  });

  it('目标在正左方 → left → right', () => {
    const { p, q } = bestPorts(rect(400, 0), rect(0, 0));
    expect(p.side).toBe('left');
    expect(q.side).toBe('right');
  });

  it('目标在正上方 → top → bottom', () => {
    const { p, q } = bestPorts(rect(0, 300), rect(0, 0));
    expect(p.side).toBe('top');
    expect(q.side).toBe('bottom');
  });

  it('把目标从右侧拖到左侧，端口组合实时翻转', () => {
    const right = bestPorts(rect(0, 0), rect(500, 0));
    expect([right.p.side, right.q.side]).toEqual(['right', 'left']);

    // 同一个源节点，目标挪到左边
    const left = bestPorts(rect(0, 0), rect(-500, 0));
    expect([left.p.side, left.q.side]).toEqual(['left', 'right']);
  });

  it('斜向时按真实距离选，不按象限硬分', () => {
    // 偏右很多 → 水平那对最近
    expect(bestPorts(rect(0, 0), rect(600, 80)).p.side).toBe('right');
    // 偏下很多 → 竖直那对最近
    expect(bestPorts(rect(0, 0), rect(40, 400)).p.side).toBe('bottom');
  });

  it('距离用欧氏距离', () => {
    // 正右方相邻：right(210,33) → left(400,33)，距离 190
    expect(bestPorts(rect(0, 0), rect(400, 0)).d).toBeCloseTo(190, 5);
  });
});

describe('贝塞尔路径（设计图的 bez）', () => {
  it('控制点沿两端法向量延伸，k = max(46, d*0.42)', () => {
    const p = { x: 0, y: 0, nx: 1, ny: 0, side: 'right' as const };
    const q = { x: 500, y: 0, nx: -1, ny: 0, side: 'left' as const };
    const d = 500;
    const k = Math.max(46, d * 0.42); // 210
    expect(bezPath(p, q, d)).toBe(`M0,0 C${k},0 ${500 - k},0 500,0`);
  });

  it('k 被夹在 [46, d/2] 之间 —— 下限保住进出方向，上限防控制点交叉', () => {
    const p = { x: 0, y: 0, nx: 1, ny: 0, side: 'right' as const };
    const q = (x: number) => ({ x, y: 0, nx: -1, ny: 0, side: 'left' as const });

    // d=100：0.42×100=42 < 46，下限生效；d/2=50 不构成约束
    expect(bezPath(p, q(100), 100)).toBe('M0,0 C46,0 54,0 100,0');

    // d=20：下限 46 会让两个控制点越过彼此（c1=46 > c2=-26），
    // 上限 d/2=10 把它们压到中点相遇
    expect(bezPath(p, q(20), 20)).toBe('M0,0 C10,0 10,0 20,0');
  });

  it('从右端口出发时曲线先向右 —— 不会一离开节点就反折', () => {
    const path = curvePath(rect(0, 0), rect(500, 200));
    const [, c1x] = /C([-\d.]+),/u.exec(path) ?? [];
    const [, startX] = /^M([-\d.]+),/u.exec(path) ?? [];
    expect(Number(c1x)).toBeGreaterThan(Number(startX));
  });

  it('路径起终点就是选中的两个端口 —— 端点必须落在节点边界上', () => {
    const a = rect(0, 0);
    const b = rect(400, 0);
    const { p, q } = bestPorts(a, b);
    const path = curvePath(a, b);
    expect(path.startsWith(`M${p.x},${p.y} `)).toBe(true);
    expect(path.endsWith(` ${q.x},${q.y}`)).toBe(true);
  });
});

describe('拖线预览的源端口（跟着鼠标方位换）', () => {
  it('鼠标在节点右侧 → 从 right 出发', () => {
    expect(nearestPortTo(rect(0, 0), { x: 400, y: 33 }).side).toBe('right');
  });

  it('鼠标移到节点下方 → 切到 bottom', () => {
    expect(nearestPortTo(rect(0, 0), { x: 105, y: 400 }).side).toBe('bottom');
  });

  it('鼠标在左上 → 按距离选，不锁死一个方向', () => {
    expect(['left', 'top']).toContain(nearestPortTo(rect(0, 0), { x: -200, y: -20 }).side);
  });
});

describe('拖线预览路径（设计图的 live path）', () => {
  /*
   * 设计图原文：
   *   d: this.bez(from.p, { x: s.link.x, y: s.link.y, nx: -from.p.nx, ny: -from.p.ny }, from.d)
   * 终点法向量是**源端口法向量的相反数**，不是零 —— 写成零会让第二控制点
   * 直接落在终点上，曲线在终点的一阶导数为零，鼠标绕回源端口附近时末端收尖。
   */
  it('终点法向量是源端口法向量的相反数', () => {
    // 源节点在原点，鼠标在正右方 → 源端口 right(nx=1)，终点法向量应为 nx=-1
    const path = previewPath(rect(0, 0), { x: 600, y: 33 });
    const [, c2x] = /C[-\d.]+,[-\d.]+ ([-\d.]+),/u.exec(path) ?? [];
    const [, endX] = / ([-\d.]+),[-\d.]+$/u.exec(path) ?? [];
    // 第二控制点应在终点**左侧**（沿 -nx 方向回退 k）
    expect(Number(c2x)).toBeLessThan(Number(endX));
  });

  it('鼠标在下方时源端口切到 bottom，终点法向量随之翻转', () => {
    const path = previewPath(rect(0, 0), { x: 105, y: 600 });
    // 起点应是 bottom 端口 (105, 66)
    expect(path.startsWith('M105,66')).toBe(true);
    const [, c2y] = /C[-\d.]+,[-\d.]+ [-\d.]+,([-\d.]+)/u.exec(path) ?? [];
    const [, endY] = /,([-\d.]+)$/u.exec(path) ?? [];
    // 源端口 ny=1，终点法向量 ny=-1 → 第二控制点在终点上方
    expect(Number(c2y)).toBeLessThan(Number(endY));
  });

  it('四个方位都能作为预览起点', () => {
    const sides = [
      [{ x: 600, y: 33 }, 'M210,33'],
      [{ x: -600, y: 33 }, 'M0,33'],
      [{ x: 105, y: 600 }, 'M105,66'],
      [{ x: 105, y: -600 }, 'M105,0'],
    ] as const;
    for (const [cursor, expectedStart] of sides) {
      expect(previewPath(rect(0, 0), cursor).startsWith(expectedStart)).toBe(true);
    }
  });
});

describe('退化情形：两个矩形重叠', () => {
  /*
   * 完全重叠时，16 组合里 d 最小的是**同侧**端口对（d=0）——
   * 路径退化成 `M210,33 C256,33 256,33 210,33`：起点终点重合，
   * 沿同一条直线出去再折返，末端切向指回起点，箭头方向是反的。
   *
   * 同侧端口连线在任何情况下都不自然（线要贴着节点绕一圈），
   * 所以直接把同侧组合排除掉。
   */
  it('完全重叠时不选同侧端口，起终点不重合', () => {
    const { p, q, d } = bestPorts(rect(0, 0), rect(0, 0));
    expect(p.side).not.toBe(q.side);
    expect(d).toBeGreaterThan(0);
    expect([p.x, p.y]).not.toEqual([q.x, q.y]);
  });

  it('重叠时箭头仍朝节点内部 —— 末端切向与目标端口外法向量反向', () => {
    const { q } = bestPorts(rect(0, 0), rect(0, 0));
    const path = curvePath(rect(0, 0), rect(0, 0));
    const m = /C[-\d.]+,[-\d.]+ ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)$/u.exec(path);
    expect(m).not.toBeNull();
    const [c2x, c2y, endX, endY] = m!.slice(1).map(Number) as [number, number, number, number];

    // 末端切向 = 终点 - 第二控制点。端口法向量朝节点外，
    // 箭头必须朝内，两者点积应为负。
    const tangent = { x: endX - c2x, y: endY - c2y };
    const dot = tangent.x * q.nx + tangent.y * q.ny;
    expect(dot).toBeLessThan(0);
  });

  it('部分重叠时同样不退化', () => {
    const { p, q, d } = bestPorts(rect(0, 0), rect(30, 20));
    expect(p.side).not.toBe(q.side);
    expect(d).toBeGreaterThan(0);
  });

  it('正常间距下的选择不受影响', () => {
    expect(bestPorts(rect(0, 0), rect(400, 0)).p.side).toBe('right');
    expect(bestPorts(rect(0, 0), rect(0, 300)).p.side).toBe('bottom');
    expect(bestPorts(rect(400, 0), rect(0, 0)).p.side).toBe('left');
  });
});

describe('退化情形：端口坐标重合（相贴/重叠）', () => {
  /*
   * 「排除同侧」不够。两节点相贴时 A.right 与 B.left 是**不同 side 但同一坐标**：
   *
   *   A = {0,0,210,66}, B = {210,0,210,66}
   *   A.right = (210,33)，B.left = (210,33)，d = 0
   *   路径 M210,33 C256,33 164,33 210,33 —— 起终点重合，
   *   曲线先钻进右边节点、再穿回左边节点。
   *
   * 更强的重叠（A.left 与 B.bottom 重合）会得到真实闭环：
   *   M0,33 C-46,33 0,79 0,33
   */
  it('两节点相贴时不选重合的端口对', () => {
    const { p, q, d } = bestPorts(rect(0, 0), rect(210, 0));
    expect([p.x, p.y]).not.toEqual([q.x, q.y]);
    expect(d).toBeGreaterThan(0);
  });

  it('端口坐标重合的重叠布局同样不退化', () => {
    // A.left(0,33) 与 B.bottom(0,33) 重合
    const { p, q, d } = bestPorts(rect(0, 0), rect(-105, -33));
    expect([p.x, p.y]).not.toEqual([q.x, q.y]);
    expect(d).toBeGreaterThan(0);
  });

  it('路径不形成闭环 —— 起终点必须不同', () => {
    for (const b of [rect(210, 0), rect(-105, -33), rect(0, 0)]) {
      const path = curvePath(rect(0, 0), b);
      const [, sx, sy] = /^M([-\d.]+),([-\d.]+)/u.exec(path)!.map(Number) as [
        number,
        number,
        number,
      ];
      const [, ex, ey] = / ([-\d.]+),([-\d.]+)$/u.exec(path)!.map(Number) as [
        number,
        number,
        number,
      ];
      expect([sx, sy], `布局 ${JSON.stringify(b)} 起终点重合`).not.toEqual([ex, ey]);
    }
  });
});

describe('控制点不得交叉（短边反向段）', () => {
  /*
   * 设计图的 k = max(46, d*0.42) 在短边上会让两个控制点越过彼此：
   * 弦长 40 时 c1.x=296 > c2.x=244，曲线在 t≈0.38~0.62 之间倒退约 1.485px。
   * 当前节点间距下这 1.5px 看不出来，但它是真实存在的 —— 等弧长采样会跳过它。
   *
   * 修法：k 再加一道 d/2 的上限。相向的两个控制点因此最多在中点相遇，
   * 不会互相越过；长边完全不受影响（d/2 远大于 d*0.42）。
   */
  it('短边的 x 严格单调 —— 用解析极值判，不靠采样', () => {
    const path = curvePath(rect(0, 0), rect(250, 0));
    const m = /^M([-\d.]+),[-\d.]+ C([-\d.]+),[-\d.]+ ([-\d.]+),[-\d.]+ ([-\d.]+),/u.exec(path)!;
    const [x0, x1, x2, x3] = m.slice(1).map(Number) as [number, number, number, number];
    // 三次贝塞尔 x(t) 单调 ⟺ 控制点在两端之间且不互相越过
    expect(x1).toBeGreaterThanOrEqual(x0);
    expect(x2).toBeGreaterThanOrEqual(x1);
    expect(x3).toBeGreaterThanOrEqual(x2);
  });

  it('长边的控制点长度不受上限影响', () => {
    const p = { x: 0, y: 0, nx: 1, ny: 0, side: 'right' as const };
    const q = { x: 500, y: 0, nx: -1, ny: 0, side: 'left' as const };
    // d=500 时 k = 210（0.42×500），d/2=250 不构成约束
    expect(bezPath(p, q, 500)).toBe('M0,0 C210,0 290,0 500,0');
  });
});

describe('距离度量必须是欧氏，不能是曼哈顿', () => {
  it('用能区分两种度量的布局断言', () => {
    // codex 给的判别输入：
    //   欧氏 right→top: Δ=(145,292), d≈326.02
    //   曼哈顿 right→left: Δ=(40,325), d=365（曼哈顿下 right→left 更小）
    const { p, q, d } = bestPorts(rect(0, 0), rect(250, 325));
    expect([p.side, q.side]).toEqual(['right', 'top']);
    expect(d).toBeCloseTo(Math.hypot(145, 292), 4);
  });
});
