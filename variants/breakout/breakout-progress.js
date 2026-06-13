/**
 * <breakout-progress> — ブロック崩し型プログレスバーゲーム
 *
 * 進捗モデル(正直設計 / core/progress-base.js の契約に従う):
 *   value(実進捗)        … 外部から流し込む。ボールの投入数を決める。
 *   clearedValue(破壊済み) … 表示進捗 = 破壊ブロック / 全ブロック。value に遅延追従。
 *
 * 正直契約の要点:
 *   - ブロックは最初からすべて破壊可能。硬さ(HP)があり、ボールが当たるたび
 *     ひびが入り、HP=0 で破壊される。
 *   - ただし破壊の「確定」は実進捗で頭打ちにする(破壊済み ≤ value 相当)。
 *     HP=0 になっても実進捗が追いつくまでは砕けず、ひび割れたまま留まる。
 *     これにより表示は実進捗を超えない。難易度は「ボール数 × 硬さ」で調整する。
 *   - 放置対策が二重: ① 外したボールは中央から再投入される(進捗を失わない)
 *     ② 完了フラッシュで残ブロックを一斉破壊(フィナーレ)。
 *   - パドルは「進捗を早める/気持ちよくする」操作。触らなくても必ず完走する。
 *
 * 使い方:
 *   <script type="module" src="variants/breakout/breakout-progress.js"></script>
 *   <breakout-progress id="bp"></breakout-progress>
 *   <script> bp.value = serverProgress; </script>
 *
 * 属性:
 *   value / height / demo("smooth"|"step") / duration
 *   max-balls    同時に飛ぶボールの最大数 (default 28)
 *   rows         ブロックの段数 (default 6)
 *   brick-hp     ブロックの硬さ=破壊に要する命中数 (default 2)
 *   flush-delay  完了フラッシュまでの猶予ms (default 2500)
 *
 * プロパティ:
 *   .value / .clearedValue
 *   .steps  進捗しきい値ごとのラベル [{label, until}, …]
 *   .note   進捗とは独立した任意の一行コメント("xxxをしています…")
 *
 * イベント: "complete"(表示進捗100%到達時に1回)
 * 依存: なし(物理は自前。Matter.js 不要)
 */
import { ProgressBase } from "../../core/progress-base.js";

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
  accent: "#FFB454", good: "#7BE3A8", text: "#2C2752",
  paddle: "#FFB454", ball: "#FFE9B0",
};
// 段ごとのブロック色(暖→寒。progress-lab のパレットに揃える)
const ROW_COLORS = ["#FF7A6B", "#FF9B5A", "#FFD25F", "#7BE3A8", "#6F8DFF", "#A39BFF"];

// ---- 調整値
const BALL_SPEED = 4.3;       // ボール速度 px/frame(60fps基準)。一定に保つ
const BALL_R = 5.5;           // ボール半径px
const PADDLE_H = 11;          // パドル厚px
const BRICK_GAP = 3;          // ブロック間の隙間px
const IDEAL_CELL = 34;        // 1ブロックの目標幅px(列数の算出に使う)
const SPAWN_INTERVAL = 150;   // ボール投入の最小間隔ms(どんどん増える演出)
const RESPAWN_DELAY = 650;    // 場外に落ちたボールが再投入されるまでのms
const FLUSH_PER_FRAME = 3;    // 完了フラッシュ時に1フレームで砕く残ブロック数

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
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: none; }
</style>
<div class="stage" part="stage"><canvas id="cv"></canvas></div>
`;

class BreakoutProgress extends ProgressBase {
  static get observedAttributes() {
    return ["value", "height"];
  }

  maxBalls = 28;
  rows = 6;
  brickHp = 2;
  flushDelay = 2500;
  steps = DEFAULT_STEPS;
  /** 進捗とは独立した任意の一行コメント。"xxxをしています…" 等を即時表示 */
  note = "";

  #cleared = 0;        // 表示進捗(破壊ブロック割合)
  #bricks = [];        // { cx, cy, w, h, r, c, hp, maxHp, broken }
  #brokenOrder = [];   // 破壊された順(巻き戻し復活に使う)
  #total = 0;          // 全ブロック数
  #broken = 0;         // 破壊済み数
  #cols = 0;

  #balls = [];         // { x, y, vx, vy, dead, respawnAt }
  #particles = [];     // { x, y, vx, vy, size, color, life }
  #paddleX = 0.5;      // パドル中心の正規化x (0–1)
  #paddleFlash = 0;
  #lastSpawn = 0;
  #demoTimer = 0;
  #flushAt = 0;

  #raf = 0;
  #last = 0;
  #dpr = 1;
  #ro = null;
  #built = false;

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
    if (this.hasAttribute("max-balls"))
      this.maxBalls = parseInt(this.getAttribute("max-balls")) || this.maxBalls;
    if (this.hasAttribute("rows"))
      this.rows = clamp(parseInt(this.getAttribute("rows")) || this.rows, 2, 10);
    if (this.hasAttribute("brick-hp"))
      this.brickHp = clamp(parseInt(this.getAttribute("brick-hp")) || this.brickHp, 1, 9);
    if (this.hasAttribute("flush-delay"))
      this.flushDelay = parseFloat(this.getAttribute("flush-delay")) || this.flushDelay;

    this.$cv.addEventListener("pointermove", (e) => this.#onPointer(e));
    this.$cv.addEventListener("pointerdown", (e) => {
      this.$cv.setPointerCapture?.(e.pointerId);
      this.#onPointer(e);
    });

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
  }

  attributeChangedCallback(name, old, val) {
    super.attributeChangedCallback(name, old, val);
    if (name === "height" && val != null)
      this.style.height = parseInt(val) + "px";
  }

  // ================================================================ public API
  get clearedValue() {
    return this.#cleared;
  }
  get displayValue() {
    return this.#cleared;
  }

  /** 進捗・ボール・ブロックを初期化し、壁を組み直す */
  reset() {
    this.value = 0;
    this.#cleared = 0;
    this.#broken = 0;
    this.#brokenOrder = [];
    this.#balls = [];
    this.#particles = [];
    this.#flushAt = 0;
    this.#demoTimer = 0;
    this.#buildField();
    this.resetCompleted();
  }

  /** 実進捗が外から巻き戻された場合のみスクラブ扱いで同期 */
  onValueChanged(v, prev) {
    if (v < prev - 1e-6) {
      // 破壊枠を下げ、はみ出した分を破壊順の新しい方から復活(表示 ≤ 実進捗 を保つ)
      const budget = Math.floor((v / 100) * this.#total + 1e-9);
      while (this.#brokenOrder.length > budget) {
        const b = this.#brokenOrder.pop();
        b.broken = false;
        b.hp = b.maxHp;
      }
      this.#recount();
      // ボールも実進捗相応の数まで間引く
      const target = this.#ballTarget(v);
      if (this.#balls.length > target) this.#balls.length = target;
      this.#flushAt = 0;
      if (v < 100) this.resetCompleted();
    }
  }

  // ================================================================ internals
  #vessel() {
    const r = this.$cv.getBoundingClientRect();
    const pad = 16;
    return {
      w: r.width, h: r.height,
      vx: pad, vy: pad + 10,
      vw: r.width - pad * 2, vh: r.height - (pad + 10) - pad,
    };
  }

  #resize() {
    const r = this.$cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.$cv.width = r.width * this.#dpr;
    this.$cv.height = r.height * this.#dpr;
    if (!this.#built) this.#buildField();
    else this.#layoutField(); // 既存の破壊状態を保ったまま座標だけ再計算
  }

  /** 列数を確定してブロックを新規生成(破壊状態は全クリア) */
  #buildField() {
    const { vw } = this.#vessel();
    this.#cols = Math.max(4, Math.round((vw - 4) / IDEAL_CELL));
    this.#total = this.#cols * this.rows;
    this.#bricks = [];
    this.#brokenOrder = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.#cols; c++) {
        this.#bricks.push({
          c, r, hp: this.brickHp, maxHp: this.brickHp,
          broken: false, cx: 0, cy: 0, w: 0, h: 0,
        });
      }
    }
    this.#built = true;
    this.#broken = 0;
    this.#layoutField();
  }

  /** 現在のキャンバスサイズに合わせてブロックの座標を計算(状態は保持) */
  #layoutField() {
    const { vx, vy, vw } = this.#vessel();
    const fieldX = vx + 6;
    const fieldY = vy + 22;          // 上端に投入口/ラベルの余白
    const fieldW = vw - 12;
    const cellW = fieldW / this.#cols;
    const cellH = Math.max(13, cellW * 0.42);
    for (const b of this.#bricks) {
      b.w = cellW - BRICK_GAP;
      b.h = cellH - BRICK_GAP;
      b.cx = fieldX + b.c * cellW + cellW / 2;
      b.cy = fieldY + b.r * cellH + cellH / 2;
    }
  }

  #recount() {
    this.#broken = this.#bricks.reduce((n, b) => n + (b.broken ? 1 : 0), 0);
    this.#cleared = this.#total ? (this.#broken / this.#total) * 100 : 0;
  }

  #ballTarget(v) {
    if (v <= 0) return 0;
    return clamp(Math.round(1 + (v / 100) * (this.maxBalls - 1)), 1, this.maxBalls);
  }

  #onPointer(e) {
    const r = this.$cv.getBoundingClientRect();
    this.#paddleX = clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  /** 中ほどの高さから上へ向けてボールを射出(左右にわずかな散らばり) */
  #launchBall(ball) {
    const { vx, vy, vw, vh } = this.#vessel();
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.0; // 真上から±約29°
    ball.x = vx + vw * (0.2 + Math.random() * 0.6);
    ball.y = vy + vh * (0.46 + Math.random() * 0.14);
    ball.vx = Math.cos(ang) * BALL_SPEED;
    ball.vy = Math.sin(ang) * BALL_SPEED; // 上向き(負)
    ball.dead = false;
    ball.respawnAt = 0;
  }

  #spawnBall(now) {
    const ball = {};
    this.#launchBall(ball);
    this.#balls.push(ball);
    this.#lastSpawn = now;
  }

  #breakBrick(b, now) {
    b.broken = true;
    this.#brokenOrder.push(b);
    this.#broken++;
    this.#cleared = (this.#broken / this.#total) * 100;
    const col = ROW_COLORS[b.r % ROW_COLORS.length];
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 2.6;
      this.#particles.push({
        x: b.cx, y: b.cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
        size: 2 + Math.random() * 2.5, color: col, life: 1,
      });
    }
  }

  // ================================================================ main loop
  #loop(now) {
    const dtMs = Math.min(33, now - this.#last);
    this.#last = now;
    const dt = dtMs / 16.67;

    const { w, h, vx, vy, vw, vh } = this.#vessel();
    if (vw < 10 || vh < 10) return;

    // ---- demoモード(本番では使わない)
    const demo = this.getAttribute("demo");
    if (demo && this.value < 100 && this.#cleared < 100) {
      const dur = parseFloat(this.getAttribute("duration")) || 18000;
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

    const budget = Math.floor((this.value / 100) * this.#total + 1e-9);

    // ---- ボール投入: 実進捗に応じた数まで、間隔を空けて増やす
    //      完了(表示100%)後は新規投入を止め、飛んでいる球が落ちきって自然に消える
    const target = this.#ballTarget(this.value);
    if (this.#cleared < 100 && this.#balls.length < target &&
        now - this.#lastSpawn > SPAWN_INTERVAL) {
      this.#spawnBall(now);
    }

    // ---- パドル
    const padW = Math.max(54, vw * 0.18);
    const padY = vy + vh - 22;
    const padCx = vx + clamp(this.#paddleX, 0, 1) * vw;
    const padL = clamp(padCx - padW / 2, vx, vx + vw - padW);
    const padR = padL + padW;

    // ---- ボール更新(トンネリング防止のためサブステップで進める)
    for (const ball of this.#balls) {
      if (ball.dead) {
        if (now >= ball.respawnAt && this.#cleared < 100) this.#launchBall(ball);
        continue;
      }
      const moveLen = Math.hypot(ball.vx, ball.vy) * dt;
      const steps = Math.max(1, Math.ceil(moveLen / (BALL_R * 1.6)));
      const sdt = dt / steps;
      for (let s = 0; s < steps; s++) {
        ball.x += ball.vx * sdt;
        ball.y += ball.vy * sdt;

        // 壁(左右・上)
        if (ball.x < vx + BALL_R) { ball.x = vx + BALL_R; ball.vx = Math.abs(ball.vx); }
        else if (ball.x > vx + vw - BALL_R) { ball.x = vx + vw - BALL_R; ball.vx = -Math.abs(ball.vx); }
        if (ball.y < vy + BALL_R) { ball.y = vy + BALL_R; ball.vy = Math.abs(ball.vy); }

        // パドル(下向きに進んでいるときだけ反射し、当たった位置で角度を付ける)
        if (ball.vy > 0 &&
            ball.y + BALL_R >= padY && ball.y - BALL_R <= padY + PADDLE_H &&
            ball.x >= padL - BALL_R && ball.x <= padR + BALL_R) {
          ball.y = padY - BALL_R;
          const off = clamp((ball.x - padCx) / (padW / 2), -1, 1);
          const ang = -Math.PI / 2 + off * (Math.PI / 3); // 真上から±60°
          ball.vx = Math.cos(ang) * BALL_SPEED;
          ball.vy = Math.sin(ang) * BALL_SPEED;
          this.#paddleFlash = 1;
        }

        // ブロック(当たれば必ず反射。HPを削るだけで、破壊確定は下の予算判定で)
        this.#collideBricks(ball, now);

        // 場外(下) → 再投入待ちに
        if (ball.y - BALL_R > vy + vh) {
          ball.dead = true;
          ball.respawnAt = now + RESPAWN_DELAY;
          break;
        }
      }
    }

    // ---- 破壊確定: HP0のブロックを実進捗の許す範囲だけ砕く(表示 ≤ value)
    if (this.#broken < budget) {
      for (const b of this.#bricks) {
        if (this.#broken >= budget) break;
        if (!b.broken && b.hp <= 0) this.#breakBrick(b, now);
      }
    }

    // ---- 完了フラッシュ: 残ブロックを一斉破壊するフィナーレ
    if (this.value >= 100) {
      if (!this.#flushAt) this.#flushAt = now;
      if (now - this.#flushAt > this.flushDelay) {
        let n = 0;
        for (const b of this.#bricks) {
          if (!b.broken) { this.#breakBrick(b, now); if (++n >= FLUSH_PER_FRAME) break; }
        }
      }
      if (this.#broken >= this.#total) this.#cleared = 100;
    } else {
      this.#flushAt = 0;
    }
    if (this.#cleared >= 100) this.emitComplete();

    // ---- パーティクル
    this.#particles = this.#particles.filter((p) => {
      p.vy += 0.14 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= 0.03 * dt;
      return p.life > 0;
    });
    this.#paddleFlash = Math.max(0, this.#paddleFlash - 0.08 * dt);

    this.#render(now, w, h, vx, vy, vw, vh, padL, padR, padY, padW);
    this.$stage.classList.toggle("done", this.#cleared >= 100);
  }

  #collideBricks(ball, now) {
    for (const b of this.#bricks) {
      if (b.broken) continue;
      // AABB との粗い距離チェック(半径+半サイズ以内のみ精密判定)
      if (Math.abs(ball.x - b.cx) > b.w / 2 + BALL_R) continue;
      if (Math.abs(ball.y - b.cy) > b.h / 2 + BALL_R) continue;

      const left = b.cx - b.w / 2, right = b.cx + b.w / 2;
      const top = b.cy - b.h / 2, bottom = b.cy + b.h / 2;
      const nx = clamp(ball.x, left, right);
      const ny = clamp(ball.y, top, bottom);
      const dx = ball.x - nx, dy = ball.y - ny;
      if (dx * dx + dy * dy > BALL_R * BALL_R) continue;

      // 反射(常に跳ね返る)
      if (dx === 0 && dy === 0) {
        const pL = ball.x - left, pR = right - ball.x, pT = ball.y - top, pB = bottom - ball.y;
        const m = Math.min(pL, pR, pT, pB);
        if (m === pL) { ball.x = left - BALL_R; ball.vx = -Math.abs(ball.vx); }
        else if (m === pR) { ball.x = right + BALL_R; ball.vx = Math.abs(ball.vx); }
        else if (m === pT) { ball.y = top - BALL_R; ball.vy = -Math.abs(ball.vy); }
        else { ball.y = bottom + BALL_R; ball.vy = Math.abs(ball.vy); }
      } else {
        const d = Math.hypot(dx, dy) || 1e-6;
        const ux = dx / d, uy = dy / d;
        const dot = ball.vx * ux + ball.vy * uy;
        ball.vx -= 2 * dot * ux;
        ball.vy -= 2 * dot * uy;
        const push = BALL_R - d;
        ball.x += ux * push;
        ball.y += uy * push;
      }

      // ヒットでHPを削る(ひびが入る)。破壊の確定は呼び出し側の予算判定で
      if (b.hp > 0) {
        b.hp--;
        const col = ROW_COLORS[b.r % ROW_COLORS.length];
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 0.6 + Math.random() * 1.6;
          this.#particles.push({
            x: ball.x, y: ball.y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.5,
            size: 1.5 + Math.random() * 1.5, color: col, life: 0.7,
          });
        }
      }
      return; // 1ステップ1ブロックまで(多重反射を防ぐ)
    }
  }

  // ================================================================ render
  #render(now, w, h, vx, vy, vw, vh, padL, padR, padY, padW) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.#dpr, this.#dpr);
    ctx.clearRect(0, 0, w, h);

    const rr = 18;
    ctx.beginPath();
    ctx.roundRect(vx, vy, vw, vh, rr);
    ctx.strokeStyle = C.edge;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(vx + 1, vy + 1, vw - 2, vh - 2, rr - 1);
    ctx.clip();

    // % 数字(実進捗)— ブロックの下、パドルの上あたりに大きく薄く
    ctx.font = "600 58px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.#cleared >= 100 ? "rgba(123,227,168,.22)" : C.text;
    ctx.fillText(Math.floor(this.value) + "%", vx + vw / 2, padY - 46);
    ctx.textBaseline = "alphabetic";

    // ブロック(全段すべて破壊可能。硬さが残るほど明るく、削れるほど沈む)
    for (const b of this.#bricks) {
      if (b.broken) continue;
      const x = b.cx - b.w / 2, y = b.cy - b.h / 2;
      ctx.fillStyle = ROW_COLORS[b.r % ROW_COLORS.length];
      ctx.fillRect(x, y, b.w, b.h);
      // ダメージ: HPが減るほど黒く翳らせ、ひびを示す
      const dmg = b.maxHp > 1 ? 1 - b.hp / b.maxHp : 0;
      if (dmg > 0) {
        ctx.fillStyle = `rgba(0,0,0,${0.42 * dmg})`;
        ctx.fillRect(x, y, b.w, b.h);
      }
      // 上辺ハイライト
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.fillRect(x, y, b.w, Math.max(2, b.h * 0.28));
    }

    // パーティクル
    for (const p of this.#particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // ボール
    ctx.fillStyle = C.ball;
    for (const ball of this.#balls) {
      if (ball.dead) continue;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
      ctx.fill();
    }

    // パドル
    const padH = PADDLE_H;
    ctx.fillStyle = this.#paddleFlash > 0.05
      ? `rgba(255,255,255,${0.5 + 0.5 * this.#paddleFlash})`
      : C.paddle;
    ctx.beginPath();
    ctx.roundRect(padL, padY, padR - padL, padH, padH / 2);
    ctx.fill();

    ctx.restore(); // clip 解除

    // ---- 上部ラベル類
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = C.muted;
    ctx.textAlign = "right";
    const live = this.#balls.reduce((n, b) => n + (b.dead ? 0 : 1), 0);
    ctx.fillText(`BALL × ${live}`, vx + vw - 4, vy + 14);

    const step =
      this.steps.find((s) => this.value <= s.until) ||
      this.steps[this.steps.length - 1];
    if (step) {
      ctx.textAlign = "left";
      ctx.fillStyle = this.#cleared >= 100 ? C.good : C.accent;
      ctx.fillText(step.label, vx + 4, vy + 14);
    }
    if (this.note) {
      ctx.textAlign = "left";
      ctx.fillStyle = C.muted;
      ctx.fillText(this.note, vx + 4, vy + 30);
    }

    ctx.restore();
  }
}

customElements.define("breakout-progress", BreakoutProgress);
export { BreakoutProgress };
