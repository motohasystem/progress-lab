/**
 * <tnt-progress> — TNT爆破型プログレスバーゲーム
 *
 * 進捗モデル(正直設計 / core/progress-base.js の契約に従う):
 *   value(実進捗)          … 外部から流し込む。TNTブロックの投下量を決める。
 *   detonatedValue(爆破済み) … 表示進捗。ブロックが爆発するたび加算。
 *
 * ゲーム性:
 *   - 水槽の下半分に土ブロックの地形が敷き詰めてある(最上段は草)。
 *   - TNTは地表に降り積もる。タップで着火 → 約0.9秒後に爆発。
 *     爆風で周囲のTNTが吹き飛び、近くは誘爆(チェーン)。
 *   - 爆発は土も破壊し、クレーターができる。降ってくるTNTがクレーターへ
 *     転がり込む → 掘り進めながらTNTを誘導する採掘ゲームになる。
 *     土は風景であり進捗には計上されない(TNTの消滅だけが進捗)。
 *   - 放置しても各ブロックは3.5〜7秒で自然発火するため、進捗は必ず流れる。
 *   - 完了フラッシュ: value=100 後、残ブロックを一斉点火してフィナーレ。
 *
 * 使い方:
 *   <script type="module" src="variants/tnt/tnt-progress.js"></script>
 *   <tnt-progress id="tp"></tnt-progress>
 *   <script> tp.value = serverProgress; </script>
 *
 * 属性:
 *   value / height / demo("smooth"|"step") / duration
 *   block-gain   1ブロックあたりの進捗% (default 0.625 → 全160個)
 *   dirt-fill    土を積む高さの比率 (default 0.5 = 水槽の半分)
 *   flush-delay  完了フラッシュまでの猶予ms (default 2500)
 *
 * プロパティ:
 *   .value / .detonatedValue
 *   .steps  進捗しきい値ごとのラベル [{label, until}, …]
 *   .note   進捗とは独立した任意の一行コメント("xxxをしています…")
 *
 * イベント: "complete"(表示進捗100%到達時に1回)
 * 依存: matter-js(未ロードならCDNから自動取得)
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
  accent: "#FFB454", good: "#7BE3A8", text: "#3A3470",
  tntRed: "#C84B41", tntDark: "#8C2F27", tntBand: "#E8DBC5", tntText: "#1B1B1B",
};

// ---- 調整値
const BLOCK = 17;                  // ブロック一辺px(TNT・土 共通グリッド)
const SPAWN_INTERVAL = 60;         // 投下ペースms。短いほどバーストがドバッと出る
const FUSE_MS = 900;               // タップ着火の導火線
const CHAIN_FUSE = [120, 420];     // 誘爆の導火線(短いほどチェーンが爽快)
const AUTO_FUSE = [3500, 7000];    // 自然発火までの寿命
const BLAST_R = 85;                // 爆風の力が及ぶ半径
const CHAIN_R = 60;                // 誘爆半径
const DIRT_DESTROY_R = 64;         // 爆発が土を壊す半径
const BLAST_FORCE = 0.045;
const PARTICLE_COLORS = ["#FF9B40", "#FFD25F", "#B8B8B8", "#6B5B4E"];
const DIRT_COLORS = ["#8B5A2B", "#6B4423", "#A9743C"];

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
</style>
<div class="stage" part="stage"><canvas id="cv"></canvas></div>
`;

class TntProgress extends ProgressBase {
  static get observedAttributes() {
    return ["value", "height"];
  }

  blockGain = 0.625;
  dirtFill = 0.5;
  flushDelay = 2500;
  steps = DEFAULT_STEPS;
  /** 進捗とは独立した任意の一行コメント。"xxxをしています…" 等を即時表示 */
  note = "";

  #detonated = 0;
  #spawned = 0;
  #releaseDoneAt = 0;
  #lastSpawn = 0;
  #demoTimer = 0;

  #Matter = null;
  #engine = null;
  #blocks = [];   // { body, fuseAt, autoAt, seed }
  #dirt = [];     // { body, seed, grass }
  #walls = [];
  #particles = [];
  #flashes = [];
  #shake = 0;

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
  async connectedCallback() {
    if (this.hasAttribute("height"))
      this.style.height = parseInt(this.getAttribute("height")) + "px";
    if (this.hasAttribute("block-gain"))
      this.blockGain = parseFloat(this.getAttribute("block-gain")) || this.blockGain;
    if (this.hasAttribute("dirt-fill"))
      this.dirtFill = clamp(parseFloat(this.getAttribute("dirt-fill")) || this.dirtFill, 0, 0.8);
    if (this.hasAttribute("flush-delay"))
      this.flushDelay = parseFloat(this.getAttribute("flush-delay")) || this.flushDelay;

    this.$cv.addEventListener("pointerdown", (e) => this.#onTap(e));

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
  get detonatedValue() {
    return this.#detonated;
  }
  get displayValue() {
    return this.#detonated;
  }

  /** 進捗・TNT・演出を初期化し、地形を敷き直す */
  reset() {
    this.value = 0;
    this.#detonated = 0;
    this.#spawned = 0;
    this.#releaseDoneAt = 0;
    this.#demoTimer = 0;
    this.#clearBlocks();
    this.#particles = [];
    this.#flashes = [];
    this.#buildDirt();
    this.resetCompleted();
  }

  onValueChanged(v) {
    if (v < this.#spawned - 1e-6) {
      this.#detonated = v;
      this.#spawned = v;
      this.#releaseDoneAt = 0;
      this.#clearBlocks();
      if (v < 100) this.resetCompleted();
    }
  }

  // ================================================================ internals
  #clearBlocks() {
    if (!this.#engine) return;
    const { World } = this.#Matter;
    for (const b of this.#blocks) World.remove(this.#engine.world, b.body);
    this.#blocks = [];
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
    const r = this.$cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.$cv.width = r.width * this.#dpr;
    this.$cv.height = r.height * this.#dpr;
    this.#rebuildWalls();
    this.#buildDirt();
  }

  #rebuildWalls() {
    if (!this.#engine) return;
    const { World, Bodies } = this.#Matter;
    for (const b of this.#walls) World.remove(this.#engine.world, b);
    const { vx, vy, vw, vh } = this.#vessel();
    const T = 40;
    this.#walls = [
      Bodies.rectangle(vx + 2 - T / 2, vy + vh / 2, T, vh * 3, { isStatic: true }),
      Bodies.rectangle(vx + vw - 2 + T / 2, vy + vh / 2, T, vh * 3, { isStatic: true }),
      Bodies.rectangle(vx + vw / 2, vy + vh - 2 + T / 2, vw + T, T, { isStatic: true }),
    ];
    World.add(this.#engine.world, this.#walls);
  }

  #buildDirt() {
    if (!this.#engine) return;
    const { World, Bodies } = this.#Matter;
    for (const d of this.#dirt) World.remove(this.#engine.world, d.body);
    this.#dirt = [];
    const { vx, vy, vw, vh } = this.#vessel();
    const cols = Math.floor((vw - 4) / BLOCK);
    const rows = Math.max(0, Math.floor((vh * this.dirtFill) / BLOCK));
    const offX = vx + (vw - cols * BLOCK) / 2 + BLOCK / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const body = Bodies.rectangle(
          offX + c * BLOCK,
          vy + vh - 2 - BLOCK / 2 - r * BLOCK,
          BLOCK, BLOCK,
          { isStatic: true, friction: 0.6 }
        );
        this.#dirt.push({
          body,
          seed: (Math.random() * 1000) | 0,
          grass: r === rows - 1,
        });
        World.add(this.#engine.world, body);
      }
    }
  }

  #onTap(e) {
    if (!this.#engine) return;
    const r = this.$cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const { Query } = this.#Matter;
    const hits = Query.point(this.#blocks.map((b) => b.body), { x, y });
    let blk = this.#blocks.find((b) => b.body === hits[0]);
    if (!blk) {
      // モバイル向けに指先のヒット範囲を広げる
      blk = this.#blocks.find(
        (b) => Math.hypot(b.body.position.x - x, b.body.position.y - y) < BLOCK
      );
    }
    if (blk) this.#ignite(blk, FUSE_MS);
  }

  #ignite(blk, delay) {
    if (blk.fuseAt != null) return;
    blk.fuseAt = performance.now() + delay;
  }

  #explode(blk, now) {
    const { World, Body } = this.#Matter;
    const p = blk.body.position;

    // 進捗加算(TNTの消滅は必ず進捗になる = 正直契約)
    this.#detonated = Math.min(100, this.#detonated + this.blockGain);

    this.#flashes.push({ x: p.x, y: p.y, born: now });
    this.#shake = Math.min(10, this.#shake + 5);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 4;
      this.#particles.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
        size: 2 + Math.random() * 3,
        color: PARTICLE_COLORS[(Math.random() * PARTICLE_COLORS.length) | 0],
        life: 1,
      });
    }

    // 爆風: TNTを吹き飛ばし、近くは誘爆
    for (const other of this.#blocks) {
      if (other === blk) continue;
      const q = other.body.position;
      const dx = q.x - p.x, dy = q.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < BLAST_R && dist > 0.1) {
        const f = (1 - dist / BLAST_R) * BLAST_FORCE;
        Body.applyForce(other.body, q, { x: (dx / dist) * f, y: (dy / dist) * f - f * 0.3 });
      }
      if (dist < CHAIN_R) {
        this.#ignite(other, CHAIN_FUSE[0] + Math.random() * (CHAIN_FUSE[1] - CHAIN_FUSE[0]));
      }
    }

    // 土を破壊(クレーターができる)。土は進捗に計上しない
    this.#dirt = this.#dirt.filter((d) => {
      const q = d.body.position;
      if (Math.hypot(q.x - p.x, q.y - p.y) < DIRT_DESTROY_R) {
        World.remove(this.#engine.world, d.body);
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 1 + Math.random() * 2.5;
          this.#particles.push({
            x: q.x, y: q.y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.8,
            size: 2 + Math.random() * 3,
            color: DIRT_COLORS[(Math.random() * DIRT_COLORS.length) | 0],
            life: 1,
          });
        }
        return false;
      }
      return true;
    });

    World.remove(this.#engine.world, blk.body);
    this.#blocks.splice(this.#blocks.indexOf(blk), 1);
  }

  // ================================================================ main loop
  #loop(now) {
    if (!this.#engine) return;
    const { Engine, World, Bodies, Body } = this.#Matter;
    const dtMs = Math.min(33, now - this.#last);
    this.#last = now;
    const dt = dtMs / 16.67;

    // ---- demoモード
    const demo = this.getAttribute("demo");
    if (demo && this.value < 100 && this.#detonated < 100) {
      const dur = parseFloat(this.getAttribute("duration")) || 20000;
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

    // ---- 投下: spawned が value に追いつくまで(ペース制限)
    if (this.#spawned < this.value && now - this.#lastSpawn > SPAWN_INTERVAL) {
      this.#lastSpawn = now;
      this.#spawned += this.blockGain;
      const body = Bodies.rectangle(
        vx + BLOCK + Math.random() * (vw - BLOCK * 2),
        vy - BLOCK,
        BLOCK, BLOCK,
        { friction: 0.4, frictionStatic: 0.6, restitution: 0.1, density: 0.0012, label: "tnt" }
      );
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.15);
      this.#blocks.push({
        body,
        fuseAt: null,
        autoAt: now + AUTO_FUSE[0] + Math.random() * (AUTO_FUSE[1] - AUTO_FUSE[0]),
        seed: (Math.random() * 1000) | 0,
      });
      World.add(this.#engine.world, body);
    }

    Engine.update(this.#engine, dtMs);

    // ---- 着火判定: 自然発火 / 導火線切れ / 場外
    const toExplode = [];
    for (const blk of this.#blocks) {
      if (blk.fuseAt == null && now >= blk.autoAt) this.#ignite(blk, FUSE_MS * 0.6);
      if (blk.fuseAt != null && now >= blk.fuseAt) toExplode.push(blk);
      if (blk.body.position.y > vy + vh + 80 || blk.body.position.y < vy - 200)
        toExplode.push(blk);
    }
    for (const blk of toExplode) {
      if (this.#blocks.includes(blk)) this.#explode(blk, now);
    }

    // ---- 完了フラッシュ: 残ブロック一斉点火のフィナーレ
    if (this.value >= 100 && this.#spawned >= 100 - 1e-9) {
      if (!this.#releaseDoneAt) this.#releaseDoneAt = now;
      if (now - this.#releaseDoneAt > this.flushDelay) {
        for (const blk of this.#blocks) this.#ignite(blk, Math.random() * 600);
      }
      if (this.#blocks.length === 0 && this.#detonated > 99.5) this.#detonated = 100;
    } else {
      this.#releaseDoneAt = 0;
    }
    if (this.#detonated >= 100) this.emitComplete();

    // ---- パーティクル
    this.#particles = this.#particles.filter((p) => {
      p.vy += 0.12 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= 0.025 * dt;
      return p.life > 0 && p.y < vy + vh;
    });
    this.#flashes = this.#flashes.filter((f) => now - f.born < 260);
    this.#shake = Math.max(0, this.#shake - 0.6 * dt);

    this.#render(now, w, h, vx, vy, vw, vh);
    this.$stage.classList.toggle("done", this.#detonated >= 100);
  }

  // ================================================================ render
  #render(now, w, h, vx, vy, vw, vh) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.#dpr, this.#dpr);
    ctx.clearRect(0, 0, w, h);

    if (this.#shake > 0.2) {
      ctx.translate(
        (Math.random() - 0.5) * this.#shake,
        (Math.random() - 0.5) * this.#shake
      );
    }

    const rr = 18;
    ctx.beginPath();
    ctx.roundRect(vx, vy, vw, vh, [4, 4, rr, rr]);
    ctx.strokeStyle = C.edge;
    ctx.lineWidth = 2;
    ctx.stroke();

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
    ctx.fillStyle = this.#detonated >= 100 ? C.good : C.text;
    ctx.fillText(Math.floor(this.value) + "%", vx + vw / 2, vy + vh / 2);
    ctx.textBaseline = "alphabetic";

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(vx + 1, vy + 1, vw - 2, vh - 2, [3, 3, rr - 1, rr - 1]);
    ctx.clip();

    // 土ブロック(マイクラ風: 茶+最上段は草)
    for (const d of this.#dirt) {
      const q = d.body.position;
      const s = BLOCK, hs = s / 2;
      const sd = d.seed;
      ctx.fillStyle = "#8B5A2B";
      ctx.fillRect(q.x - hs, q.y - hs, s, s);
      ctx.fillStyle = "#6B4423";
      ctx.fillRect(q.x - hs + (sd % 3) * 5, q.y - hs + 3 + ((sd >> 3) % 2) * 6, 3, 3);
      ctx.fillRect(q.x - hs + ((sd >> 2) % 4) * 4, q.y + 2, 3, 3);
      if (d.grass) {
        ctx.fillStyle = "#6AAB3C";
        ctx.fillRect(q.x - hs, q.y - hs, s, 5);
        ctx.fillStyle = "#4E8A2A";
        ctx.fillRect(q.x - hs + (sd % 4) * 4, q.y - hs + 3, 3, 3);
      }
    }

    // TNTブロック
    for (const blk of this.#blocks) {
      const b = blk.body;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);
      const s = BLOCK, hs = s / 2;
      ctx.fillStyle = C.tntRed;
      ctx.fillRect(-hs, -hs, s, s);
      ctx.fillStyle = C.tntDark;
      const sd = blk.seed;
      ctx.fillRect(-hs + (sd % 3) * 5, -hs + 2, 4, 3);
      ctx.fillRect(-hs + ((sd >> 2) % 3) * 5 + 2, hs - 6, 4, 3);
      ctx.fillRect(-hs, hs - 2, s, 2);
      ctx.fillStyle = C.tntBand;
      ctx.fillRect(-hs, -s / 6, s, s / 3);
      ctx.fillStyle = C.tntText;
      ctx.font = `bold ${Math.floor(s * 0.3)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("TNT", 0, 1);
      ctx.textBaseline = "alphabetic";
      if (blk.fuseAt != null) {
        const blink = Math.floor((blk.fuseAt - now) / 110) % 2 === 0;
        if (blink) {
          ctx.fillStyle = "rgba(255,255,255,.75)";
          ctx.fillRect(-hs, -hs, s, s);
        }
      }
      ctx.restore();
    }

    // パーティクル(ピクセル風)
    for (const p of this.#particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // 爆発フラッシュ
    for (const f of this.#flashes) {
      const t = (now - f.born) / 260;
      const r2 = 12 + t * 58;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r2);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - t)})`);
      g.addColorStop(0.4, `rgba(255,155,64,${0.7 * (1 - t)})`);
      g.addColorStop(1, "rgba(255,155,64,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, r2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ラベル類
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = C.muted;
    ctx.textAlign = "right";
    ctx.fillText(`TNT × ${this.#blocks.length}`, w - 12, 18);
    const step =
      this.steps.find((s) => this.value <= s.until) ||
      this.steps[this.steps.length - 1];
    if (step) {
      ctx.textAlign = "left";
      ctx.fillStyle = this.#detonated >= 100 ? C.good : C.accent;
      ctx.fillText(step.label, 12, 18);
    }
    // 任意コメント(進捗とは独立。設定時のみステップラベルの下に表示)
    if (this.note) {
      ctx.textAlign = "left";
      ctx.fillStyle = C.muted;
      ctx.fillText(this.note, 12, 34);
    }
    ctx.restore();
  }
}

customElements.define("tnt-progress", TntProgress);
export { TntProgress };
