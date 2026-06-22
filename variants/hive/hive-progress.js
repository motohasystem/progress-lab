/**
 * <hive-progress> — ミツバチが蜜を集めて巣に持ち帰る進捗表現
 *
 * 進捗モデル(正直設計):
 *   value(実進捗)    … 外部から流し込む唯一の入力。
 *   collected(表示)   … 巣に貯まった蜜の量(=displayValue)。
 *
 * 仕組み:
 *   中央に吊られたハチの巣(ハニカム)がある。実進捗が「まだ巣に届いていない分」を
 *   持つと、ミツバチが巣から飛び立って花や画面の外へ採蜜に向かう。しばらく蜜を集めて
 *   から巣へ戻り、巣に入った瞬間に運んできた分だけ蜜(表示%)が進む。
 *
 *   各ミツバチは payload(運ぶ蜜量)を持つ。飛行中の全ミツバチの payload と貯蔵済みの
 *   合計(committed)は決して value を超えない。よって表示は実進捗に「遅れる」が
 *   「嘘をつかない」。value が100に達するとミツバチが残りを運び切り、巣が満ちて完了。
 *
 * 遊び(進捗には一切影響しない):
 *   草むらをクリック/タップすると花が咲く。ミツバチは近くの花を優先して訪れ、
 *   花粉をまき散らす。巣のまわりには見張りのミツバチが常に舞っている。
 *
 * 使い方:
 *   <script type="module" src="variants/hive/hive-progress.js"></script>
 *   <hive-progress id="hv"></hive-progress>
 *   <script> hv.value = serverProgress; </script>
 *
 * 属性:
 *   value         実進捗 0–100
 *   height        表示高さpx (default 460)
 *   demo          "smooth" | "step"  自走デモ(本番では使わない)
 *   duration      demoモードの所要ms (default 16000)
 *
 * プロパティ/メソッド:
 *   .value / .displayValue(=巣に貯まった蜜%) / .trips(採蜜往復した回数・読み取り専用)
 *   .steps  進捗しきい値ごとのラベル [{label, until}, …]
 *   .note   進捗とは独立した任意の一行コメント
 *   .reset()
 *
 * イベント:
 *   "complete"     巣が満ちた(表示が100%)とき(1回)
 *   "deposit"      ミツバチが巣に蜜を持ち帰ったとき(detail: { amount, collected })
 *
 * 依存: なし(canvasのみ)
 */
import { ProgressBase } from "../../core/progress-base.js";

const C = {
  edge: "#332D63", muted: "#8F89BC", accent: "#FFB454", good: "#7BE3A8",
  bee: "#F7C948", beeDark: "#2E2410", wing: "rgba(214,232,255,.72)",
  comb: "#5B4A2A", combLine: "#3C3018", wax: "#6E5A30",
  honey: "#FFC23C", honeyHi: "#FFE08A", honeyDark: "#E8920E",
  branch: "#6A5680", branchDark: "#4A3A60",
  grass: "#4E9A54", grassDark: "#356B3A",
  pollen: "#FFE08A",
};

const DEFAULT_STEPS = [
  { label: "巣づくり", until: 10 },
  { label: "蜜源さがし", until: 30 },
  { label: "採蜜中", until: 60 },
  { label: "巣へ持ち帰り", until: 85 },
  { label: "熟成中", until: 98 },
  { label: "満蜜", until: 100 },
];

const FLOWER_COLORS = ["#FF8FB1", "#9D7BFF", "#FF9B5A", "#7BE3A8", "#FFD54A"];

// ---- 採蜜の調整値
const MAX_BEES = 7;          // 同時に飛び回れる働きバチ数
const AMBIENT = 2;           // 巣のまわりを常に舞う見張りバチ
const CHUNK = 6.5;           // 1往復が運ぶ蜜量(% / 100/CHUNK ≒ 15往復で満タン)
const SPAWN_COOLDOWN = 230;  // 次のハチを送り出すまでの最短ms
const GATHER_MS = [600, 1200]; // 採蜜地点でホバリングする時間
const MAX_SPEED = 2.7;       // 飛行最高速(px/frame)
const STEER = 0.09;          // 目標へ向き直る強さ
const SLOW_R = 64;           // 到着減速を始める距離
const HONEY_EASE = 0.16;     // 蜜面が貯蔵値へ追いつく速さ
const STEP_THRESHOLD = 4;    // 1フレームでこの量以上増えたら「ステップ」とみなし、往復を待たず即反映

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const rand = (a, b) => a + Math.random() * (b - a);

const TEMPLATE = `
<style>
  :host { display: block; height: 460px; }
  .stage {
    position: relative; width: 100%; height: 100%;
    background: linear-gradient(180deg, #211B45 0%, #181430 70%, #15122B 100%);
    border: 1px solid ${C.edge}; border-radius: 14px; overflow: hidden;
    font-family: 'Hiragino Sans', 'Yu Gothic UI', sans-serif;
  }
  .stage.done { border-color: rgba(255,194,60,.6); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: manipulation; cursor: crosshair; }
</style>
<div class="stage" part="stage">
  <canvas id="cv"></canvas>
</div>
`;

class HiveProgress extends ProgressBase {
  static get observedAttributes() {
    return ["value", "height"];
  }

  // ---- 設定
  steps = DEFAULT_STEPS;
  note = "";

  // ---- 進捗の表示状態
  #collected = 0;     // 巣に貯まった蜜(=displayValue)。ミツバチが持ち帰ると増える
  #honeyShown = 0;    // 蜜面の描画値(collected へ滑らかに追従)
  #lastSeenValue = 0; // 前フレームの value(ステップ増加の検出用)
  #demoTimer = 0;

  // ---- 採蜜
  #bees = [];         // 働きバチ { x,y,vx,vy, state, target, payload, gatherT, gatherDur, flap, hue }
  #ambient = [];      // 見張りバチ { ang, rad, sp, flap }
  #flowers = [];      // { x, y, color, sway, bloom, claimed, wilting }
  #pollen = [];       // 花粉/きらめき { x, y, vx, vy, life, r, color }
  #drips = [];        // 巣に注がれる蜜のしずく { x, y, vy, life }
  #floats = [];       // "+100" の得点表示 { x, y, life, points }
  #flash = 0;         // 蜜面が光る残量(持ち帰った瞬間)
  #spawnTimer = 0;
  #trips = 0;         // 完了した採蜜往復の数
  #score = 0;         // 画面内の花から採蜜した得点
  #scorePulse = 0;    // 加点した瞬間に弾むスコア表示の脈動

  #cells = [];        // ハニカムのセル(正規化座標 {x,y})
  #clock = 0;

  #raf = 0;
  #last = 0;
  #dpr = 1;
  #ro = null;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = TEMPLATE;
    this.$stage = this.shadowRoot.querySelector(".stage");
    this.$cv = this.shadowRoot.getElementById("cv");
    this.ctx = this.$cv.getContext("2d");
    this.#buildComb();
    this.#initAmbient();
  }

  // ================================================================ lifecycle
  connectedCallback() {
    if (this.hasAttribute("height"))
      this.style.height = parseInt(this.getAttribute("height")) + "px";

    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(this);
    this.#resize();
    this.#seedFlowers();
    this.#wirePointer();

    this.#lastSeenValue = this.value;   // 初期値はステップ扱いしない
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
  }

  attributeChangedCallback(name, old, val) {
    super.attributeChangedCallback(name, old, val);
    if (name === "height" && val != null)
      this.style.height = parseInt(val) + "px";
  }

  // ================================================================ public API
  get displayValue() {
    return this.#collected;
  }

  get trips() {
    return this.#trips;
  }

  get score() {
    return this.#score;
  }

  /** 進捗・ミツバチ・蜜をすべて初期状態に戻す */
  reset() {
    this.value = 0;
    this.#collected = 0;
    this.#honeyShown = 0;
    this.#lastSeenValue = 0;
    this.#demoTimer = 0;
    this.#bees = [];
    this.#pollen = [];
    this.#drips = [];
    this.#floats = [];
    this.#flash = 0;
    this.#spawnTimer = 0;
    this.#trips = 0;
    this.#score = 0;
    this.#scorePulse = 0;
    this.#seedFlowers();
    this.resetCompleted();
  }

  // ================================================================ internals
  /** ハニカムのセルを正規化座標(単位円内の六角格子)で一度だけ生成。
   *  列を 0 中心に左右対称に並べるので、巣は左右対称の円形になる。 */
  #buildComb() {
    const cells = [];
    const hr = 0.2;                 // 正規化したセル間隔
    const dx = 1.5 * hr;
    const dy = Math.sqrt(3) * hr;
    const maxCol = Math.ceil(1 / dx);
    for (let ci = -maxCol; ci <= maxCol; ci++) {
      const x = ci * dx;
      const yo = (Math.abs(ci) % 2) * dy * 0.5;   // 列ごとに半段ずらす(±同士は同じ)
      for (let y = -1; y <= 1.0001; y += dy) {
        const yy = y + yo;
        if (x * x + yy * yy <= 0.92) cells.push({ x, y: yy });
      }
    }
    this.#cells = cells;
  }

  #initAmbient() {
    this.#ambient = Array.from({ length: AMBIENT }, (_, i) => ({
      ang: (i / AMBIENT) * Math.PI * 2,
      rad: 1.25 + i * 0.18,
      sp: (i % 2 ? -1 : 1) * (0.012 + Math.random() * 0.006),
      flap: Math.random() * Math.PI * 2,
    }));
  }

  #resize() {
    const r = this.$cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.$cv.width = r.width * this.#dpr;
    this.$cv.height = r.height * this.#dpr;
  }

  #geom() {
    const r = this.$cv.getBoundingClientRect();
    const w = r.width, h = r.height;
    const groundY = h - Math.min(46, h * 0.12);
    const cx = w * 0.5;
    const cy = h * 0.33;
    const R = Math.min(w * 0.2, h * 0.21, 92);
    const entrance = { x: cx, y: cy + R * 0.96 };
    return { w, h, groundY, cx, cy, R, entrance };
  }

  #seedFlowers() {
    const g = this.#geom();
    if (g.w < 10) { this.#flowers = []; return; }
    this.#flowers = Array.from({ length: 3 }, () => this.#makeFlower(g));
  }

  #makeFlower(g, x) {
    return {
      x: x ?? rand(24, g.w - 24),
      y: rand(g.groundY + 4, g.h - 10),
      color: FLOWER_COLORS[(Math.random() * FLOWER_COLORS.length) | 0],
      sway: Math.random() * Math.PI * 2,
      bloom: x == null ? 1 : 0,    // 種まきした花は咲くアニメ
      claimed: false,              // 採蜜に向かうハチが予約済みか
      wilting: false,              // 採蜜され萎んでいる最中か
    };
  }

  #wirePointer() {
    // 草むらをクリック/タップすると花が咲く(進捗には影響しない演出)
    const plant = (e) => {
      const r = this.$cv.getBoundingClientRect();
      const g = this.#geom();
      const x = clamp(e.clientX - r.left, 12, g.w - 12);
      const y = e.clientY - r.top;
      if (y < g.groundY - 10) return;            // 草むらの中だけ
      const f = this.#makeFlower(g, x);
      f.y = clamp(y, g.groundY + 4, g.h - 8);
      this.#flowers.push(f);
      if (this.#flowers.length > 60) this.#flowers.shift();
      this.#burstPollen(f.x, f.y - 8, 8, f.color);
    };
    this.$cv.addEventListener("pointerdown", plant);
  }

  /** 飛行中の全ミツバチ payload + 貯蔵済み = 巣へ約束済みの蜜。value を超えない */
  #committed() {
    let c = this.#collected;
    for (const b of this.#bees) if (!b.deposited) c += b.payload;
    return c;
  }

  /** 巣から働きバチを1匹送り出す。採蜜先(花 or 画面外)を決める。
   *  cosmetic=true は蜜を運ばない演出専用バチ(ステップ即反映時のにぎやかし)。 */
  #launchBee(g, payload, cosmetic = false) {
    const target = this.#pickForage(g);
    this.#bees.push({
      x: g.entrance.x + rand(-6, 6),
      y: g.entrance.y + rand(-2, 4),
      vx: rand(-0.6, 0.6),
      vy: -rand(0.8, 1.6),
      state: "out",
      target,
      payload,
      cosmetic,
      deposited: false,
      gatherT: 0,
      gatherDur: rand(GATHER_MS[0], GATHER_MS[1]),
      flap: Math.random() * Math.PI * 2,
      wobble: Math.random() * Math.PI * 2,
    });
  }

  /** ステップ増加を巣へ即反映:蜜面を value まで一気に引き上げる(往復を待たない)。
   *  飛行中のミツバチの payload は 0 にして二重計上を防ぎ、にぎやかしに数匹を送り出す。 */
  #stepFill(g) {
    for (const b of this.#bees) b.payload = 0;     // 運搬中の蜜は無効化(即反映に統合)
    const before = this.#collected;
    this.#collected = Math.min(100, this.value);
    const added = this.#collected - before;
    if (added <= 0) return;
    this.#trips++;
    this.#flash = 1;
    for (let i = 0; i < 7; i++) {
      this.#drips.push({
        x: g.entrance.x + rand(-9, 9),
        y: g.entrance.y - rand(0, 6),
        vy: rand(0.4, 1.6), life: 1,
      });
    }
    this.#burstPollen(g.entrance.x, g.entrance.y, 8, C.honeyHi);
    // 演出用に数匹(蜜は運ばない)
    const n = Math.min(3, MAX_BEES - this.#bees.length);
    for (let i = 0; i < n; i++) this.#launchBee(g, 0, true);
    this.dispatchEvent(new CustomEvent("deposit", {
      bubbles: true,
      detail: { amount: added, collected: this.#collected, instant: true },
    }));
  }

  /** 採蜜先: 画面内の花を優先(1匹1輪を予約)、花が無ければ画面の外へ */
  #pickForage(g) {
    const free = this.#flowers.filter((f) => !f.claimed && !f.wilting && f.bloom > 0.5);
    if (free.length) {
      const f = free[(Math.random() * free.length) | 0];
      f.claimed = true;
      return { x: f.x, y: f.y - 10, r: 18, flower: f };
    }
    // 花が無い → 画面の外(左右どこかの縁を越えた先)へ飛んでいく
    const side = Math.random();
    let x, y;
    if (side < 0.4) { x = -rand(20, 60); y = rand(g.h * 0.15, g.groundY); }
    else if (side < 0.8) { x = g.w + rand(20, 60); y = rand(g.h * 0.15, g.groundY); }
    else { x = rand(g.w * 0.2, g.w * 0.8); y = -rand(20, 50); }
    return { x, y, r: 28, flower: null };
  }

  #burstPollen(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.3, 1.7);
      this.#pollen.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - rand(0.2, 0.9),
        life: 1, r: rand(1, 2.4),
        color: color || C.pollen,
      });
    }
  }

  // ================================================================ main loop
  #loop(now) {
    const dtMs = Math.min(40, now - this.#last);
    this.#last = now;
    const dt = dtMs / 16.67;
    this.#clock += dtMs;

    // ---- demoモード: 自走で value を進める
    const demo = this.getAttribute("demo");
    if (demo && this.value < 100) {
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

    const g = this.#geom();

    // ---- ステップ増加(10%刻みなど一気に増えた分)は往復を待たず即反映
    const jump = this.value - this.#lastSeenValue;
    if (jump >= STEP_THRESHOLD) this.#stepFill(g);
    this.#lastSeenValue = this.value;

    // ---- ミツバチの送り出し(連続的に増える未回収分を運ばせる)
    this.#spawnTimer += dtMs;
    const remaining = this.value - this.#committed();
    const ready = this.value >= 100 ? remaining > 0.01 : remaining >= CHUNK * 0.5;
    if (ready && this.#bees.length < MAX_BEES && this.#spawnTimer >= SPAWN_COOLDOWN) {
      this.#spawnTimer = 0;
      this.#launchBee(g, Math.min(CHUNK, remaining));
    }

    this.#updateBees(g, dt, dtMs);
    this.#updateAmbient(dt);

    // ---- 蜜面を貯蔵値へ滑らかに追従
    this.#honeyShown += (this.#collected - this.#honeyShown) * (1 - Math.pow(1 - HONEY_EASE, dt));
    if (Math.abs(this.#collected - this.#honeyShown) < 0.05) this.#honeyShown = this.#collected;
    this.#flash *= Math.pow(0.9, dt);
    this.#scorePulse *= Math.pow(0.88, dt);

    // ---- 花の揺れ・咲き・萎み(採蜜された花は萎んで消える)
    this.#flowers = this.#flowers.filter((f) => {
      f.sway += 0.03 * dt;
      if (f.wilting) {
        f.bloom -= 0.05 * dt;
        return f.bloom > 0;
      }
      if (f.bloom < 1) f.bloom = Math.min(1, f.bloom + 0.06 * dt);
      return true;
    });

    // ---- "+100" の浮き表示
    this.#floats = this.#floats.filter((fl) => {
      fl.y -= 0.6 * dt; fl.life -= 0.014 * dt; return fl.life > 0;
    });

    // ---- 花粉・しずくの更新
    this.#pollen = this.#pollen.filter((p) => {
      p.vy += 0.03 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.life -= 0.018 * dt; return p.life > 0;
    });
    this.#drips = this.#drips.filter((d) => {
      d.vy += 0.16 * dt; d.y += d.vy * dt; d.life -= 0.04 * dt; return d.life > 0;
    });

    // ---- 完了判定(巣が満ちたら)
    if (this.#collected >= 99.95) { this.#collected = 100; this.emitComplete(); }

    this.#render(g);
    this.$stage.classList.toggle("done", this.#collected >= 100);
  }

  #updateBees(g, dt, dtMs) {
    const remain = [];
    for (const b of this.#bees) {
      // 目標(状態で切り替わる)
      const tgt = b.state === "return" ? g.entrance : b.target;
      const dxv = tgt.x - b.x, dyv = tgt.y - b.y;
      const dist = Math.hypot(dxv, dyv) || 0.001;

      // 到着減速つきステアリング
      const slow = dist < SLOW_R ? dist / SLOW_R : 1;
      const desSpeed = MAX_SPEED * (0.4 + 0.6 * slow);
      const dvx = (dxv / dist) * desSpeed - b.vx;
      const dvy = (dyv / dist) * desSpeed - b.vy;
      b.vx += dvx * STEER * dt;
      b.vy += dvy * STEER * dt;
      // ふらつき(直交方向に小さく揺れる)
      b.wobble += 0.25 * dt;
      const wob = Math.sin(b.wobble) * 0.18;
      b.x += (b.vx + (-dyv / dist) * wob) * dt;
      b.y += (b.vy + (dxv / dist) * wob) * dt;
      b.flap += 0.9 * dt;

      const arriveR = b.state === "return" ? 12 : (b.target.r || 16);

      if (b.state === "out" && dist < arriveR) {
        b.state = "gather";
        b.gatherT = 0;
        b.vx *= 0.3; b.vy *= 0.3;
      } else if (b.state === "gather") {
        b.gatherT += dtMs;
        // 採蜜中はその場でホバリングしつつ花粉を散らす
        if (this.#clock % 130 < dtMs) {
          const col = b.target.flower ? b.target.flower.color : C.pollen;
          this.#burstPollen(b.x, b.y + 2, 2, col);
        }
        if (b.target.flower) b.target.flower.sway += 0.4 * dt;  // 花が揺れる
        if (b.gatherT >= b.gatherDur) {
          b.state = "return";
          // 画面内の花から採蜜できた → 花は萎んで消え、+100点
          const f = b.target.flower;
          if (f && !f.wilting) {
            f.wilting = true;
            this.#score += 100;
            this.#scorePulse = 1;
            this.#floats.push({ x: f.x, y: f.y - 16, life: 1, points: 100 });
            this.#burstPollen(f.x, f.y - 8, 10, f.color);
          }
        }
      } else if (b.state === "return" && dist < arriveR) {
        // 巣に入った! 運んできた蜜だけ表示が進む(演出バチは蜜を運ばない)
        if (!b.cosmetic) this.#deposit(g, b);
        continue;  // このハチは巣に収容(配列から除外)
      }

      remain.push(b);
    }
    this.#bees = remain;
  }

  /** ミツバチが巣に蜜を持ち帰る — ここで displayValue が進む */
  #deposit(g, b) {
    b.deposited = true;
    this.#collected = Math.min(100, this.#collected + b.payload);
    this.#trips++;
    this.#flash = 1;
    // 蜜が注がれるしずく
    for (let i = 0; i < 5; i++) {
      this.#drips.push({
        x: g.entrance.x + rand(-8, 8),
        y: g.entrance.y - rand(0, 6),
        vy: rand(0.4, 1.4), life: 1,
      });
    }
    this.#burstPollen(g.entrance.x, g.entrance.y, 6, C.honeyHi);
    this.dispatchEvent(new CustomEvent("deposit", {
      bubbles: true,
      detail: { amount: b.payload, collected: this.#collected },
    }));
  }

  #updateAmbient(dt) {
    for (const a of this.#ambient) {
      a.ang += a.sp * dt;
      a.flap += 0.9 * dt;
    }
  }

  // ================================================================ render
  #render(g) {
    const ctx = this.ctx;
    if (g.w < 10 || g.h < 10) return;

    ctx.save();
    ctx.scale(this.#dpr, this.#dpr);
    ctx.clearRect(0, 0, g.w, g.h);

    this.#drawMeadow(ctx, g);
    for (const f of this.#flowers) this.#drawFlower(ctx, f);

    // 花粉・きらめき(花/採蜜)
    for (const p of this.#pollen) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.#drawBranch(ctx, g);
    this.#drawComb(ctx, g);

    // 巣に注がれる蜜のしずく
    ctx.fillStyle = C.honey;
    for (const d of this.#drips) {
      ctx.globalAlpha = Math.max(0, d.life);
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, 2, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 働きバチ・見張りバチ
    for (const b of this.#bees) {
      const carry = b.state === "return";
      const ang = Math.atan2(b.vy, b.vx);
      this.#drawBee(ctx, b.x, b.y, ang, b.flap, carry);
    }
    for (const a of this.#ambient) {
      const x = g.cx + Math.cos(a.ang) * g.R * a.rad;
      const y = g.cy + Math.sin(a.ang) * g.R * a.rad * 0.7;
      const ang = a.ang + Math.PI / 2 * (a.sp > 0 ? 1 : -1);
      this.#drawBee(ctx, x, y, ang, a.flap, false);
    }

    // "+100" の得点表示
    for (const fl of this.#floats) this.#drawFloat(ctx, fl);

    this.#drawHUD(ctx, g);
    ctx.restore();
  }

  #drawMeadow(ctx, g) {
    const grad = ctx.createLinearGradient(0, g.groundY, 0, g.h);
    grad.addColorStop(0, C.grass);
    grad.addColorStop(1, C.grassDark);
    ctx.fillStyle = grad;
    ctx.fillRect(0, g.groundY, g.w, g.h - g.groundY);
    // 草の刃
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    for (let x = 6; x < g.w; x += 14) {
      const sw = Math.sin((x + this.#clock * 0.0012) * 0.6) * 3;
      ctx.beginPath();
      ctx.moveTo(x, g.h);
      ctx.quadraticCurveTo(x + sw, g.groundY + 6, x + sw * 1.6, g.groundY - 2);
      ctx.stroke();
    }
  }

  #drawFlower(ctx, f) {
    const s = 14 * easeOut(f.bloom);
    if (s < 0.5) return;
    const sway = Math.sin(f.sway) * 2.5;
    ctx.save();
    ctx.translate(f.x + sway, f.y);
    // 茎
    ctx.strokeStyle = C.grassDark;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-sway, 20);
    ctx.lineTo(0, 0);
    ctx.stroke();
    // 花びら
    ctx.fillStyle = f.color;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + f.sway * 0.1;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * s * 0.7, Math.sin(a) * s * 0.7, s * 0.5, s * 0.34, a, 0, Math.PI * 2);
      ctx.fill();
    }
    // 花芯
    ctx.fillStyle = "#FFD54A";
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  #drawBranch(ctx, g) {
    const y = g.cy - g.R - 6;
    const grad = ctx.createLinearGradient(0, y - 4, 0, y + 6);
    grad.addColorStop(0, C.branch);
    grad.addColorStop(1, C.branchDark);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(g.cx - g.w * 0.5, y - 8);
    ctx.quadraticCurveTo(g.cx, y + 2, g.cx + g.w * 0.5, y - 8);
    ctx.stroke();
    // 巣を吊る糸
    ctx.strokeStyle = C.branchDark;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(g.cx, y + 1);
    ctx.lineTo(g.cx, g.cy - g.R + 4);
    ctx.stroke();
  }

  #drawComb(ctx, g) {
    const { cx, cy, R } = g;
    const top = cy - R, bot = cy + R;
    const f = clamp(this.#honeyShown / 100, 0, 1);
    const lineY = bot - f * (bot - top);          // 蜜面(下から満ちる)
    const rc = R * 0.2;                            // セルの六角半径

    // 巣全体の影(真円)
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.arc(cx + 3, cy + 5, R * 1.03, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // セル(下=蜜入り / 上=空のロウ)
    for (const c of this.#cells) {
      const px = cx + c.x * R;
      const py = cy + c.y * R;
      const filled = py >= lineY;
      this.#hexCell(ctx, px, py, rc * 0.92, filled);
    }

    // 蜜面のきらめき(満ちている時だけ、巣の幅で帯状に光らせる)
    if (f > 0.01 && f < 0.999) {
      const half = R * Math.sqrt(Math.max(0, 0.92 - Math.pow((lineY - cy) / R, 2)));
      const glow = 0.5 + this.#flash * 0.5;
      ctx.save();
      ctx.globalAlpha = glow;
      ctx.strokeStyle = C.honeyHi;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const x = cx - half + t * half * 2;
        const yy = lineY + Math.sin(t * Math.PI * 3 + this.#clock * 0.004) * 1.6;
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 巣の輪郭(真円)
    ctx.strokeStyle = C.combLine;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.99, 0, Math.PI * 2);
    ctx.stroke();

    // 入口(下のくぼみ。ここからミツバチが出入りする)
    const e = g.entrance;
    ctx.fillStyle = "#241B0C";
    ctx.beginPath();
    ctx.ellipse(e.x, e.y - 2, R * 0.16, R * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    if (this.#flash > 0.02) {
      ctx.globalAlpha = this.#flash;
      ctx.fillStyle = C.honeyHi;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y - 2, R * 0.16, R * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** 六角セルを1つ描く(flat-top)。filled=蜜入り */
  #hexCell(ctx, x, y, r, filled) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (filled) {
      const grad = ctx.createLinearGradient(x, y - r, x, y + r);
      grad.addColorStop(0, C.honeyHi);
      grad.addColorStop(1, C.honeyDark);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = C.wax;
    }
    ctx.fill();
    ctx.strokeStyle = filled ? "rgba(120,80,10,.5)" : C.combLine;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (filled) {
      // 蜜のつや
      ctx.fillStyle = "rgba(255,255,255,.25)";
      ctx.beginPath();
      ctx.arc(x - r * 0.28, y - r * 0.3, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** "+100" の浮き上がる得点表示 */
  #drawFloat(ctx, fl) {
    const t = 1 - fl.life;
    const pop = t < 0.2 ? easeOut(t / 0.2) : 1;
    const sc = 0.6 + pop * 0.6;
    ctx.save();
    ctx.globalAlpha = Math.max(0, fl.life > 0.4 ? 1 : fl.life / 0.4);
    ctx.translate(fl.x, fl.y);
    ctx.scale(sc, sc);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 20px ui-monospace, monospace";
    ctx.lineJoin = "round";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#5A2E00";
    ctx.strokeText("+" + fl.points, 0, 0);
    const grad = ctx.createLinearGradient(0, -12, 0, 12);
    grad.addColorStop(0, C.honeyHi);
    grad.addColorStop(1, C.accent);
    ctx.fillStyle = grad;
    ctx.fillText("+" + fl.points, 0, 0);
    ctx.restore();
  }

  /** ミツバチ1匹。原点=体の中心、ang=進行方向、carry=蜜玉を抱えて帰る */
  #drawBee(ctx, x, y, ang, flap, carry) {
    const s = 6.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);

    // 羽(はばたき)
    const wf = 0.5 + Math.abs(Math.sin(flap)) * 0.7;
    ctx.fillStyle = C.wing;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(1, side);
      ctx.beginPath();
      ctx.ellipse(-s * 0.1, -s * 0.7, s * 0.7, s * 0.42 * wf, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 運ぶ蜜玉(帰り道)
    if (carry) {
      ctx.fillStyle = C.honey;
      ctx.shadowColor = C.honeyHi; ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(-s * 1.1, 0, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 胴体(楕円)
    ctx.fillStyle = C.bee;
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    // 縞模様
    ctx.fillStyle = C.beeDark;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2);
    ctx.clip();
    for (let i = -1; i <= 2; i++) {
      ctx.fillRect(i * s * 0.5 - s * 0.16, -s, s * 0.26, s * 2);
    }
    ctx.restore();
    // 頭
    ctx.fillStyle = C.beeDark;
    ctx.beginPath();
    ctx.arc(s * 0.92, 0, s * 0.42, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  #drawHUD(ctx, g) {
    const pct = Math.floor(this.#honeyShown);
    const done = this.#collected >= 100;

    // % (中央上)— ミツバチが持ち帰るたびに進む蜜の量
    ctx.font = "600 22px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = done ? C.honey : C.muted;
    ctx.fillText(pct + "%", g.cx, 26);

    // ステップラベル / 任意コメント(左上)
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    const step =
      this.steps.find((s) => this.value <= s.until) ||
      this.steps[this.steps.length - 1];
    if (step) {
      ctx.fillStyle = done ? C.good : C.accent;
      ctx.fillText(step.label, 12, 20);
    }
    if (this.note) {
      ctx.fillStyle = C.muted;
      ctx.fillText(this.note, 12, 36);
    }

    // スコア(右上・大きく目立たせる。加点でポンと弾む)
    const sx = g.w - 14;
    ctx.save();
    ctx.textAlign = "right";
    // SCORE ラベル
    ctx.textBaseline = "alphabetic";
    ctx.font = "600 10px ui-monospace, monospace";
    ctx.fillStyle = C.muted;
    ctx.fillText("SCORE", sx, 18);
    // 数値(脈動でスケール)
    const sc = 1 + easeOut(clamp(this.#scorePulse, 0, 1)) * 0.35;
    ctx.translate(sx, 46);
    ctx.scale(sc, sc);
    ctx.textBaseline = "alphabetic";
    ctx.font = "900 34px ui-monospace, monospace";
    ctx.lineJoin = "round";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#5A2E00";
    ctx.strokeText(String(this.#score), 0, 0);
    ctx.shadowColor = "rgba(255,194,60,.8)";
    ctx.shadowBlur = 8 + this.#scorePulse * 16;
    const grad = ctx.createLinearGradient(0, -26, 0, 4);
    grad.addColorStop(0, C.honeyHi);
    grad.addColorStop(1, C.accent);
    ctx.fillStyle = grad;
    ctx.fillText(String(this.#score), 0, 0);
    ctx.restore();

    // 採蜜中のハチ数 / 往復数(右上・小さく)
    ctx.textAlign = "right";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = done ? C.good : C.muted;
    const flying = this.#bees.length;
    ctx.fillText(done ? "満蜜!" : `採蜜 ${flying} / 往復 ${this.#trips}`, sx, 60);
  }
}

customElements.define("hive-progress", HiveProgress);
export { HiveProgress };
