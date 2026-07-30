/**
 * 连线几何 —— 逐字复刻归档设计图「02 画布编辑器」里的 `ports` / `curve` / `bez`。
 *
 * 为什么不靠 XYFlow 的 Handle 定位：
 * Handle 的端点坐标来自它的 DOM 位置，而同一条边上要用哪个方位是随节点相对
 * 位置变的。给四个方位各注册一对 Handle 后，XYFlow 会把同 Position 的多个
 * Handle **并排**摆开（它们是同级的绝对定位兄弟），于是端口点散落在卡片外、
 * 所有边都挂到第一个 Handle 上 —— 横向排列的节点之间，线从底部绕出来再绕回去。
 *
 * 所以端点坐标必须自己算：按节点矩形取四条边的中点，两端 4×4 组合选最近的一对。
 * 这就是 Floating Edge 的做法，也正是设计图 `curve()` 在做的事。
 */

export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Port {
  x: number;
  y: number;
  /** 外法向量。控制点沿它延伸，曲线才会「先出去再拐弯」而不是一离开节点就反折。 */
  nx: number;
  ny: number;
  side: 'right' | 'left' | 'bottom' | 'top';
}

/**
 * 四条边的中点。
 *
 * 设计图里 W/H 是写死的 210×66，这里改用传入的实际尺寸 ——
 * 节点将来换了尺寸（或被内容撑开）时，硬编码的那份会让端点浮在卡片外。
 */
export function nodePorts(rect: NodeRect): Port[] {
  const { x, y, width: w, height: h } = rect;
  return [
    { x: x + w, y: y + h / 2, nx: 1, ny: 0, side: 'right' },
    { x, y: y + h / 2, nx: -1, ny: 0, side: 'left' },
    { x: x + w / 2, y: y + h, nx: 0, ny: 1, side: 'bottom' },
    { x: x + w / 2, y, nx: 0, ny: -1, side: 'top' },
  ];
}

/** 端点间距小于它就当作重合，不作为候选。 */
const COINCIDENT_EPSILON = 1;

export interface PortPair {
  p: Port;
  q: Port;
  d: number;
}

/**
 * 两端各四个端口，16 种组合里选欧氏距离最短的一对。
 *
 * 节点一被拖动，两个矩形的相对位置就变了，这个函数每帧重算 ——
 * 「拖到另一侧后连线自动换边」就是这么来的，不需要保存任何方向状态。
 */
export function bestPorts(a: NodeRect, b: NodeRect): PortPair {
  const from = nodePorts(a);
  const to = nodePorts(b);
  let best: PortPair | null = null;
  for (const p of from) {
    for (const q of to) {
      /*
       * 排除同侧组合，以及端点几乎重合的组合。
       *
       * 同侧：两矩形重叠时距离为 0 必然胜出，而右→右这种连法要贴着节点绕
       * 一圈，任何间距下都不自然。
       *
       * 坐标重合：光排同侧不够 —— 两节点**相贴**时 A.right 与 B.left 是
       * 不同 side 但同一个点（A={0,0,210,66}, B={210,0,210,66} 时都在 (210,33)），
       * 照样漏过去。路径于是成了 `M210,33 C256,33 164,33 210,33`：
       * 起终点重合，曲线先钻进右边节点再穿回左边节点。
       * 更强的重叠（A.left 与 B.bottom 重合）直接得到一条闭环。
       */
      if (p.side === q.side) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < COINCIDENT_EPSILON) continue;
      if (!best || d < best.d) best = { p, q, d };
    }
  }
  // 四个方位两两组合去掉同侧后仍有 12 组，循环必然赋值
  return best as PortPair;
}

/**
 * 三次贝塞尔。控制点沿两端端口的外法向量各延伸 k。
 *
 * `k = max(46, d * 0.42)` 取自设计图：距离近时给一个下限，否则短边的曲线
 * 会瘪成直线、看不出它从哪个方向进出。
 *
 * **额外加了 d/2 的上限**，这是对设计图的一处修正：
 * 只有下限时，弦长 40 的边算出 k=46，两个相向的控制点越过彼此
 * （c1.x=296 > c2.x=244），曲线在 t≈0.38–0.62 之间倒退约 1.485px ——
 * 路径长 42.97 vs 弦长 40 就是它的痕迹。当前节点间距下这 1.5px 看不出来，
 * 等弧长采样还会整段跳过它，但节点靠得更近时就会显出回钩。
 * 压到 d/2 后两个控制点最多在中点相遇，长边完全不受影响（d/2 ≫ d*0.42）。
 */
export function bezPath(p: Port, q: Port, d: number): string {
  const k = Math.min(Math.max(46, d * 0.42), d / 2);
  const c1x = p.x + p.nx * k;
  const c1y = p.y + p.ny * k;
  const c2x = q.x + q.nx * k;
  const c2y = q.y + q.ny * k;
  return `M${p.x},${p.y} C${c1x},${c1y} ${c2x},${c2y} ${q.x},${q.y}`;
}

/** 一步到位：两个矩形 → path。等价于设计图的 `curve(a, b)`。 */
export function curvePath(a: NodeRect, b: NodeRect): string {
  const { p, q, d } = bestPorts(a, b);
  return bezPath(p, q, d);
}

/**
 * 拖新连线时的预览路径。等价于设计图那一行：
 *
 * ```js
 * d: this.bez(from.p, { x: s.link.x, y: s.link.y, nx: -from.p.nx, ny: -from.p.ny }, from.d)
 * ```
 *
 * 终点法向量取**源端口的相反数**，不是零。写成零会让第二控制点直接落在
 * 终点上，曲线在终点处一阶导数为零 —— 鼠标绕回源端口附近时末端收成一个尖。
 */
export function previewPath(rect: NodeRect, cursor: { x: number; y: number }): string {
  const from = nearestPortTo(rect, cursor);
  const d = Math.hypot(cursor.x - from.x, cursor.y - from.y);
  const to: Port = {
    x: cursor.x,
    y: cursor.y,
    nx: -from.nx,
    ny: -from.ny,
    // 终点还没有节点，side 只为满足类型，不参与几何
    side: from.side,
  };
  return bezPath(from, to, d);
}

/**
 * 拖新连线时的源端口：在源节点四个端口里挑离鼠标最近的那个。
 *
 * 设计图拖线过程中预览线的起点是跟着鼠标方位换的 —— 鼠标移到节点右侧就从
 * right 出发，移到下方就切到 bottom。锁死一个方向的话，从下方拖出去的线
 * 会先向右甩一段再折回来。
 */
export function nearestPortTo(rect: NodeRect, point: { x: number; y: number }): Port {
  const ports = nodePorts(rect);
  let best = ports[0] as Port;
  let bestD = Infinity;
  for (const port of ports) {
    const d = Math.hypot(point.x - port.x, point.y - port.y);
    if (d < bestD) {
      bestD = d;
      best = port;
    }
  }
  return best;
}
