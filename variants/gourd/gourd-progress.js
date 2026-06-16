/**
 * <gourd-progress> — ひょうたんのつるが伸びる進捗表現
 *
 * 進捗モデル(正直設計):
 *   value(実進捗)   … 外部から流し込む唯一の入力。
 *   grown(表示)      … つるの伸び。value へ滑らかに追従(displayValue)。
 *   完了フィナーレ    … grown=100 後、未開封の実を自動でぱかっと割って必ず締める。
 *
 * 遊び:
 *   つるの要所に「ひょうたんの実」が生る。クリックすると腰のくびれで
 *   ぱかっと割れ、中からめでたいもの(小判/達磨/富士/宝珠/鏡餅/小槌)が出てくる。
 *   この開封は進捗には一切影響しない(表示は実進捗に正直)。
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
 *   finale-delay  完了後、未開封の実を自動開封するまでの猶予ms (default 3500)
 *
 * プロパティ/メソッド:
 *   .value / .displayValue(=つるの伸び)
 *   .steps  進捗しきい値ごとのラベル [{label, until}, …]
 *   .note   進捗とは独立した任意の一行コメント
 *   .openAll()  未開封の実をすべて割る   .reset()
 *
 * イベント:
 *   "complete"     つるが100%に到達したとき(1回)
 *   "gourd-open"   実が割れたとき(detail: { treasure })
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

// つるの要所に生る実。until=つるが何%伸びたら現れるか。
const DEFAULT_GOURDS = [16, 34, 52, 70, 88];
const TREASURES = ["koban", "daruma", "fuji", "houju", "kagami", "mallet"];

// つるに沿って葉を出す位置(つるの伸びが届くと展開)
const LEAF_STOPS = [0.1, 0.24, 0.4, 0.58, 0.74, 0.9];

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
  finaleDelay = 3500;

  // ---- 内部状態
  #grown = 0;
  #fruits = [];      // { tPct, type, appear, state, crack, pop, sx, sy, sr, spark[] }
  #leaves = [];      // { t, grow }
  #demoTimer = 0;
  #completeAt = 0;
  #finaleStarted = false;

  #wave = [];            // つるの蛇行を決めるランダムな倍音 [{freq, amp, phase}]

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
    if (this.hasAttribute("finale-delay"))
      this.finaleDelay = parseFloat(this.getAttribute("finale-delay")) || this.finaleDelay;

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

  /** 進捗・つる・実をすべて初期状態に戻す */
  reset() {
    this.value = 0;
    this.#grown = 0;
    this.#demoTimer = 0;
    this.#completeAt = 0;
    this.#finaleStarted = false;
    this.#buildFruits();
    this.#genWave();   // うねりも引き直す
    for (const l of this.#leaves) l.grow = 0;
    this.resetCompleted();
  }

  /** 出現済みで未開封の実をすべて割る */
  openAll() {
    for (const f of this.#fruits)
      if (f.appear > 0.6 && f.state === "idle") this.#openFruit(f);
  }

  /** 実進捗が外から巻き戻されたら、その分つるも縮む(正直設計) */
  onValueChanged(v) {
    if (v < 100) {
      this.#completeAt = 0;
      this.#finaleStarted = false;
    }
  }

  // ================================================================ internals
  #buildFruits() {
    this.#fruits = DEFAULT_GOURDS.map((tPct, i) => ({
      tPct,
      type: TREASURES[i % TREASURES.length],
      appear: 0,           // 0→1 出現アニメ
      state: "hidden",     // hidden → idle → opening
      crack: 0,            // 0→1 割れ進行
      pop: 0,              // 0→1 中身の登場
      sx: 0, sy: 0, sr: 0, // 当たり判定用(描画時に更新)
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
    const toLocal = (e) => {
      const r = this.$cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const hit = (x, y) =>
      this.#fruits.find(
        (f) => f.state === "idle" && f.appear > 0.6 &&
          Math.hypot(x - f.sx, y - f.sy) <= f.sr
      );
    this.$cv.addEventListener("pointerdown", (e) => {
      const [x, y] = toLocal(e);
      const f = hit(x, y);
      if (f) this.#openFruit(f);
    });
    this.$cv.addEventListener("pointermove", (e) => {
      const [x, y] = toLocal(e);
      this.$cv.style.cursor = hit(x, y) ? "pointer" : "default";
    });
  }

  #openFruit(f) {
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

  // ================================================================ main loop
  #loop(now) {
    const dtMs = Math.min(40, now - this.#last);
    this.#last = now;
    const dt = dtMs / 16.67;

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

    // ---- 実の出現・開封アニメ
    for (const f of this.#fruits) {
      const visible = this.#grown >= f.tPct + 0.5;
      const targetAppear = visible ? 1 : 0;
      f.appear += (targetAppear - f.appear) * (1 - Math.pow(0.82, dt));
      if (f.state === "hidden" && f.appear > 0.6) f.state = "idle";
      if (f.state === "idle" && !visible && f.appear < 0.4) f.state = "hidden";

      if (f.state === "opening") {
        f.crack = Math.min(1, f.crack + 0.05 * dt);
        if (f.crack > 0.28) f.pop = Math.min(1, f.pop + 0.045 * dt);
      }
      // 火花の更新
      f.spark = f.spark.filter((s) => {
        s.x += s.vx * dt; s.y += s.vy * dt;
        s.vy += 0.12 * dt; s.life -= 0.03 * dt;
        return s.life > 0;
      });
    }

    // ---- 完了フィナーレ: 放置しても未開封の実を自動で割って必ず締める
    if (this.#grown >= 100) {
      this.emitComplete();
      if (!this.#completeAt) this.#completeAt = now;
      if (!this.#finaleStarted && now - this.#completeAt > this.finaleDelay) {
        this.#finaleStarted = true;
        // 下から順にぱかっぱかっと
        const pending = this.#fruits.filter((f) => f.state === "idle");
        pending.forEach((f, i) => setTimeout(() => {
          if (f.state === "idle") this.#openFruit(f);
        }, i * 420));
      }
    }

    this.#render();
    this.$stage.classList.toggle("done", this.#grown >= 100);
  }

  // ================================================================ render
  #render() {
    const ctx = this.ctx;
    const g = this.#geom();
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

    // % 表示
    ctx.font = "600 30px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = this.#grown >= 100 ? C.good : C.muted;
    ctx.fillText(Math.floor(this.value) + "%", g.cx, g.h - 22);

    // ステップラベル / 任意コメント
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
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.fillText("実をクリック", g.w - 12, 20);

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

    // 当たり判定(描画ごとに更新)
    f.sx = cx; f.sy = (topC + botC) / 2; f.sr = rb * 1.45;

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

    // 中身(割れた後に大きくズームしてせり上がる。文字は出さない)
    if (f.pop > 0.01) {
      const ts = rb * (1.4 + 2.0 * easeOut(f.pop));        // 大きく拡大
      const ty = waistY - rb * 0.4 - f.pop * (rb * 1.4 + ts);
      this.#drawTreasure(ctx, f.type, cx, ty, ts, Math.min(1, f.pop * 1.6));
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
  #drawTreasure(ctx, type, x, y, s, alpha) {
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(x, y);
    // ほのかな後光
    const halo = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 1.6);
    halo.addColorStop(0, "rgba(255,220,140,.45)");
    halo.addColorStop(1, "rgba(255,220,140,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, s * 1.6, 0, Math.PI * 2);
    ctx.fill();

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
