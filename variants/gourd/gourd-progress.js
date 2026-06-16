/**
 * <gourd-progress> — ひょうたんのつるが伸びる進捗表現(お宝キャッチゲーム付き)
 *
 * 進捗モデル(正直設計):
 *   value(実進捗)   … 外部から流し込む唯一の入力。
 *   grown(表示)      … つるの伸び。value へ滑らかに追従(displayValue)。
 *
 * 遊び:
 *   つるの要所に「ひょうたんの実」が生り、成るとすぐ腰のくびれでぱかっと割れて
 *   中のめでたいもの(小判/達磨/富士/宝珠/鏡餅/小槌)が上へ飛び上がってから落下する。
 *   各お宝は 50〜500 点のランダム得点(300点以上はキラキラ、500点はギラギラに輝く)。
 *   カーソルの X方向に追従するキャラ(かごを掲げた子)で受け止めると加点。
 *   最後に結果スコアを表示。落とした全てをキャッチすると PERFECT! 演出。
 *   ゲームは進捗に一切影響しない。
 *
 * 使い方:
 *   <script type="module" src="variants/gourd/gourd-progress.js"></script>
 *   <gourd-progress id="gp"></gourd-progress>
 *   <script> gp.value = serverProgress; </script>
 *
 * 属性:
 *   value         実進捗 0–100
 *   height        表示高さpx (default 460)
 *   demo          "smooth" | "step"  自走デモ(本番では使わない)
 *   duration      demoモードの所要ms (default 16000)
 *
 * プロパティ/メソッド:
 *   .value / .displayValue(=つるの伸び) / .score(得点・読み取り専用)
 *   .steps  進捗しきい値ごとのラベル [{label, until}, …]
 *   .note   進捗とは独立した任意の一行コメント
 *   .openAll()  出現済みの実を即座に割って落とす   .reset()
 *
 * イベント:
 *   "complete"     つるが100%に到達したとき(1回)
 *   "gourd-open"   実が割れたとき(detail: { treasure })
 *   "perfect"      落としたお宝を全てキャッチしたとき
 *
 * 依存: なし(canvasのみ)
 */
import { ProgressBase } from "../../core/progress-base.js";

const C = {
  edge: "#332D63", line: "#3D3675", muted: "#8F89BC", accent: "#FFB454",
  text: "#3A3470", good: "#7BE3A8",
  vine: "#6FB36A", vineDark: "#3F7D43", leaf: "#79C46F", leafDark: "#4E9A54",
  gourd: "#E7D08A", gourdShade: "#CBA856", gourdLine: "#6B5524",
  soil: "#3A2E5A", pot: "#7A5A8C",
};

const DEFAULT_STEPS = [
  { label: "種まき", until: 8 },
  { label: "発芽", until: 24 },
  { label: "つる伸び", until: 50 },
  { label: "開花", until: 72 },
  { label: "結実", until: 95 },
  { label: "豊作", until: 100 },
];

// つるの要所に生る実。値=つるが何%伸びたら現れるか(本数を倍に)。
const DEFAULT_GOURDS = [9, 18, 27, 36, 45, 54, 63, 72, 81, 90];
const TREASURES = ["koban", "daruma", "fuji", "houju", "kagami", "mallet"];

// つるに沿って葉を出す位置(つるの伸びが届くと展開)
const LEAF_STOPS = [0.1, 0.24, 0.4, 0.58, 0.74, 0.9];

// ---- キャッチゲームの調整値
const OPEN_DELAY = 300;       // 実が成ってから割れるまで ms
const GRAVITY = 0.11;         // 落下加速度
const POP_UP = [3.4, 5.0];    // 割れた瞬間に飛び上がる上向き初速
const DRIFT = 2.6;            // 左右のランダム初速(±)
const FALL_S = 17;            // 落下するお宝の大きさ
const CATCH_R = 30;           // キャラのキャッチ判定半径
// お宝の得点(ランダム抽選表)。500 はレア、300/400 は控えめ。
const POINT_TABLE = [50, 50, 50, 100, 100, 100, 150, 150, 200, 200, 250, 300, 300, 400, 500];
const KIRA = 300;             // これ以上でキラキラ
const GIRA = 500;             // これでギラッギラ
const CONFETTI_COLORS = ["#FF7A9C", "#FFD54A", "#7BE3A8", "#6F8DFF", "#FFB454"];

// 得点 → 輝きランク(0:通常 / 1:キラキラ / 2:ギラギラ)
const shineRank = (pts) => (pts >= GIRA ? 2 : pts >= KIRA ? 1 : 0);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

const TEMPLATE = `
<style>
  :host { display: block; height: 460px; }
  .stage {
    position: relative; width: 100%; height: 100%;
    background: linear-gradient(180deg, #1E1A3D 0%, #181430 100%);
    border: 1px solid ${C.edge}; border-radius: 14px; overflow: hidden;
    font-family: 'Hiragino Sans', 'Yu Gothic UI', sans-serif;
  }
  .stage.done { border-color: rgba(123,227,168,.55); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: manipulation; }
</style>
<div class="stage" part="stage">
  <canvas id="cv"></canvas>
</div>
`;

class GourdProgress extends ProgressBase {
  static get observedAttributes() {
    return ["value", "height"];
  }

  // ---- 設定
  steps = DEFAULT_STEPS;
  note = "";

  // ---- 内部状態
  #grown = 0;
  #fruits = [];      // { tPct, type, appear, state, crack, ripe, dropped, spark[] }
  #leaves = [];      // { t, grow }
  #demoTimer = 0;

  #wave = [];            // つるの蛇行を決めるランダムな倍音 [{freq, amp, phase}]

  // ---- キャッチゲーム
  #falling = [];     // 落下中のお宝 { x, y, vx, vy, type, rot, vr }
  #floats = [];      // "+100" の派手表示 { x, y, life }
  #rings = [];       // キャッチの衝撃波リング { x, y, r, life }
  #confetti = [];    // 紙吹雪 { x, y, vx, vy, rot, vr, color, size, star, life }
  #catcher = { x: 0, y: 0, tx: 0, bounce: 0, init: false };  // 高さ固定・X軸のみ移動
  #score = 0;
  #dropped = 0;      // 落下させたお宝の数
  #caught = 0;       // キャッチ数
  #missed = 0;       // 取り逃し数
  #perfect = false;  // 全部キャッチ
  #perfectT = 0;
  #gameOver = false; // 全部落とし切って空中も無くなった(結果表示)
  #gameOverT = 0;
  #clock = 0;        // 演出用のミリ秒時計

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
    this.#buildFruits();
    this.#genWave();
    this.#leaves = LEAF_STOPS.map((t) => ({ t, grow: 0 }));
  }

  /** つるのうねりをランダム生成(リセットごとに違う蛇行になる) */
  #genWave() {
    const n = 3 + Math.floor(Math.random() * 2);   // 3〜4倍音
    const w = [];
    for (let i = 0; i < n; i++) {
      // 低い倍音ほど大きく振れる(全幅の大うねり)。高い倍音で細かいグネグネ。
      const freq = 1.4 + i * 1.7 + Math.random() * 1.4;
      const amp = (1 / (i + 1)) * (0.6 + Math.random() * 0.8);
      w.push({ freq, amp, phase: Math.random() * Math.PI * 2 });
    }
    const tot = w.reduce((s, h) => s + h.amp, 0);   // 合計振幅を1に正規化=全幅に収める
    for (const h of w) h.amp /= tot;
    this.#wave = w;
  }

  // ================================================================ lifecycle
  connectedCallback() {
    if (this.hasAttribute("height"))
      this.style.height = parseInt(this.getAttribute("height")) + "px";

    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(this);
    this.#resize();

    this.#wirePointer();

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
    return this.#grown;
  }

  /** 進捗・つる・実・スコアをすべて初期状態に戻す */
  reset() {
    this.value = 0;
    this.#grown = 0;
    this.#demoTimer = 0;
    this.#buildFruits();
    this.#genWave();   // うねりも引き直す
    for (const l of this.#leaves) l.grow = 0;
    this.#falling = [];
    this.#floats = [];
    this.#rings = [];
    this.#confetti = [];
    this.#score = 0;
    this.#dropped = 0;
    this.#caught = 0;
    this.#missed = 0;
    this.#perfect = false;
    this.#perfectT = 0;
    this.#gameOver = false;
    this.#gameOverT = 0;
    this.#catcher.bounce = 0;
    this.resetCompleted();
  }

  get score() {
    return this.#score;
  }

  /** 出現済みでまだ割れていない実を即座に割って落とす */
  openAll() {
    for (const f of this.#fruits)
      if (f.appear > 0.6 && f.state === "idle") this.#openFruit(f);
  }

  // ================================================================ internals
  #buildFruits() {
    this.#fruits = DEFAULT_GOURDS.map((tPct, i) => ({
      tPct,
      type: TREASURES[i % TREASURES.length],
      appear: 0,           // 0→1 出現アニメ
      state: "hidden",     // hidden → idle → opening(空の殻)
      crack: 0,            // 0→1 割れ進行
      ripe: 0,             // 成ってから割れるまでの経過ms
      dropped: false,      // お宝を落としたか
      _cx: 0, _waistY: 0,  // 落下開始位置(描画時に更新)
      spark: [],           // 割れた瞬間の火花
    }));
  }

  #resize() {
    const r = this.$cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.$cv.width = r.width * this.#dpr;
    this.$cv.height = r.height * this.#dpr;
  }

  // つるの幾何: t∈[0,1] (0=根元, 1=てっぺん) → 画面座標
  #geom() {
    const r = this.$cv.getBoundingClientRect();
    const w = r.width, h = r.height;
    const padTop = 54, padBottom = 64;
    const bottomY = h - padBottom;
    const topY = padTop;
    const cx = w * 0.5;
    // 振れ幅はキャンバス幅いっぱい(左右の余白だけ残す)
    const amp = Math.max(40, w * 0.5 - 40);
    return { w, h, bottomY, topY, cx, amp };
  }

  #pathPoint(t, g) {
    const y = g.bottomY - t * (g.bottomY - g.topY);
    // 根元(鉢の中央)から、登るほど振れ幅を増して左右へ大きくうねる。
    //   うねりはランダム生成した倍音の合成(#genWave)。毎回違う蛇行になる。
    const env = Math.pow(t, 0.7);                       // 根元は中央、上ほど全幅へ
    let sway = 0;
    for (const h of this.#wave)
      sway += Math.sin(t * Math.PI * h.freq + h.phase) * h.amp;
    const x = g.cx + env * sway * g.amp;
    return { x, y };
  }

  #wirePointer() {
    // カーソルの X位置にだけキャラ(かご)を合わせる(高さは固定)
    const aim = (e) => {
      const r = this.$cv.getBoundingClientRect();
      const c = this.#catcher;
      c.tx = clamp(e.clientX - r.left, 0, r.width);
      if (!c.init) { c.x = c.tx; c.init = true; }
    };
    this.$cv.style.cursor = "none";
    this.$cv.addEventListener("pointermove", aim);
    this.$cv.addEventListener("pointerdown", aim);
  }

  /** 実を割る(空の殻になる。お宝の落下はループ側で crack 進行に合わせて発生) */
  #openFruit(f) {
    if (f.state !== "idle") return;
    f.state = "opening";
    // 割れた瞬間の火花(種が飛び散る感じ)
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 2.4;
      f.spark.push({
        x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
        life: 1, r: 1 + Math.random() * 1.6,
      });
    }
    this.dispatchEvent(
      new CustomEvent("gourd-open", { bubbles: true, detail: { treasure: f.type } })
    );
  }

  /** お宝を割れ目から放出:まず上へ飛び上がり、左右ランダムに散って落下する */
  #dropTreasure(f) {
    const up = POP_UP[0] + Math.random() * (POP_UP[1] - POP_UP[0]);
    const points = POINT_TABLE[(Math.random() * POINT_TABLE.length) | 0];
    this.#falling.push({
      x: f._cx,
      y: f._waistY,
      vx: (Math.random() * 2 - 1) * DRIFT,   // 左右ランダム
      vy: -up,                               // 上向きに飛び出す
      type: f.type,
      points,
      shine: shineRank(points),              // 0通常 / 1キラキラ / 2ギラギラ
      rot: 0,
      vr: (Math.random() * 2 - 1) * 0.06,
    });
    this.#dropped++;
  }

  #addConfetti(x, y, n, power) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = Math.random() * power;
      this.#confetti.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - power * 0.4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() * 2 - 1) * 0.4,
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        size: 3 + Math.random() * 3.5,
        star: Math.random() < 0.5,        // 半分は星型でキラキラに
        life: 1,
      });
    }
  }

  /** 中心から放射する n 本の光条つきの星(キラッ) */
  #star(ctx, x, y, r, points) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const rad = i % 2 === 0 ? r : r * 0.42;
      const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
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

    // ---- 表示(つるの伸び)を value へ滑らかに追従
    const k = 1 - Math.pow(0.9, dt);
    this.#grown += (this.value - this.#grown) * k;
    if (this.value >= 100 && this.#grown > 99.6) this.#grown = 100;
    if (Math.abs(this.value - this.#grown) < 0.05) this.#grown = this.value;

    // ---- 葉の展開
    for (const l of this.#leaves) {
      const target = this.#grown / 100 >= l.t ? 1 : 0;
      l.grow += (target - l.grow) * (1 - Math.pow(0.85, dt));
    }

    const g = this.#geom();

    // ---- 実の出現 → 成熟したら自動で割れて落とす
    for (const f of this.#fruits) {
      const visible = this.#grown >= f.tPct + 0.5;
      const targetAppear = visible ? 1 : 0;
      f.appear += (targetAppear - f.appear) * (1 - Math.pow(0.82, dt));
      if (f.state === "hidden" && f.appear > 0.6) f.state = "idle";
      if (f.state === "idle" && !visible && f.appear < 0.4) f.state = "hidden";

      // 成ってしばらくしたら割れる
      if (f.state === "idle" && f.appear > 0.9) {
        f.ripe += dtMs;
        if (f.ripe > OPEN_DELAY) this.#openFruit(f);
      }
      // 割れの進行 → 割れたらお宝を放出
      if (f.state === "opening") {
        f.crack = Math.min(1, f.crack + 0.06 * dt);
        if (f.crack > 0.4 && !f.dropped) { this.#dropTreasure(f); f.dropped = true; }
      }
      // 火花の更新
      f.spark = f.spark.filter((s) => {
        s.x += s.vx * dt; s.y += s.vy * dt;
        s.vy += 0.12 * dt; s.life -= 0.03 * dt;
        return s.life > 0;
      });
    }

    // ---- キャラ(かご)はカーソルの X方向にだけ追従(高さは下部に固定)
    const c = this.#catcher;
    c.y = g.h * 0.82;
    if (!c.init) { c.x = g.cx; c.tx = c.x; c.init = true; }
    c.x += (c.tx - c.x) * (1 - Math.pow(0.55, dt));
    c.bounce *= Math.pow(0.82, dt);

    // ---- 落下するお宝の更新・キャッチ判定
    const groundY = g.h - 3;
    this.#falling = this.#falling.filter((t) => {
      t.vy += GRAVITY * dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.rot += t.vr * dt;
      // 壁で軽く跳ね返す
      if (t.x < FALL_S) { t.x = FALL_S; t.vx = Math.abs(t.vx) * 0.6; }
      else if (t.x > g.w - FALL_S) { t.x = g.w - FALL_S; t.vx = -Math.abs(t.vx) * 0.6; }
      // キャッチ(落下中=飛び上がりが終わってから)
      if (t.vy > 0 && Math.hypot(t.x - c.x, t.y - c.y) < CATCH_R) {
        this.#score += t.points;
        this.#caught++;
        c.bounce = 1 + t.shine * 0.4;        // 高得点ほど大きく弾む
        this.#floats.push({ x: t.x, y: c.y - 16, life: 1, points: t.points, shine: t.shine });
        this.#rings.push({ x: t.x, y: c.y - 6, r: 4, life: 1 });
        this.#rings.push({ x: t.x, y: c.y - 6, r: 4, life: 0.7 });
        this.#addConfetti(t.x, c.y - 6, 20 + t.shine * 18, 7.5 + t.shine * 1.5);
        return false;
      }
      if (t.y > groundY) { this.#missed++; return false; }
      return true;
    });

    // ---- "+100" 浮き表示・衝撃波・紙吹雪
    this.#floats = this.#floats.filter((fl) => {
      fl.y -= 0.7 * dt; fl.life -= 0.014 * dt; return fl.life > 0;
    });
    this.#rings = this.#rings.filter((r) => {
      r.r += 2.8 * dt; r.life -= 0.05 * dt; return r.life > 0;
    });
    this.#confetti = this.#confetti.filter((p) => {
      p.vy += 0.06 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt; p.life -= 0.012 * dt;
      return p.life > 0 && p.y < g.h + 20;
    });

    // ---- 完了 / ゲーム終了 / PERFECT 判定
    if (this.#grown >= 100) this.emitComplete();
    const total = this.#fruits.length;
    const finished =
      this.#grown >= 100 && this.#dropped >= total && this.#falling.length === 0;

    if (finished && !this.#gameOver) {
      this.#gameOver = true;
      this.#gameOverT = 0;
    }
    if (this.#gameOver) this.#gameOverT += dt;

    if (finished && !this.#perfect && this.#caught === total && this.#missed === 0) {
      this.#perfect = true;
      this.#perfectT = 0;
      this.#addConfetti(g.cx, g.h * 0.38, 110, 10);
      this.dispatchEvent(new CustomEvent("perfect", { bubbles: true }));
    }
    if (this.#perfect) {
      this.#perfectT += dt;
      if (this.#perfectT % 24 < dt) this.#addConfetti(g.cx, g.h * 0.38, 16, 9);
    }

    this.#render(g);
    this.$stage.classList.toggle("done", this.#grown >= 100);
  }

  // ================================================================ render
  #render(g) {
    const ctx = this.ctx;
    if (g.w < 10 || g.h < 10) return;

    ctx.save();
    ctx.scale(this.#dpr, this.#dpr);
    ctx.clearRect(0, 0, g.w, g.h);

    // 地面の鉢
    this.#drawPot(ctx, g);

    // つる(根元→現在の伸びまで)
    const tCur = this.#grown / 100;
    this.#drawVine(ctx, g, tCur);

    // 葉
    for (const l of this.#leaves) {
      if (l.grow < 0.02 || l.t > tCur + 0.02) continue;
      const p = this.#pathPoint(l.t, g);
      const side = p.x <= g.cx ? 1 : -1;   // 端で切れないよう中央へ向けて出す
      this.#drawLeaf(ctx, p.x, p.y, 18 * easeOut(l.grow), side);
    }

    // てっぺんの巻きひげ
    if (tCur > 0.05) {
      const tip = this.#pathPoint(tCur, g);
      this.#drawTendril(ctx, tip.x, tip.y, 14);
    }

    // 実(ひょうたん)
    for (const f of this.#fruits) {
      if (f.appear < 0.02) continue;
      const node = this.#pathPoint(f.tPct / 100, g);
      this.#drawFruit(ctx, f, node);
    }

    // 落下中のお宝(得点ランクに応じてキラキラ/ギラギラ)
    for (const t of this.#falling)
      this.#drawTreasure(ctx, t.type, t.x, t.y, FALL_S, 1, t.rot, t.shine);

    // キャラ(かご)
    if (this.#catcher.init) this.#drawCatcher(ctx, this.#catcher);

    // キャッチの衝撃波リング
    for (const r of this.#rings) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, r.life) * 0.8;
      ctx.strokeStyle = "#FFE89A";
      ctx.lineWidth = 3 * r.life + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 紙吹雪(角片 or 星)
    for (const p of this.#confetti) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.star) { this.#star(ctx, 0, 0, p.size, 4); ctx.fill(); }
      else ctx.fillRect(-p.size * 0.5, -p.size * 0.35, p.size, p.size * 0.7);
      ctx.restore();
    }

    // "+得点" の派手表示
    for (const fl of this.#floats) this.#drawFloat(ctx, fl);

    // ---- HUD
    const total = this.#fruits.length;
    // % (中央上)
    ctx.globalAlpha = 1;
    ctx.font = "600 22px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = this.#grown >= 100 ? C.good : C.muted;
    ctx.fillText(Math.floor(this.value) + "%", g.cx, 26);

    // ステップラベル / 任意コメント(左上)
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    const step =
      this.steps.find((s) => this.value <= s.until) ||
      this.steps[this.steps.length - 1];
    if (step) {
      ctx.fillStyle = this.#grown >= 100 ? C.good : C.accent;
      ctx.fillText(step.label, 12, 20);
    }
    if (this.note) {
      ctx.fillStyle = C.muted;
      ctx.fillText(this.note, 12, 36);
    }

    // スコア(右上)
    ctx.textAlign = "right";
    ctx.font = "bold 16px ui-monospace, monospace";
    ctx.fillStyle = C.accent;
    ctx.fillText(String(this.#score), g.w - 12, 22);
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = C.muted;
    ctx.fillText(`CATCH ${this.#caught}/${total}`, g.w - 12, 36);

    // 結果パネル(最後のスコア表示。PERFECT ならその演出も)
    if (this.#gameOver) this.#drawResults(ctx, g, total);

    ctx.restore();
  }

  /** "+得点" の派手な浮き表示(得点ランクで色・大きさ・きらめきが変わる) */
  #drawFloat(ctx, fl) {
    const t = 1 - fl.life;
    const pop = t < 0.2 ? easeOut(t / 0.2) : 1;          // 出だしに弾む
    const sc = (0.6 + pop * 0.9) * (1 + Math.sin(t * 26) * 0.04) * (1 + fl.shine * 0.22);
    const alpha = fl.life > 0.4 ? 1 : fl.life / 0.4;
    const size = 22 + fl.shine * 8;

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(fl.x, fl.y);
    ctx.rotate(Math.sin(t * 7) * 0.06);
    ctx.scale(sc, sc);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${size}px ui-monospace, monospace`;
    ctx.lineJoin = "round";

    // 背後のきらめき(ランクが高いほど派手)
    if (fl.shine >= 1) {
      const rays = fl.shine >= 2 ? 12 : 8;
      ctx.save();
      ctx.rotate(t * 2);
      ctx.fillStyle = fl.shine >= 2 ? "rgba(255,120,160,.55)" : "rgba(255,224,150,.5)";
      for (let i = 0; i < rays; i++) {
        ctx.rotate((Math.PI * 2) / rays);
        this.#star(ctx, 0, -size * 1.1, size * 0.22, 4);
        ctx.fill();
      }
      ctx.restore();
    }

    // グロー + 太い縁取り
    ctx.shadowColor = fl.shine >= 2 ? "rgba(255,90,150,.95)"
      : fl.shine >= 1 ? "rgba(255,200,80,.95)" : "rgba(255,180,84,.7)";
    ctx.shadowBlur = 10 + fl.shine * 12;
    ctx.lineWidth = 7;
    ctx.strokeStyle = "#5A2E00";
    ctx.strokeText("+" + fl.points, 0, 0);
    ctx.shadowBlur = 0;

    // 本体(金〜ランクで赤金/虹寄り)
    const grad = ctx.createLinearGradient(0, -size * 0.6, 0, size * 0.6);
    if (fl.shine >= 2) {
      grad.addColorStop(0, "#FFF3B0"); grad.addColorStop(0.5, "#FFD54A");
      grad.addColorStop(1, "#FF5A7A");
    } else {
      grad.addColorStop(0, "#FFF3B0"); grad.addColorStop(0.5, "#FFD54A");
      grad.addColorStop(1, "#FF9B3D");
    }
    ctx.fillStyle = grad;
    ctx.fillText("+" + fl.points, 0, 0);
    ctx.restore();
  }

  /** 最後の結果表示。PERFECT のときは大見出しも出す */
  #drawResults(ctx, g, total) {
    const t = Math.min(1, this.#gameOverT / 18);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (this.#perfect) this.#drawPerfect(ctx, g);

    // スコアをカウントアップ表示
    const shown = Math.round(this.#score * Math.min(1, this.#gameOverT / 40));
    const cy = g.h * (this.#perfect ? 0.56 : 0.44);
    const sc = 0.7 + easeOut(t) * 0.3;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.translate(g.cx, cy);
    ctx.scale(sc, sc);
    ctx.font = "600 13px ui-monospace, monospace";
    ctx.fillStyle = C.muted;
    ctx.fillText("SCORE", 0, -26);
    ctx.font = "900 46px ui-monospace, monospace";
    ctx.lineJoin = "round";
    ctx.lineWidth = 7; ctx.strokeStyle = "rgba(40,30,8,.55)";
    ctx.strokeText(String(shown), 0, 6);
    const grad = ctx.createLinearGradient(0, -16, 0, 26);
    grad.addColorStop(0, "#FFF3B0"); grad.addColorStop(1, "#FFB454");
    ctx.fillStyle = grad;
    ctx.fillText(String(shown), 0, 6);
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillStyle = this.#perfect ? C.good : C.muted;
    ctx.fillText(`CATCH ${this.#caught} / ${total}`, 0, 34);
    ctx.restore();
  }

  /** カーソル追従キャラ(かごを掲げた子)。原点=かごの口(キャッチ点) */
  #drawCatcher(ctx, c) {
    const bs = 24;                         // かごの半幅
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(1 + c.bounce * 0.14, 1 - c.bounce * 0.14);  // キャッチでぴょこっ

    // 腕(かごを掲げる・体の後ろ)
    ctx.strokeStyle = "#F0C49A"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-9, 46); ctx.lineTo(-bs * 0.7, 6);
    ctx.moveTo(9, 46); ctx.lineTo(bs * 0.7, 6);
    ctx.stroke();

    // 体(法被)
    ctx.fillStyle = "#3E6FB0";
    ctx.beginPath();
    ctx.roundRect(-13, 40, 26, 24, 7);
    ctx.fill();
    ctx.fillStyle = "#FFB454";               // 帯
    ctx.fillRect(-13, 52, 26, 4);

    // 頭(かごの下からのぞく)
    ctx.fillStyle = "#F6D7B0";
    ctx.beginPath();
    ctx.arc(0, 30, 12, 0, Math.PI * 2);
    ctx.fill();
    // はちまき
    ctx.fillStyle = "#D8443A";
    ctx.fillRect(-12, 23, 24, 4);
    ctx.beginPath();                          // 結び目
    ctx.moveTo(11, 25); ctx.lineTo(17, 22); ctx.lineTo(16, 28); ctx.closePath();
    ctx.fill();
    // 目・口
    ctx.fillStyle = "#2A2218";
    ctx.beginPath();
    ctx.arc(-4, 31, 1.6, 0, Math.PI * 2);
    ctx.arc(4, 31, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2A2218"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 33, 3, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    // かご(前・口が原点)
    ctx.fillStyle = "#5A3D1E";                // 内側の影
    ctx.beginPath();
    ctx.ellipse(0, 0, bs * 0.9, bs * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    const bg = ctx.createLinearGradient(0, 0, 0, 20);
    bg.addColorStop(0, "#B07B40"); bg.addColorStop(1, "#7A4F27");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(-bs, 0);
    ctx.lineTo(bs, 0);
    ctx.lineTo(bs * 0.66, 19);
    ctx.quadraticCurveTo(0, 25, -bs * 0.66, 19);
    ctx.closePath();
    ctx.fill();
    // 編み目
    ctx.strokeStyle = "rgba(60,40,20,.45)"; ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const yy = i * 5;
      const ww = bs * (1 - i * 0.11);
      ctx.beginPath();
      ctx.moveTo(-ww, yy); ctx.quadraticCurveTo(0, yy + 3, ww, yy);
      ctx.stroke();
    }
    // 口の縁
    ctx.strokeStyle = "#8A5A2B"; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, bs, bs * 0.34, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  #drawPerfect(ctx, g) {
    const t = Math.min(1, this.#perfectT / 16);
    const sc = 0.6 + easeOut(t) * 0.4;
    const pulse = 1 + Math.sin(this.#perfectT * 0.12) * 0.04;
    ctx.save();
    ctx.translate(g.cx, g.h * 0.4);
    ctx.scale(sc * pulse, sc * pulse);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "800 52px ui-monospace, monospace";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(40,30,8,.55)"; ctx.lineWidth = 8;
    ctx.strokeText("PERFECT!", 0, 0);
    const grad = ctx.createLinearGradient(0, -30, 0, 30);
    grad.addColorStop(0, "#FFE89A"); grad.addColorStop(1, "#FFB454");
    ctx.fillStyle = grad;
    ctx.fillText("PERFECT!", 0, 0);
    ctx.restore();
  }

  #drawPot(ctx, g) {
    const baseY = g.bottomY;
    const w = Math.min(g.w * 0.34, 130);
    ctx.fillStyle = C.soil;
    ctx.beginPath();
    ctx.ellipse(g.cx, baseY, w * 0.46, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.pot;
    ctx.beginPath();
    ctx.moveTo(g.cx - w * 0.46, baseY);
    ctx.lineTo(g.cx + w * 0.46, baseY);
    ctx.lineTo(g.cx + w * 0.36, baseY + 34);
    ctx.lineTo(g.cx - w * 0.36, baseY + 34);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(g.cx - w * 0.46, baseY, w * 0.92, 6);
  }

  #drawVine(ctx, g, tCur) {
    if (tCur < 0.005) return;
    const STEPS = 90;
    const pts = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = (i / STEPS) * tCur;
      pts.push(this.#pathPoint(t, g));
    }
    // 本体
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const grad = ctx.createLinearGradient(0, g.bottomY, 0, g.topY);
    grad.addColorStop(0, C.vineDark);
    grad.addColorStop(1, C.vine);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    // ハイライト
    ctx.strokeStyle = "rgba(200,255,190,.35)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  #drawLeaf(ctx, x, y, s, side) {
    if (s < 1) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(side * 0.5);
    ctx.scale(side, 1);
    const grad = ctx.createLinearGradient(0, -s, s, s);
    grad.addColorStop(0, C.leaf);
    grad.addColorStop(1, C.leafDark);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(s * 0.7, -s * 0.7, s * 1.5, 0);
    ctx.quadraticCurveTo(s * 0.7, s * 0.7, 0, 0);
    ctx.fill();
    ctx.strokeStyle = "rgba(40,90,45,.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(s * 1.3, 0);
    ctx.stroke();
    ctx.restore();
  }

  #drawTendril(ctx, x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = C.vine;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i <= 26; i++) {
      const a = i / 26;
      const ang = a * Math.PI * 3.2;
      const rad = (1 - a) * s;
      const px = Math.cos(ang) * rad;
      const py = -a * s * 0.6 + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---- ひょうたんの実(上下2つのふくらみ。腰のくびれでぱかっと割れる)
  #drawFruit(ctx, f, node) {
    const baseS = 30;
    const s = baseS * (0.2 + 0.8 * easeOut(f.appear));
    const rt = s * 0.30;            // 上ぶくらみ半径
    const rb = s * 0.46;            // 下ぶくらみ半径
    const cx = node.x + s * 0.32;   // つるから少し垂れる
    const stemY = node.y + 4;       // ヘタの位置
    const topC = stemY + rt;        // 上ぶくらみ中心
    const waistY = topC + rt * 0.78; // くびれ(破断点)
    const botC = waistY + rb * 0.7; // 下ぶくらみ中心

    // 落下開始位置(くびれ)を記録 — ループ側の #dropTreasure が使う
    f._cx = cx; f._waistY = waistY;

    // 実をつるに繋ぐ柄
    ctx.strokeStyle = C.vineDark;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(node.x, node.y);
    ctx.quadraticCurveTo(node.x + s * 0.18, stemY - 5, cx, stemY);
    ctx.stroke();

    const crack = f.crack;
    const sep = crack * rb * 0.95;   // 上下が離れる量

    // 下半分(おわん状に開く)
    ctx.save();
    ctx.translate(cx, botC + sep);
    ctx.rotate(crack * 0.12);
    this.#gourdBulb(ctx, rb, false, crack);
    ctx.restore();

    // 上半分(持ち上がってフタが開く)
    ctx.save();
    ctx.translate(cx, topC - sep * 1.1);
    ctx.rotate(-crack * 0.5);
    ctx.translate(0, -crack * 5);
    this.#gourdBulb(ctx, rt, true, crack);
    // ヘタ
    ctx.strokeStyle = C.vineDark;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, -rt);
    ctx.lineTo(0, -rt - 5);
    ctx.stroke();
    ctx.restore();

    // 閉じている間は腰に紅白の結び(継ぎ目を隠す)
    if (crack < 0.05) {
      ctx.fillStyle = "#D8443A";
      ctx.fillRect(cx - rt * 0.95, waistY - 2.5, rt * 1.9, 5);
      ctx.fillStyle = "#F6E7C8";
      ctx.fillRect(cx - rt * 0.95, waistY - 2.5, rt * 1.9, 2);
    }

    // 火花
    if (f.spark.length) {
      for (const sp of f.spark) {
        ctx.globalAlpha = Math.max(0, sp.life);
        ctx.fillStyle = C.accent;
        ctx.beginPath();
        ctx.arc(cx + sp.x, waistY + sp.y, sp.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /**
   * ひょうたんのふくらみ(円)を1つ描く。原点=円の中心(描画側で平行移動済み)。
   * top=true は上ぶくらみ(割れ口は下)、false は下ぶくらみ(割れ口は上)。
   * 閉じている時は2つの円が重なってひょうたん形になる。
   */
  #gourdBulb(ctx, r, top, crack) {
    const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.2, 0, 0, r * 1.25);
    grad.addColorStop(0, "#F4E6AE");
    grad.addColorStop(1, C.gourdShade);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // 割れ口の内側(割れたら覗く空洞)
    if (crack > 0.05) {
      ctx.fillStyle = "rgba(110,82,36,.6)";
      ctx.beginPath();
      ctx.ellipse(0, top ? r * 0.72 : -r * 0.72, r * 0.82, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // つや
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.38, -r * 0.34, r * 0.16, r * 0.28, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // ================================================================ めでたいもの
  // shine: 0通常 / 1キラキラ(300点〜) / 2ギラギラ(500点)
  #drawTreasure(ctx, type, x, y, s, alpha, rot = 0, shine = 0) {
    const ph = this.#clock * 0.006 + x * 0.05;        // きらめき位相
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(x, y);

    // 後光(ランクが上がるほど大きく明るく脈動)
    const pulse = 1 + Math.sin(ph) * (0.08 + shine * 0.06);
    const haloR = s * (1.6 + shine * 0.5) * pulse;
    const haloA = 0.45 + shine * 0.22;
    const halo = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, haloR);
    const haloCol = shine >= 2 ? "255,150,170" : "255,220,140";
    halo.addColorStop(0, `rgba(${haloCol},${haloA})`);
    halo.addColorStop(1, `rgba(${haloCol},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, Math.PI * 2);
    ctx.fill();

    // ギラギラ:回転する光条(十字フレア)
    if (shine >= 2) {
      ctx.save();
      ctx.rotate(ph * 0.6);
      ctx.globalAlpha = clamp(alpha, 0, 1) * (0.5 + Math.sin(ph * 2) * 0.2);
      const fl = ctx.createLinearGradient(-haloR, 0, haloR, 0);
      fl.addColorStop(0, "rgba(255,240,180,0)");
      fl.addColorStop(0.5, "rgba(255,245,200,.9)");
      fl.addColorStop(1, "rgba(255,240,180,0)");
      ctx.fillStyle = fl;
      ctx.fillRect(-haloR, -1.2, haloR * 2, 2.4);
      ctx.fillRect(-1.2, -haloR, 2.4, haloR * 2);
      ctx.restore();
    }

    if (rot) ctx.rotate(rot);
    switch (type) {
      case "koban": this.#tKoban(ctx, s); break;
      case "daruma": this.#tDaruma(ctx, s); break;
      case "fuji": this.#tFuji(ctx, s); break;
      case "houju": this.#tHouju(ctx, s); break;
      case "kagami": this.#tKagami(ctx, s); break;
      case "mallet": this.#tMallet(ctx, s); break;
    }
    this.#sparkles(ctx, s);
    ctx.restore();

    // キラキラ/ギラギラ:本体まわりを回る星(回転は本体の自転と分離)
    if (shine >= 1) {
      const n = shine >= 2 ? 6 : 4;
      const rr = s * (1.25 + 0.12 * Math.sin(ph * 1.7));
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.translate(x, y);
      ctx.rotate(ph * (shine >= 2 ? 1.1 : 0.7));
      ctx.fillStyle = shine >= 2 ? "#FFF0A0" : "#FFE89A";
      for (let i = 0; i < n; i++) {
        ctx.rotate((Math.PI * 2) / n);
        const twk = 0.6 + 0.4 * Math.sin(ph * 3 + i);
        this.#star(ctx, 0, -rr, s * 0.2 * twk, 4);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  #tKoban(ctx, s) {
    const g = ctx.createLinearGradient(0, -s, 0, s);
    g.addColorStop(0, "#FFE08A"); g.addColorStop(1, "#E0A93A");
    ctx.fillStyle = g;
    ctx.strokeStyle = "#A9781E"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.6, s * 0.92, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.42, s * 0.72, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 打目(横の刻み)で小判らしさを出す(文字は使わない)
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(-s * 0.3, i * s * 0.22);
      ctx.lineTo(s * 0.3, i * s * 0.22);
      ctx.stroke();
    }
  }

  #tDaruma(ctx, s) {
    ctx.fillStyle = "#D8443A";
    ctx.beginPath();
    ctx.ellipse(0, s * 0.1, s * 0.7, s * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    // 顔(白)
    ctx.fillStyle = "#F6E7C8";
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.05, s * 0.45, s * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // 眉・ひげ
    ctx.strokeStyle = "#3A2B1A"; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(-s * 0.2, -s * 0.18, s * 0.12, Math.PI, Math.PI * 1.6);
    ctx.arc(s * 0.2, -s * 0.18, s * 0.12, Math.PI * 1.4, Math.PI * 2);
    ctx.stroke();
    // 目(両目入り=満願)
    ctx.fillStyle = "#2A2218";
    ctx.beginPath();
    ctx.arc(-s * 0.16, -s * 0.05, s * 0.06, 0, Math.PI * 2);
    ctx.arc(s * 0.16, -s * 0.05, s * 0.06, 0, Math.PI * 2);
    ctx.fill();
    // 口ひげ(文字は使わない)
    ctx.strokeStyle = "#3A2B1A"; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-s * 0.18, s * 0.14);
    ctx.quadraticCurveTo(0, s * 0.24, s * 0.18, s * 0.14);
    ctx.stroke();
  }

  #tFuji(ctx, s) {
    // 日の出
    ctx.fillStyle = "#FFCF6B";
    ctx.beginPath();
    ctx.arc(s * 0.45, -s * 0.45, s * 0.3, 0, Math.PI * 2);
    ctx.fill();
    // 山
    const g = ctx.createLinearGradient(0, -s, 0, s * 0.6);
    g.addColorStop(0, "#6E83C8"); g.addColorStop(1, "#3E4E8C");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-s * 0.95, s * 0.55);
    ctx.lineTo(0, -s * 0.8);
    ctx.lineTo(s * 0.95, s * 0.55);
    ctx.closePath();
    ctx.fill();
    // 冠雪
    ctx.fillStyle = "#F4F6FF";
    ctx.beginPath();
    ctx.moveTo(-s * 0.26, -s * 0.18);
    ctx.lineTo(0, -s * 0.8);
    ctx.lineTo(s * 0.26, -s * 0.18);
    ctx.quadraticCurveTo(s * 0.1, -s * 0.34, 0, -s * 0.2);
    ctx.quadraticCurveTo(-s * 0.1, -s * 0.34, -s * 0.26, -s * 0.18);
    ctx.closePath();
    ctx.fill();
  }

  #tHouju(ctx, s) {
    // 炎
    ctx.fillStyle = "#FF9B3D";
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.1);
    ctx.quadraticCurveTo(s * 0.5, -s * 0.2, 0, s * 0.2);
    ctx.quadraticCurveTo(-s * 0.5, -s * 0.2, 0, -s * 1.1);
    ctx.fill();
    // 宝珠本体(雫形)
    const g = ctx.createRadialGradient(-s * 0.2, -s * 0.2, s * 0.1, 0, 0, s * 0.8);
    g.addColorStop(0, "#EAF6FF"); g.addColorStop(1, "#7FA9E6");
    ctx.fillStyle = g;
    ctx.strokeStyle = "#4E74B8"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.7);
    ctx.bezierCurveTo(s * 0.7, -s * 0.2, s * 0.55, s * 0.7, 0, s * 0.7);
    ctx.bezierCurveTo(-s * 0.55, s * 0.7, -s * 0.7, -s * 0.2, 0, -s * 0.7);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.beginPath();
    ctx.ellipse(-s * 0.2, -s * 0.1, s * 0.12, s * 0.22, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  #tKagami(ctx, s) {
    // 三方(台)
    ctx.fillStyle = "#C9A24B";
    ctx.fillRect(-s * 0.7, s * 0.62, s * 1.4, s * 0.18);
    // 餅 下
    ctx.fillStyle = "#FBF6EC"; ctx.strokeStyle = "#D9CFB8"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, s * 0.4, s * 0.62, s * 0.26, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // 餅 上
    ctx.beginPath();
    ctx.ellipse(0, s * 0.05, s * 0.46, s * 0.22, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // 橙(だいだい)
    ctx.fillStyle = "#FF9A3C";
    ctx.beginPath();
    ctx.arc(0, -s * 0.35, s * 0.26, 0, Math.PI * 2);
    ctx.fill();
    // 葉
    ctx.fillStyle = C.leafDark;
    ctx.beginPath();
    ctx.ellipse(s * 0.1, -s * 0.6, s * 0.18, s * 0.07, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  #tMallet(ctx, s) {
    ctx.save();
    ctx.rotate(-0.4);
    // 柄
    ctx.fillStyle = "#8A5A2B";
    ctx.fillRect(-s * 0.08, -s * 0.1, s * 0.16, s * 1.1);
    // 頭(金)
    const g = ctx.createLinearGradient(-s, -s, s, 0);
    g.addColorStop(0, "#FFE08A"); g.addColorStop(1, "#D79A2E");
    ctx.fillStyle = g;
    ctx.strokeStyle = "#A9781E"; ctx.lineWidth = 1.2;
    this.#roundRect(ctx, -s * 0.6, -s * 0.7, s * 1.2, s * 0.8, s * 0.18);
    ctx.fill(); ctx.stroke();
    // 帯
    ctx.fillStyle = "#B8322A";
    ctx.fillRect(-s * 0.6, -s * 0.4, s * 1.2, s * 0.12);
    ctx.restore();
  }

  #roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  #sparkles(ctx, s) {
    ctx.fillStyle = "rgba(255,240,180,.9)";
    const pts = [[-s * 1.1, -s * 0.6], [s * 1.15, -s * 0.2], [s * 0.9, s * 0.7], [-s * 0.95, s * 0.5]];
    for (const [px, py] of pts) {
      const r = s * 0.12;
      ctx.beginPath();
      ctx.moveTo(px, py - r); ctx.lineTo(px + r * 0.3, py - r * 0.3);
      ctx.lineTo(px + r, py); ctx.lineTo(px + r * 0.3, py + r * 0.3);
      ctx.lineTo(px, py + r); ctx.lineTo(px - r * 0.3, py + r * 0.3);
      ctx.lineTo(px - r, py); ctx.lineTo(px - r * 0.3, py - r * 0.3);
      ctx.closePath(); ctx.fill();
    }
  }
}

customElements.define("gourd-progress", GourdProgress);
export { GourdProgress };
