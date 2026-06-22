/**
 * <goat-progress> — ヤギが草むらを端から食べていく進捗表現(毒草よけゲーム付き)
 *
 * 進捗モデル(正直設計):
 *   value(実進捗)   … 外部から流し込む唯一の入力。
 *   eaten(表示)      … ヤギが食べ進んだ境界。value へ滑らかに追従(displayValue)。
 *
 * 遊び:
 *   草むらにたまに「紫の毒草」が生える。ヤギがそこまで食べ進むと口にして、
 *   少しずつ具合が悪くなる(体調メーターが下がり、見た目も悪化)。
 *   毒草を クリック/タップ で抜いてあげると、ヤギは無事に食べ進める。
 *   体調・毒は演出レイヤーで、進捗には一切影響しない。
 *
 * 使い方:
 *   <script type="module" src="variants/goat/goat-progress.js"></script>
 *   <goat-progress id="gp"></goat-progress>
 *   <script> gp.value = serverProgress; </script>
 *
 * 属性:
 *   value         実進捗 0–100
 *   height        表示高さpx (default 360)
 *   demo          "smooth" | "step"  自走デモ(本番では使わない)
 *   duration      demoモードの所要ms (default 18000)
 *   poison-rate   毒草の出やすさ係数 (default 1。0で毒草なし)
 *
 * プロパティ/メソッド:
 *   .value / .displayValue(=食べ進み) / .health(体調 0–1, 読み取り専用)
 *   .steps  進捗しきい値ごとのラベル / .note  任意の一行コメント
 *   .reset()
 *
 * イベント:
 *   "complete"        食べ進みが100%に到達(1回)
 *   "poison-eaten"    ヤギが毒草を口にした
 *   "poison-removed"  毒草を抜いて取り除いた
 *
 * 依存: なし(canvasのみ)
 */
import { ProgressBase } from "../../core/progress-base.js";

const C = {
  edge: "#332D63", muted: "#8F89BC", accent: "#FFB454", good: "#7BE3A8", bad: "#FF6B7B",
  sky1: "#241F4A", sky2: "#191534",
  ground: "#4A3A2E", dirt: "#5A4632",
  grass: "#5FB85A", grassDark: "#3C8C42", grassLight: "#86Dc72", stubble: "#3F8C46",
  goat: "#EFE9DA", goatShade: "#CFC7B2", goatSick: "#A6C16A", horn: "#C9B68A",
  hoof: "#3A3045", beard: "#FBF7EC",
  poison: "#B05BE0", poisonDark: "#6E2E9E", poisonLeaf: "#8E43C8",
};

const DEFAULT_STEPS = [
  { label: "放牧開始", until: 8 },
  { label: "もぐもぐ", until: 35 },
  { label: "食べ盛り", until: 65 },
  { label: "おなかいっぱい", until: 92 },
  { label: "完食", until: 100 },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// ---- 毒草ゲームの調整値
const POISON_MIN = 1400;     // 毒草の最短スポーン間隔ms
const POISON_MAX = 3200;     // 最長
const POISON_LEAD = 0.05;    // ヤギの先(t)どれだけ前方に生やすか
const POISON_MAX_ON = 4;     // 同時に出る上限
const SICK_PER_BITE = 0.26;  // 毒草1本でどれだけ具合が悪くなるか
const RECOVER_RATE = 0.05;   // 1秒あたりの自然回復(0..1)

const TEMPLATE = `
<style>
  :host { display: block; height: 360px; }
  .stage {
    position: relative; width: 100%; height: 100%;
    background: linear-gradient(180deg, ${C.sky1} 0%, ${C.sky2} 100%);
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

class GoatProgress extends ProgressBase {
  static get observedAttributes() {
    return ["value", "height"];
  }

  // ---- 設定
  steps = DEFAULT_STEPS;
  note = "";
  poisonRate = 1;

  // ---- 内部状態
  #eaten = 0;          // 表示上の食べ進み 0–100
  #sick = 0;           // 具合の悪さ 0–1
  #demoTimer = 0;
  #blades = [];        // 草 { t, h, phase, tone }
  #poison = [];        // 毒草 { t, grow, state:"sprout"|"pulled", pull }
  #munch = [];         // 食べカス { x, y, vx, vy, life, color }
  #spawnAt = 0;        // 次の毒草スポーン残りms
  #chew = 0;           // 咀嚼位相
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
  }

  // ================================================================ lifecycle
  connectedCallback() {
    if (this.hasAttribute("height"))
      this.style.height = parseInt(this.getAttribute("height")) + "px";
    if (this.hasAttribute("poison-rate"))
      this.poisonRate = parseFloat(this.getAttribute("poison-rate"));

    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(this);
    this.#resize();
    this.#buildField();
    this.#spawnAt = POISON_MIN;

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
    return this.#eaten;
  }
  get health() {
    return 1 - this.#sick;
  }

  reset() {
    this.value = 0;
    this.#eaten = 0;
    this.#sick = 0;
    this.#demoTimer = 0;
    this.#poison = [];
    this.#munch = [];
    this.#spawnAt = POISON_MIN;
    this.#buildField();
    this.resetCompleted();
  }

  // ================================================================ internals
  #resize() {
    const r = this.$cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.$cv.width = r.width * this.#dpr;
    this.$cv.height = r.height * this.#dpr;
  }

  #buildField() {
    const r = this.$cv.getBoundingClientRect();
    const n = Math.max(40, Math.round(r.width / 5));
    this.#blades = Array.from({ length: n }, (_, i) => ({
      t: (i + 0.5) / n + (Math.random() - 0.5) * (0.4 / n),
      h: 0.62 + Math.random() * 0.38,        // 草丈(grassH比)
      phase: Math.random() * Math.PI * 2,
      tone: Math.random(),
    }));
  }

  // 草むらの幾何
  #field() {
    const r = this.$cv.getBoundingClientRect();
    const w = r.width, h = r.height;
    const pad = 14;
    const groundY = h - 30;
    const grassH = Math.min(h * 0.4, 110);
    const left = pad, right = w - pad, width = right - left;
    return { w, h, pad, groundY, grassH, left, right, width };
  }

  #frontier() {
    return this.#eaten / 100;   // 0..1(食べ済みの右端)
  }

  #wirePointer() {
    const pull = (e) => {
      const r = this.$cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const f = this.#field();
      let hit = null, best = 22 * 22;
      for (const p of this.#poison) {
        if (p.state !== "sprout") continue;
        const px = f.left + p.t * f.width;
        const py = f.groundY - f.grassH * 0.5 * p.grow;
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < best) { best = d; hit = p; }
      }
      if (hit) this.#removePoison(hit);
    };
    this.$cv.addEventListener("pointerdown", pull);
  }

  #removePoison(p) {
    p.state = "pulled";
    p.pull = 0;
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
      const sp = 1.5 + Math.random() * 2;
      this.#munch.push({
        x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, color: C.poison, _p: p,
      });
    }
    this.dispatchEvent(new CustomEvent("poison-removed", { bubbles: true }));
  }

  #spawnPoison() {
    if (this.poisonRate <= 0) return;
    const live = this.#poison.filter((p) => p.state === "sprout").length;
    if (live >= POISON_MAX_ON) return;
    const lo = this.#frontier() + POISON_LEAD;
    const hi = 0.97;
    if (lo >= hi) return;
    const t = lo + Math.random() * (hi - lo);
    this.#poison.push({ t, grow: 0, state: "sprout", pull: 0 });
  }

  // ================================================================ main loop
  #loop(now) {
    const dtMs = Math.min(40, now - this.#last);
    this.#last = now;
    const dt = dtMs / 16.67;
    this.#clock += dtMs;

    // ---- demoモード
    const demo = this.getAttribute("demo");
    if (demo && this.value < 100) {
      const dur = parseFloat(this.getAttribute("duration")) || 18000;
      if (demo === "step") {
        this.#demoTimer += dtMs;
        if (this.#demoTimer >= dur / 10) { this.#demoTimer = 0; this.value = Math.min(100, this.value + 10); }
      } else {
        this.value = Math.min(100, this.value + (dtMs / dur) * 100);
      }
    }

    // ---- 食べ進みを value へ滑らかに追従
    this.#eaten += (this.value - this.#eaten) * (1 - Math.pow(0.92, dt));
    if (this.value >= 100 && this.#eaten > 99.6) this.#eaten = 100;
    if (Math.abs(this.value - this.#eaten) < 0.05) this.#eaten = this.value;
    const frontier = this.#frontier();

    // ---- 毒草スポーン
    if (this.value < 100) {
      this.#spawnAt -= dtMs * this.poisonRate;
      if (this.#spawnAt <= 0) {
        this.#spawnPoison();
        this.#spawnAt = POISON_MIN + Math.random() * (POISON_MAX - POISON_MIN);
      }
    }

    // ---- 毒草の更新(発芽アニメ / ヤギに食べられる / 抜かれた)
    const f = this.#field();
    this.#poison = this.#poison.filter((p) => {
      if (p.state === "pulled") {
        p.pull += 0.06 * dt;
        return p.pull < 1;
      }
      p.grow = Math.min(1, p.grow + 0.05 * dt);
      // ヤギの口(食べ進み境界)が毒草に到達 → 食べてしまう
      if (frontier >= p.t - 0.004) {
        this.#sick = Math.min(1, this.#sick + SICK_PER_BITE);
        const px = f.left + p.t * f.width;
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          this.#munch.push({
            x: px, y: f.groundY - 14, vx: Math.cos(a) * 1.6, vy: Math.sin(a) * 1.6 - 1,
            life: 1, color: C.poisonDark,
          });
        }
        this.dispatchEvent(new CustomEvent("poison-eaten", { bubbles: true }));
        return false;
      }
      return true;
    });

    // ---- 体調は少しずつ自然回復
    if (this.#sick > 0) this.#sick = Math.max(0, this.#sick - RECOVER_RATE * (dtMs / 1000));

    // ---- 食べカス・抜いた毒草の粒
    this.#munch = this.#munch.filter((m) => {
      if (m._p) { m.x = f.left + m._p.t * f.width; m.y = f.groundY - f.grassH * 0.4 - m._p.pull * 26; }
      m.x += m.vx * dt; m.y += m.vy * dt; m.vy += 0.12 * dt; m.life -= 0.03 * dt;
      return m.life > 0;
    });

    // ---- 咀嚼
    this.#chew += dt * 0.25;

    if (this.#eaten >= 100) this.emitComplete();

    this.#render(f, frontier);
    this.$stage.classList.toggle("done", this.#eaten >= 100);
  }

  // ================================================================ render
  #render(f, frontier) {
    const ctx = this.ctx;
    if (f.w < 10 || f.h < 10) return;
    ctx.save();
    ctx.scale(this.#dpr, this.#dpr);
    ctx.clearRect(0, 0, f.w, f.h);

    // 地面
    ctx.fillStyle = C.ground;
    ctx.fillRect(0, f.groundY, f.w, f.h - f.groundY);
    ctx.fillStyle = "rgba(0,0,0,.15)";
    ctx.fillRect(0, f.groundY, f.w, 3);

    // 草むら(食べ済みは刈り跡、未食は伸びた草)
    this.#drawGrass(ctx, f, frontier);

    // 毒草
    for (const p of this.#poison) this.#drawPoison(ctx, f, p);

    // 食べカス
    for (const m of this.#munch) {
      ctx.globalAlpha = Math.max(0, m.life);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ヤギ
    const goatX = f.left + frontier * f.width;
    this.#drawGoat(ctx, f, goatX);

    // HUD
    this.#drawHud(ctx, f);

    ctx.restore();
  }

  #drawGrass(ctx, f, frontier) {
    const sway = Math.sin(this.#clock * 0.002);
    for (const b of this.#blades) {
      const x = f.left + b.t * f.width;
      const eaten = b.t < frontier;
      const baseH = f.grassH * b.h;
      const h = eaten ? Math.min(7, baseH) : baseH;     // 食べ跡は短い刈り株
      const tip = h * (eaten ? 0.2 : 1);
      const bend = (eaten ? 1.5 : 7) * (sway + Math.sin(this.#clock * 0.003 + b.phase) * 0.5);
      const col = eaten ? C.stubble
        : (b.tone < 0.33 ? C.grassDark : b.tone < 0.7 ? C.grass : C.grassLight);
      ctx.strokeStyle = col;
      ctx.lineWidth = eaten ? 2 : 2.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, f.groundY);
      ctx.quadraticCurveTo(x + bend * 0.5, f.groundY - tip * 0.6, x + bend, f.groundY - tip);
      ctx.stroke();
    }
  }

  #drawPoison(ctx, f, p) {
    const x = f.left + p.t * f.width;
    const pull = p.state === "pulled" ? p.pull : 0;
    const grow = p.state === "pulled" ? 1 : easeOut(p.grow);
    const H = f.grassH * 0.62 * grow;
    const alpha = p.state === "pulled" ? 1 - pull : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, f.groundY - pull * 30);
    ctx.rotate(pull * 0.5);

    // 妖しい後光(脈動)
    const pulse = 0.5 + 0.5 * Math.sin(this.#clock * 0.006 + p.t * 9);
    const haloR = 16 + 6 * pulse;
    const halo = ctx.createRadialGradient(0, -H * 0.6, 2, 0, -H * 0.6, haloR);
    halo.addColorStop(0, `rgba(190,100,235,${0.35 + 0.25 * pulse})`);
    halo.addColorStop(1, "rgba(190,100,235,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, -H * 0.6, haloR, 0, Math.PI * 2);
    ctx.fill();

    // 毒々しい葉(3枚)
    for (const d of [-1, 0, 1]) {
      ctx.strokeStyle = d === 0 ? C.poison : C.poisonLeaf;
      ctx.lineWidth = 3.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(d * 10, -H * 0.6, d * 14, -H * (0.9 + 0.05 * d));
      ctx.stroke();
    }
    // 実(毒の粒)
    ctx.fillStyle = C.poisonDark;
    for (const [dx, dy] of [[-5, 0.82], [5, 0.74], [0, 0.95]]) {
      ctx.beginPath();
      ctx.arc(dx, -H * dy, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.beginPath();
    ctx.arc(-1, -H * 0.95 - 1.5, 1.4, 0, Math.PI * 2);
    ctx.fill();

    // 泡(危険サイン)
    if (p.state === "sprout") {
      ctx.fillStyle = `rgba(200,130,240,${0.5 + 0.4 * pulse})`;
      ctx.beginPath();
      ctx.arc(7, -H - 6 - pulse * 4, 2, 0, Math.PI * 2);
      ctx.arc(-6, -H - 12 - pulse * 6, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 横向きヤギ(右へ食べ進む)。具合が悪いほど緑がかってフラフラする */
  #drawGoat(ctx, f, mouthX) {
    const gs = clamp(f.width * 0.13, 46, 78);
    const sick = this.#sick;
    const done = this.#eaten >= 100;
    const bob = Math.sin(this.#clock * 0.008) * (1 + sick * 3);   // 具合が悪いと揺れる
    const cx = mouthX - gs * 0.52;                                // 体の中心(口より左)
    const legY = f.groundY;
    const bodyCY = legY - gs * 0.5 + bob;
    const body = lerp(0, 1, sick);
    const skin = this.#mix(C.goat, C.goatSick, body * 0.8);
    const shade = this.#mix(C.goatShade, C.goatSick, body * 0.8);

    ctx.save();
    ctx.translate(cx, bodyCY);

    // 脚(前後2本ずつ。歩く動き)
    ctx.strokeStyle = shade; ctx.lineWidth = gs * 0.1; ctx.lineCap = "round";
    const step = done ? 0 : Math.sin(this.#chew * 2);
    for (const [i, lx] of [[0, -0.3], [1, -0.16], [2, 0.2], [3, 0.34]]) {
      const kick = Math.sin(this.#chew * 2 + i) * (done ? 0 : 3);
      ctx.beginPath();
      ctx.moveTo(lx * gs, gs * 0.12);
      ctx.lineTo(lx * gs + kick * 0.3, legY - bodyCY);
      ctx.stroke();
    }

    // 胴
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(0, 0, gs * 0.5, gs * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    // 腹の陰
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(0, gs * 0.12, gs * 0.44, gs * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // しっぽ
    ctx.strokeStyle = skin; ctx.lineWidth = gs * 0.08;
    ctx.beginPath();
    ctx.moveTo(-gs * 0.48, -gs * 0.08);
    ctx.lineTo(-gs * 0.6, -gs * 0.2 - (done ? 6 : 0));
    ctx.stroke();

    // 頭(右下、草を食べる姿勢。完食したら持ち上げる)
    const headDown = done ? -gs * 0.22 : gs * 0.16 + Math.sin(this.#chew) * gs * 0.03;
    const hx = gs * 0.46, hy = headDown;
    ctx.save();
    ctx.translate(hx, hy);

    // 角
    ctx.strokeStyle = C.horn; ctx.lineWidth = gs * 0.07; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-gs * 0.02, -gs * 0.2);
    ctx.quadraticCurveTo(gs * 0.16, -gs * 0.28, gs * 0.12, -gs * 0.06);
    ctx.stroke();
    // 耳
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(-gs * 0.12, -gs * 0.12, gs * 0.12, gs * 0.06, -0.5, 0, Math.PI * 2);
    ctx.fill();
    // 顔
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(gs * 0.05, 0, gs * 0.2, gs * 0.16, 0.2, 0, Math.PI * 2);
    ctx.fill();
    // 鼻先
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(gs * 0.22, gs * 0.04, gs * 0.08, gs * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    // あごひげ(もぐもぐで揺れる)
    ctx.fillStyle = C.beard;
    ctx.save();
    ctx.translate(gs * 0.1, gs * 0.14);
    ctx.rotate(Math.sin(this.#chew) * 0.25);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-gs * 0.05, gs * 0.18);
    ctx.lineTo(gs * 0.05, gs * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // 目(具合が悪いと "@" 風のぐるぐる/半目)
    this.#drawGoatEye(ctx, gs * 0.02, -gs * 0.04, gs, sick);

    ctx.restore(); // head

    // 具合が悪いときの汗・顔まわりの病気バブル
    if (sick > 0.15) {
      ctx.fillStyle = `rgba(120,200,120,${0.4 + sick * 0.4})`;
      const t = this.#clock * 0.004;
      for (let i = 0; i < 3; i++) {
        const yy = -gs * 0.5 - ((t * 14 + i * 12) % 30);
        ctx.beginPath();
        ctx.arc(hx + gs * 0.1 + i * 4 - 4, hy + yy, 2 + i * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // 汗
      ctx.fillStyle = "rgba(150,200,255,.9)";
      ctx.beginPath();
      ctx.ellipse(hx - gs * 0.16, hy - gs * 0.1, 2, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  #drawGoatEye(ctx, x, y, gs, sick) {
    if (sick > 0.55) {
      // ぐるぐる目(かなり具合が悪い)
      ctx.strokeStyle = "#2A2218"; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 4; a += 0.3) {
        const rr = 1 + a * 0.5;
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else if (sick > 0.25) {
      // 半目(ぐったり)
      ctx.strokeStyle = "#2A2218"; ctx.lineWidth = 1.6; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - gs * 0.05, y);
      ctx.lineTo(x + gs * 0.05, y);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#2A2218";
      ctx.beginPath();
      ctx.arc(x, y, gs * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #drawHud(ctx, f) {
    // % (中央上)
    ctx.font = "600 22px ui-monospace, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = this.#eaten >= 100 ? C.good : C.muted;
    ctx.fillText(Math.floor(this.value) + "%", f.w / 2, 26);

    // ステップ / note(左上)
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    const step = this.steps.find((s) => this.value <= s.until) || this.steps[this.steps.length - 1];
    if (step) { ctx.fillStyle = this.#eaten >= 100 ? C.good : C.accent; ctx.fillText(step.label, 12, 20); }
    if (this.note) { ctx.fillStyle = C.muted; ctx.fillText(this.note, 12, 36); }

    // 体調バー(右上)
    const bw = 92, bh = 9, bx = f.w - 12 - bw, by = 14;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right"; ctx.fillStyle = C.muted;
    ctx.fillText("たいちょう", bx - 6, by + bh);
    ctx.fillStyle = "rgba(255,255,255,.12)";
    this.#roundRect(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
    const hp = this.health;
    const col = hp > 0.6 ? C.good : hp > 0.3 ? C.accent : C.bad;
    ctx.fillStyle = col;
    if (hp > 0.001) { this.#roundRect(ctx, bx, by, bw * hp, bh, bh / 2); ctx.fill(); }
  }

  #roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  // 色の線形補間("#rrggbb" 同士)
  #mix(a, b, t) {
    t = clamp(t, 0, 1);
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
    const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
    const bl = Math.round(lerp(pa & 255, pb & 255, t));
    return `rgb(${r},${g},${bl})`;
  }
}

customElements.define("goat-progress", GoatProgress);
export { GoatProgress };
