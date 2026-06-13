/**
 * <water-progress> — 傾けて遊べる水位型プログレス
 *
 * 進捗モデル(正直設計):
 *   value(実進捗)         … 外部から流し込む。粒の放出量を決める。
 *   landedValue(着水済み)  … 表示水位。物理遅延で value に追いつく。
 *   完了フラッシュ          … value=100 後、残粒を強制着水し必ず100%に収束。
 *
 * 使い方:
 *   <script type="module" src="variants/water/water-progress.js"></script>
 *   <water-progress id="wp" toolbar></water-progress>
 *   <script> wp.value = serverProgress; </script>
 *
 * 属性:
 *   value        実進捗 0–100
 *   height       表示高さpx (default 400)
 *   toolbar      ペン/消しゴム/傾けドラッグ/全消去/センサーのUIを表示
 *   interactive  "draw" | "tilt" | "none"  ポインタ操作 (default: toolbar有→draw / 無→tilt)
 *   demo         "smooth" | "step"  自走デモモード(本番では使わない)
 *   duration     demoモードの所要ms (default 16000)
 *   drop-gain    1粒あたりの進捗% (default 0.09)
 *   flush-delay  完了後の強制着水までの猶予ms (default 3000)
 *
 * プロパティ/メソッド:
 *   .value / .landedValue / .tilt
 *   .steps  進捗しきい値ごとのラベル [{label, until}, …]
 *   .note   進捗とは独立した任意の一行コメント("xxxをしています…")
 *   .reset()  .clearObstacles()  .enableTiltSensor()(ユーザー操作内で呼ぶこと)
 *
 * イベント:
 *   "complete"  表示水位が100%に到達したとき(1回)
 *
 * 依存: matter-js (未ロードならCDNから自動取得)
 */
import { ProgressBase } from "../../core/progress-base.js";

const MATTER_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js";

let matterPromise = null;
function loadMatter() {
  if (window.Matter) return Promise.resolve(window.Matter);
  if (!matterPromise) {
    matterPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = MATTER_CDN;
      s.onload = () => resolve(window.Matter);
      s.onerror = () => reject(new Error("matter-js の読み込みに失敗しました"));
      document.head.appendChild(s);
    });
  }
  return matterPromise;
}

const DEFAULT_STEPS = [
  { label: "接続を確立", until: 8 },
  { label: "データ取得", until: 30 },
  { label: "解析", until: 55 },
  { label: "変換", until: 75 },
  { label: "レンダリング", until: 95 },
  { label: "完了", until: 100 },
];

const C = {
  edge: "#332D63", line: "#3D3675", muted: "#8F89BC",
  accent: "#FFB454", water: "#6F8DFF", waterDeep: "#4A5BD8", good: "#7BE3A8",
  obstacle: "#A39BFF", text: "#3A3470",
};

// ---- 実機検証で到達した調整値(変更時は variants/water/README.md 参照)
const PEN_R = 6;
const ERASE_R = 18;
const N = 96;                 // 水面波の列数
const WAVE_TENSION = 0.18;
const WAVE_SPRING = 0.018;
const WAVE_DAMP = 0.985;
const GOO_BLUR = 3.5;         // 単独粒が消えない下限付近
const GOO_ALPHA = "18 -7";    // アルファ閾値 ≈ 0.39
const DROP_VIS_SCALE = 2.1;   // 描画半径倍率(閾値生存とセット)
const TERMINAL_SPEED_CAP = null; // Matter移行後は不要(参考: 自前物理時代は4)

const DROP_OPTS = {
  restitution: 0.2,
  friction: 0.001,
  frictionStatic: 0.002,
  frictionAir: 0.005,
  density: 0.001,
  label: "drop",
};
const OBSTACLE_OPTS = {
  isStatic: true,
  friction: 0.001,
  restitution: 0.05,
  label: "obstacle",
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const TEMPLATE = `
<style>
  :host { display: block; height: 400px; }
  .stage {
    position: relative; width: 100%; height: 100%;
    background: #1E1A3D; border: 1px solid ${C.edge};
    border-radius: 14px; overflow: hidden;
    font-family: 'Hiragino Sans', 'Yu Gothic UI', sans-serif;
  }
  .stage.done { border-color: rgba(123,227,168,.55); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
  #fx { pointer-events: none; filter: url(#goo); opacity: .95; }
  .toolbar {
    position: absolute; left: 8px; bottom: 8px; display: flex; gap: 6px;
    z-index: 2; flex-wrap: wrap;
  }
  button {
    font-family: inherit; font-size: 11px; cursor: pointer;
    border-radius: 7px; padding: 5px 9px; white-space: nowrap;
    background: rgba(22,19,48,.8); border: 1px solid ${C.edge}; color: ${C.muted};
    backdrop-filter: blur(4px);
  }
  button.active {
    border-color: rgba(255,180,84,.6); color: ${C.accent};
    background: rgba(255,180,84,.12);
  }
  button.sensor-on { border-color: rgba(123,227,168,.4); color: ${C.good}; }
  .hidden { display: none !important; }
</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <filter id="goo">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${GOO_BLUR}" result="blur"/>
    <feColorMatrix in="blur" type="matrix"
      values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${GOO_ALPHA}"/>
  </filter>
</defs></svg>
<div class="stage" part="stage">
  <canvas id="cv"></canvas>
  <canvas id="fx"></canvas>
  <div class="toolbar hidden" id="toolbar">
    <button data-mode="draw">✏️ ペン</button>
    <button data-mode="erase">消しゴム</button>
    <button data-mode="tilt">↔ 傾け</button>
    <button id="clear">全消去</button>
    <button id="sensor">傾きセンサー</button>
  </div>
</div>
`;

class WaterProgress extends ProgressBase {
  static get observedAttributes() {
    return ["value", "height"];
  }

  // ---- 設定
  dropGain = 0.09;
  flushDelay = 3000;
  steps = DEFAULT_STEPS;
  /** 進捗とは独立した任意の一行コメント。"xxxをしています…" 等を即時表示 */
  note = "";

  // ---- 内部状態
  #landed = 0;
  #spawned = 0;
  #releaseDoneAt = 0;
  #tilt = 0;
  #prevTilt = 0;
  #mode = "tilt";
  #demoTimer = 0;

  #Matter = null;
  #engine = null;
  #drops = [];
  #obstacles = [];
  #walls = [];
  #sh = new Float32Array(N);
  #sv = new Float32Array(N);
  #bubbles = [];

  #raf = 0;
  #last = 0;
  #dpr = 1;
  #ro = null;
  #drag = null;
  #drawPrev = null;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = TEMPLATE;
    this.$stage = this.shadowRoot.querySelector(".stage");
    this.$cv = this.shadowRoot.getElementById("cv");
    this.$fx = this.shadowRoot.getElementById("fx");
    this.$toolbar = this.shadowRoot.getElementById("toolbar");
    this.ctx = this.$cv.getContext("2d");
    this.fxCtx = this.$fx.getContext("2d");
  }

  // ================================================================ lifecycle
  async connectedCallback() {
    if (this.hasAttribute("height"))
      this.style.height = parseInt(this.getAttribute("height")) + "px";
    if (this.hasAttribute("drop-gain"))
      this.dropGain = parseFloat(this.getAttribute("drop-gain")) || this.dropGain;
    if (this.hasAttribute("flush-delay"))
      this.flushDelay = parseFloat(this.getAttribute("flush-delay")) || this.flushDelay;

    const hasToolbar = this.hasAttribute("toolbar");
    this.$toolbar.classList.toggle("hidden", !hasToolbar);
    this.#mode = this.getAttribute("interactive") || (hasToolbar ? "draw" : "tilt");
    if (this.#mode === "none") this.$cv.style.pointerEvents = "none";

    this.#wireToolbar();
    this.#wirePointer();

    this.#Matter = await loadMatter();
    if (!this.isConnected) return;

    const { Engine } = this.#Matter;
    this.#engine = Engine.create({ enableSleeping: false });
    this.#engine.positionIterations = 8;
    this.#engine.velocityIterations = 6;

    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(this);
    this.#resize();

    this.#last = performance.now();
    const tick = (now) => {
      this.#loop(now);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#raf);
    this.#ro?.disconnect();
    if (this.#engine) this.#Matter.Engine.clear(this.#engine);
  }

  attributeChangedCallback(name, old, val) {
    super.attributeChangedCallback(name, old, val);
    if (name === "height" && val != null)
      this.style.height = parseInt(val) + "px";
  }

  // ================================================================ public API
  get landedValue() {
    return this.#landed;
  }
  get displayValue() {
    return this.#landed;
  }
  get tilt() {
    return this.#tilt;
  }
  set tilt(deg) {
    this.#tilt = clamp(Number(deg) || 0, -35, 35);
  }

  /** 進捗・水・粒をすべて初期状態に戻す(障害物は残す) */
  reset() {
    this.value = 0;
    this.#landed = 0;
    this.#spawned = 0;
    this.#releaseDoneAt = 0;
    this.#demoTimer = 0;
    this.#clearDrops();
    this.#sh.fill(0);
    this.#sv.fill(0);
    this.#bubbles = [];
    this.resetCompleted();
  }

  clearObstacles() {
    if (!this.#engine) return;
    const { World } = this.#Matter;
    for (const b of this.#obstacles) World.remove(this.#engine.world, b);
    this.#obstacles = [];
  }

  /**
   * 傾きセンサーを有効化。iOSでは許可ダイアログが出るため、
   * 必ずクリック等のユーザー操作ハンドラ内から呼ぶこと。
   * @returns {Promise<"granted"|"denied"|"unsupported">}
   */
  async enableTiltSensor() {
    if (typeof DeviceOrientationEvent === "undefined") return "unsupported";
    try {
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") return "denied";
      }
      window.addEventListener("deviceorientation", (e) => {
        if (e.gamma == null) return;
        this.#tilt = clamp(e.gamma, -35, 35);
      });
      return "granted";
    } catch {
      return "denied";
    }
  }

  /** 実進捗が外から巻き戻された場合はスクラブ扱いで同期 */
  onValueChanged(v, prev) {
    // 巻き戻りは「直前の value より下がった」で判定する。
    // #spawned は dropGain 刻みで value をわずかに先行するため、
    // 「v < #spawned」で見ると なめらか進捗で誤検知しうる。
    if (v < prev - 1e-6) {
      this.#landed = Math.min(this.#landed, v);
      this.#spawned = v;
      this.#releaseDoneAt = 0;
      this.#clearDrops();
      if (v < 100) this.resetCompleted();
    }
  }

  // ================================================================ internals
  #clearDrops() {
    if (!this.#engine) return;
    const { World } = this.#Matter;
    for (const b of this.#drops) World.remove(this.#engine.world, b);
    this.#drops = [];
  }

  #vessel() {
    const r = this.$cv.getBoundingClientRect();
    const pad = 22;
    const vx = pad, vy = pad + 12;
    return {
      w: r.width, h: r.height,
      vx, vy, vw: r.width - pad * 2, vh: r.height - vy - pad,
    };
  }

  #resize() {
    // ResizeObserver は実サイズ変化時のみ発火するため、
    // iOS ツールバー問題(伸縮のたびに window.resize)を構造的に回避できる
    const r = this.$cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.$cv.width = r.width * this.#dpr;
    this.$cv.height = r.height * this.#dpr;
    this.$fx.width = r.width * this.#dpr;
    this.$fx.height = r.height * this.#dpr;
    const { vx, vy, vw, vh } = this.#vessel();
    this.#rebuildWalls(vx, vy, vw, vh);
  }

  #rebuildWalls(vx, vy, vw, vh) {
    if (!this.#engine) return;
    const { World, Bodies } = this.#Matter;
    for (const b of this.#walls) World.remove(this.#engine.world, b);
    const T = 40;
    this.#walls = [
      Bodies.rectangle(vx + 2 - T / 2, vy + vh / 2, T, vh * 2, { isStatic: true, label: "wall" }),
      Bodies.rectangle(vx + vw - 2 + T / 2, vy + vh / 2, T, vh * 2, { isStatic: true, label: "wall" }),
    ];
    World.add(this.#engine.world, this.#walls);
  }

  #addObstacleCircle(x, y) {
    const { World, Bodies } = this.#Matter;
    const b = Bodies.circle(x, y, PEN_R, OBSTACLE_OPTS);
    this.#obstacles.push(b);
    World.add(this.#engine.world, b);
  }
  #addObstacleSegment(x0, y0, x1, y1) {
    const { World, Bodies } = this.#Matter;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 2) return;
    const b = Bodies.rectangle(
      (x0 + x1) / 2, (y0 + y1) / 2, len, PEN_R * 2,
      { ...OBSTACLE_OPTS, angle: Math.atan2(y1 - y0, x1 - x0) }
    );
    this.#obstacles.push(b);
    World.add(this.#engine.world, b);
    this.#addObstacleCircle(x1, y1);
  }
  #eraseAt(x, y) {
    const { World, Query } = this.#Matter;
    const bounds = {
      min: { x: x - ERASE_R, y: y - ERASE_R },
      max: { x: x + ERASE_R, y: y + ERASE_R },
    };
    for (const b of Query.region(this.#obstacles, bounds)) {
      World.remove(this.#engine.world, b);
      this.#obstacles.splice(this.#obstacles.indexOf(b), 1);
    }
  }

  #wireToolbar() {
    const modeBtns = this.$toolbar.querySelectorAll("[data-mode]");
    const sync = () => {
      modeBtns.forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === this.#mode)
      );
    };
    modeBtns.forEach((b) =>
      b.addEventListener("click", () => {
        this.#mode = b.dataset.mode;
        sync();
      })
    );
    sync();
    this.$toolbar
      .querySelector("#clear")
      .addEventListener("click", () => this.clearObstacles());
    const sensorBtn = this.$toolbar.querySelector("#sensor");
    sensorBtn.addEventListener("click", async () => {
      const res = await this.enableTiltSensor();
      sensorBtn.textContent =
        res === "granted" ? "✓ センサー有効"
        : res === "denied" ? "センサー拒否"
        : "センサー非対応";
      sensorBtn.classList.toggle("sensor-on", res === "granted");
    });
  }

  #wirePointer() {
    const pos = (e) => {
      const r = this.$cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    this.$cv.addEventListener("pointerdown", (e) => {
      if (this.#mode === "none" || !this.#engine) return;
      this.$cv.setPointerCapture(e.pointerId);
      if (this.#mode === "tilt") {
        this.#drag = { x: e.clientX, t: this.#tilt };
      } else {
        const [x, y] = pos(e);
        if (this.#mode === "erase") this.#eraseAt(x, y);
        else this.#addObstacleCircle(x, y);
        this.#drawPrev = [x, y];
      }
    });
    this.$cv.addEventListener("pointermove", (e) => {
      if (this.#mode === "tilt") {
        if (!this.#drag) return;
        this.#tilt = clamp(this.#drag.t + (e.clientX - this.#drag.x) * 0.18, -35, 35);
      } else if (this.#drawPrev) {
        const [x, y] = pos(e);
        if (this.#mode === "erase") {
          this.#eraseAt(x, y);
          this.#drawPrev = [x, y];
        } else if (Math.hypot(x - this.#drawPrev[0], y - this.#drawPrev[1]) > 7) {
          this.#addObstacleSegment(this.#drawPrev[0], this.#drawPrev[1], x, y);
          this.#drawPrev = [x, y];
        }
      }
    });
    const end = () => {
      this.#drag = null;
      this.#drawPrev = null;
    };
    this.$cv.addEventListener("pointerup", end);
    this.$cv.addEventListener("pointercancel", end);
  }

  #splashAt(x, surfYFn, impact, vx, vw) {
    const idx = clamp(Math.round(((x - vx) / vw) * (N - 1)), 0, N - 1);
    this.#sv[idx] += impact;
    if (idx > 0) this.#sv[idx - 1] += impact * 0.45;
    if (idx < N - 1) this.#sv[idx + 1] += impact * 0.45;
    if (Math.random() < 0.6)
      this.#bubbles.push({
        x, y: surfYFn(x) + this.#sh[idx] + 6 + Math.random() * 12,
        r: 1 + Math.random() * 1.8, vy: 0.3 + Math.random() * 0.4,
      });
  }

  // ================================================================ main loop
  #loop(now) {
    if (!this.#engine) return;
    const { Engine, World, Bodies, Body } = this.#Matter;
    const dtMs = Math.min(33, now - this.#last);
    this.#last = now;
    const dt = dtMs / 16.67;

    // ---- demoモード: 自走で value を進める(本番では外部が value を設定)
    const demo = this.getAttribute("demo");
    if (demo && this.value < 100 && this.#landed < 100) {
      const dur = parseFloat(this.getAttribute("duration")) || 16000;
      if (demo === "step") {
        this.#demoTimer += dtMs;
        if (this.#demoTimer >= dur / 10) {
          this.#demoTimer = 0;
          this.value = Math.min(100, this.value + 10);
        }
      } else {
        this.value = Math.min(100, this.value + (dtMs / dur) * 100);
      }
    }

    const { w, h, vx, vy, vw, vh } = this.#vessel();
    if (vw < 10 || vh < 10) return;
    const tiltRad = (this.#tilt * Math.PI) / 180;

    const fillH = (this.#landed / 100) * (vh - 8);
    const baseY = vy + vh - fillH;
    const cx = vx + vw / 2;
    const slope = -Math.tan(tiltRad) * 0.85;
    const surfY = (x) => baseY + slope * (x - cx);

    this.#engine.world.gravity.x = Math.sin(tiltRad);
    this.#engine.world.gravity.y = Math.cos(tiltRad);

    // ---- 放出: spawned が value(実進捗)に追いつくまで粒を出す
    let burst = 0;
    while (this.#spawned < this.value && burst < 3 && this.#drops.length < 700) {
      this.#spawned += this.dropGain;
      burst++;
      const b = Bodies.circle(
        cx + (Math.random() - 0.5) * 14,
        vy - 8 - Math.random() * 6,
        1.8 + Math.random() * 1.2,
        DROP_OPTS
      );
      Body.setVelocity(b, { x: (Math.random() - 0.5) * 1, y: 2 + Math.random() });
      this.#drops.push(b);
      World.add(this.#engine.world, b);
    }

    Engine.update(this.#engine, dtMs);

    // ---- 着水・場外
    this.#drops = this.#drops.filter((b) => {
      const p = b.position;
      const idx = clamp(Math.round(((p.x - vx) / vw) * (N - 1)), 0, N - 1);
      const sy = surfY(p.x) + this.#sh[idx];
      if (fillH > 2 && p.y + b.circleRadius * 0.4 >= sy) {
        this.#landed = Math.min(100, this.#landed + this.dropGain);
        const impact = clamp(Math.hypot(b.velocity.x, b.velocity.y) * 0.5, 0.8, 3.5);
        this.#splashAt(p.x, surfY, impact, vx, vw);
        World.remove(this.#engine.world, b);
        return false;
      }
      if (p.y > vy + vh + 10) {
        this.#landed = Math.min(100, this.#landed + this.dropGain);
        World.remove(this.#engine.world, b);
        return false;
      }
      if (p.y < vy - 60) {
        World.remove(this.#engine.world, b);
        return false;
      }
      return true;
    });

    // ---- 完了フラッシュ: 取りこぼし防止
    if (this.value >= 100 && this.#spawned >= 100 - 1e-9) {
      if (!this.#releaseDoneAt) this.#releaseDoneAt = now;
      if (now - this.#releaseDoneAt > this.flushDelay && this.#drops.length > 0) {
        for (const b of this.#drops) {
          if (fillH > 2) this.#splashAt(b.position.x, surfY, 1.2, vx, vw);
          World.remove(this.#engine.world, b);
        }
        this.#drops = [];
        this.#landed = 100;
      }
      if (this.#drops.length === 0 && this.#landed > 99.5) this.#landed = 100;
    } else {
      this.#releaseDoneAt = 0;
    }
    if (this.#landed >= 100) this.emitComplete();

    // ---- 水面の波
    const dT = this.#tilt - this.#prevTilt;
    this.#prevTilt = this.#tilt;
    if (Math.abs(dT) > 0.05 && fillH > 4) {
      for (let i = 0; i < N; i++)
        this.#sv[i] += dT * (i / (N - 1) - 0.5) * 0.9;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < N; i++) {
        const l = i > 0 ? this.#sh[i - 1] : this.#sh[i];
        const r2 = i < N - 1 ? this.#sh[i + 1] : this.#sh[i];
        this.#sv[i] += ((l + r2) / 2 - this.#sh[i]) * WAVE_TENSION * dt;
        this.#sv[i] += -this.#sh[i] * WAVE_SPRING * dt;
      }
    }
    for (let i = 0; i < N; i++) {
      this.#sv[i] *= Math.pow(WAVE_DAMP, dt);
      this.#sh[i] += this.#sv[i] * dt;
    }

    // ---- 泡
    const gxv = this.#engine.world.gravity.x;
    const gyv = this.#engine.world.gravity.y;
    this.#bubbles = this.#bubbles.filter((b) => {
      b.x -= gxv * b.vy * dt * 1.2;
      b.y -= gyv * b.vy * dt * 1.2;
      const idx = clamp(Math.round(((b.x - vx) / vw) * (N - 1)), 0, N - 1);
      return b.y > surfY(b.x) + this.#sh[idx] + 2;
    });

    this.#render(w, h, vx, vy, vw, vh, cx, baseY, fillH, surfY);
    this.$stage.classList.toggle("done", this.#landed >= 100);
  }

  // ================================================================ render
  #render(w, h, vx, vy, vw, vh, cx, baseY, fillH, surfY) {
    const ctx = this.ctx;
    const fx = this.fxCtx;
    const dpr = this.#dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const rr = 18;
    ctx.beginPath();
    ctx.roundRect(vx, vy, vw, vh, [4, 4, rr, rr]);
    ctx.strokeStyle = C.edge;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 目盛り
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = C.line;
    ctx.textAlign = "left";
    for (const m of [25, 50, 75]) {
      const my = vy + vh - (m / 100) * (vh - 8);
      ctx.fillRect(vx + 2, my, 10, 1);
      ctx.fillText(String(m), vx + 16, my + 3);
    }

    // % 数字(実進捗)
    ctx.font = "600 64px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.#landed >= 100 ? C.good : C.text;
    ctx.fillText(Math.floor(this.value) + "%", cx, vy + vh / 2);
    ctx.textBaseline = "alphabetic";

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(vx + 1, vy + 1, vw - 2, vh - 2, [3, 3, rr - 1, rr - 1]);
    ctx.clip();

    // 障害物
    ctx.fillStyle = C.obstacle;
    for (const b of this.#obstacles) {
      if (b.circleRadius) {
        ctx.beginPath();
        ctx.arc(b.position.x, b.position.y, b.circleRadius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        const vts = b.vertices;
        ctx.moveTo(vts[0].x, vts[0].y);
        for (let i = 1; i < vts.length; i++) ctx.lineTo(vts[i].x, vts[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 水(グラデーション・ハイライト・泡)
    if (fillH > 0.5) {
      ctx.beginPath();
      ctx.moveTo(vx, vy + vh + 2);
      for (let i = 0; i < N; i++) {
        const x = vx + (i / (N - 1)) * vw;
        ctx.lineTo(x, surfY(x) + this.#sh[i]);
      }
      ctx.lineTo(vx + vw, vy + vh + 2);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, baseY, 0, vy + vh);
      grad.addColorStop(0, C.water + "B8");
      grad.addColorStop(1, C.waterDeep + "D8");
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const x = vx + (i / (N - 1)) * vw;
        const y = surfY(x) + this.#sh[i];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#B9C8FF";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = "rgba(201,212,255,.4)";
      for (const b of this.#bubbles) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // 注ぎ口
    ctx.fillStyle = C.edge;
    ctx.fillRect(cx - 9, vy - 16, 18, 10);

    // ステップラベル / 傾き表示
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = C.muted;
    ctx.textAlign = "right";
    ctx.fillText(
      "TILT " + (this.#tilt >= 0 ? "+" : "") + this.#tilt.toFixed(1) + "°",
      w - 12, 18
    );
    const step =
      this.steps.find((s) => this.value <= s.until) ||
      this.steps[this.steps.length - 1];
    if (step) {
      ctx.textAlign = "left";
      ctx.fillStyle = this.#landed >= 100 ? C.good : C.accent;
      ctx.fillText(step.label, 12, 18);
    }
    // 任意コメント(進捗とは独立。設定時のみステップラベルの下に表示)
    if (this.note) {
      ctx.textAlign = "left";
      ctx.fillStyle = C.muted;
      ctx.fillText(this.note, 12, 34);
    }
    ctx.restore();

    // ---- 液体レンダリング(gooレイヤー)
    fx.save();
    fx.scale(dpr, dpr);
    fx.clearRect(0, 0, w, h);
    fx.beginPath();
    fx.rect(vx + 1, vy - 22, vw - 2, vh + 20);
    fx.clip();
    fx.fillStyle = C.water;
    for (const b of this.#drops) {
      fx.beginPath();
      fx.arc(b.position.x, b.position.y, b.circleRadius * DROP_VIS_SCALE, 0, Math.PI * 2);
      fx.fill();
    }
    if (fillH > 0.5) {
      fx.beginPath();
      for (let i = 0; i < N; i++) {
        const x = vx + (i / (N - 1)) * vw;
        const y = surfY(x) + this.#sh[i];
        if (i === 0) fx.moveTo(x, y);
        else fx.lineTo(x, y);
      }
      for (let i = N - 1; i >= 0; i--) {
        const x = vx + (i / (N - 1)) * vw;
        fx.lineTo(x, surfY(x) + this.#sh[i] + 16);
      }
      fx.closePath();
      fx.fill();
    }
    fx.restore();
  }
}

customElements.define("water-progress", WaterProgress);
export { WaterProgress };
