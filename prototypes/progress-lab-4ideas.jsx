import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

// ----------------------------------------------------------------------
// PROGRESS LAB — プログレスバー代替表現の比較デモ
// 4案: 積層ビルド / 軌道吸収 / 地形生成 / ボクセル組み立て
// ----------------------------------------------------------------------

const STEPS = [
  { label: "接続を確立", until: 8 },
  { label: "データ取得", until: 30 },
  { label: "解析", until: 55 },
  { label: "変換", until: 75 },
  { label: "レンダリング", until: 95 },
  { label: "完了", until: 100 },
];

const COLORS = {
  bg: "#161330",
  panel: "#1E1A3D",
  panelEdge: "#332D63",
  line: "#3D3675",
  text: "#EDEAFB",
  muted: "#8F89BC",
  accent: "#FFB454", // amber
  accent2: "#8E86FF", // lavender
  good: "#7BE3A8",
};

const stepAt = (p) => STEPS.find((s) => p <= s.until) || STEPS[STEPS.length - 1];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;

// ---------------------------------------------------------------- engine
function useProgressEngine(durationMs = 14000) {
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = now - last;
      last = now;
      setProgress((p) => Math.min(100, p + (dt / durationMs) * 100));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);

  useEffect(() => {
    if (progress >= 100 && playing) setPlaying(false);
  }, [progress, playing]);

  const replay = useCallback(() => {
    setProgress(0);
    setPlaying(true);
  }, []);

  return { progress, setProgress, playing, setPlaying, replay };
}

// canvas helper: own rAF loop reading progress from a ref
function useCanvasLoop(canvasRef, progressRef, draw) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    const start = performance.now();
    const loop = (now) => {
      const t = (now - start) / 1000;
      ctx.save();
      ctx.scale(dpr, dpr);
      const rect = canvas.getBoundingClientRect();
      draw(ctx, rect.width, rect.height, progressRef.current, t);
      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef, progressRef, draw]);
}

// ---------------------------------------------------------- 1. 積層ビルド
function LayerStackDemo({ progress }) {
  const layerCount = STEPS.length;
  const plates = STEPS.map((s, i) => {
    const startP = i === 0 ? 0 : STEPS[i - 1].until;
    const span = s.until - startP;
    const t = clamp((progress - startP) / (span * 0.7), 0, 1);
    return { ...s, t: easeOutCubic(t), i };
  });

  return (
    <div style={{ display: "flex", height: "100%", alignItems: "stretch" }}>
      <div
        style={{
          flex: 1,
          perspective: "900px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "relative",
            width: 200,
            height: 200,
            transformStyle: "preserve-3d",
            transform: "rotateX(58deg) rotateZ(-42deg) translateZ(-60px)",
          }}
        >
          {/* base grid */}
          <div
            style={{
              position: "absolute",
              inset: -30,
              border: `1px dashed ${COLORS.line}`,
              borderRadius: 6,
              backgroundImage: `linear-gradient(${COLORS.line}33 1px, transparent 1px), linear-gradient(90deg, ${COLORS.line}33 1px, transparent 1px)`,
              backgroundSize: "26px 26px",
            }}
          />
          {plates.map((p) => {
            const z = p.i * 32;
            const entryZ = z + (1 - p.t) * 150;
            const isTop = p.i === layerCount - 1;
            return (
              <div
                key={p.i}
                style={{
                  position: "absolute",
                  inset: p.i * 8,
                  borderRadius: 8,
                  transform: `translateZ(${entryZ}px)`,
                  opacity: p.t,
                  background: isTop
                    ? `linear-gradient(135deg, ${COLORS.accent}, #FF8E54)`
                    : `linear-gradient(135deg, ${COLORS.accent2}cc, #5B51D8cc)`,
                  border: `1px solid ${isTop ? "#FFD9A0" : "#B6B0FF"}55`,
                  boxShadow: `0 0 ${20 * p.t}px ${isTop ? COLORS.accent : COLORS.accent2}40`,
                  transition: "none",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* legend */}
      <div
        style={{
          width: 180,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 8,
          paddingRight: 12,
        }}
      >
        {plates.map((p) => {
          const active = p.t > 0.05;
          const done = p.t >= 1;
          return (
            <div
              key={p.i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: active ? COLORS.text : COLORS.muted,
                opacity: active ? 1 : 0.45,
                fontFamily: "var(--mono)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: done
                    ? COLORS.good
                    : active
                    ? COLORS.accent
                    : COLORS.line,
                  boxShadow: active && !done ? `0 0 8px ${COLORS.accent}` : "none",
                }}
              />
              {p.label}
              {done && <span style={{ marginLeft: "auto", color: COLORS.good }}>✓</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- 2. 軌道吸収
function makeParticles(n) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      threshold: (i / n) * 96,
      angle: (i * 137.5 * Math.PI) / 180, // golden angle spread
      speed: 0.4 + ((i * 7919) % 100) / 220,
      hueMix: ((i * 31) % 100) / 100,
    });
  }
  return arr;
}

function OrbitDemo({ progressRef }) {
  const canvasRef = useRef(null);
  const particles = useMemo(() => makeParticles(110), []);

  const draw = useCallback(
    (ctx, w, h, progress, t) => {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2 + 6;
      const R = Math.min(w, h) * 0.36;
      const squash = 0.36;
      const consumeSpan = 5;

      const pts = [];
      let remaining = 0;
      for (const p of particles) {
        const local = (progress - p.threshold) / consumeSpan;
        if (local >= 1) continue; // absorbed
        const consuming = local > 0;
        const lt = consuming ? easeInCubic(clamp(local, 0, 1)) : 0;
        if (!consuming) remaining++;
        const r = lerp(R, 4, lt);
        const a = p.angle + t * p.speed + lt * 5.2;
        const sx = cx + Math.cos(a) * r;
        const sy = cy + Math.sin(a) * r * squash;
        const depth = Math.sin(a); // -1 back .. 1 front
        pts.push({ sx, sy, depth, lt, hueMix: p.hueMix });
      }
      pts.sort((a, b) => a.depth - b.depth);

      const coreR = 9 + (progress / 100) * 22;

      const drawPt = (p) => {
        const scale = 1 + p.depth * 0.4;
        const size = (1.6 + p.lt * 1.4) * scale;
        const alpha = 0.45 + p.depth * 0.3 + p.lt * 0.3;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, size, 0, Math.PI * 2);
        const c = p.lt > 0 ? COLORS.accent : p.hueMix > 0.5 ? COLORS.accent2 : "#B6B0FF";
        ctx.fillStyle = c;
        ctx.globalAlpha = clamp(alpha, 0.15, 1);
        ctx.fill();
        ctx.globalAlpha = 1;
      };

      // back half
      pts.filter((p) => p.depth < 0).forEach(drawPt);

      // orbit guide ring
      ctx.beginPath();
      ctx.ellipse(cx, cy, R, R * squash, 0, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.line;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // core
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
      g.addColorStop(0, COLORS.accent);
      g.addColorStop(0.45, "#FF8E5466");
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = "#FFD9A0";
      ctx.fill();

      // front half
      pts.filter((p) => p.depth >= 0).forEach(drawPt);

      // remaining counter
      ctx.font = "11px var(--mono, ui-monospace, monospace)";
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = "center";
      ctx.fillText(
        progress >= 100 ? "すべて処理済み" : `残りタスク ${remaining}`,
        cx,
        h - 14
      );
    },
    [particles]
  );

  useCanvasLoop(canvasRef, progressRef, draw);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

// ---------------------------------------------------------- 3. 地形生成
function valueNoise(x, y) {
  const hash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = lerp(hash(xi, yi), hash(xi + 1, yi), sx);
  const b = lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), sx);
  return lerp(a, b, sy);
}

function TerrainDemo({ progressRef }) {
  const canvasRef = useRef(null);
  const COLSN = 44, ROWSN = 26;

  const heights = useMemo(() => {
    const hgt = [];
    for (let j = 0; j <= ROWSN; j++) {
      const row = [];
      for (let i = 0; i <= COLSN; i++) {
        const n =
          valueNoise(i * 0.14, j * 0.2) * 0.65 +
          valueNoise(i * 0.32, j * 0.45) * 0.35;
        // ridge in the middle
        const ridge = Math.exp(-Math.pow((i - COLSN / 2) / (COLSN * 0.22), 2));
        row.push(n * 0.55 + ridge * n * 0.9);
      }
      hgt.push(row);
    }
    return hgt;
  }, []);

  const draw = useCallback(
    (ctx, w, h, progress, t) => {
      ctx.clearRect(0, 0, w, h);
      const horizon = h * 0.3;
      const cx = w / 2;
      const amp = easeOutCubic(progress / 100) * h * 0.42;
      const shimmer = Math.sin(t * 1.2) * 1.5;

      const project = (i, j) => {
        const d = j / ROWSN; // 0 back -> 1 front
        const persp = lerp(0.34, 1, d * d * 0.6 + d * 0.4);
        const px = cx + (i - COLSN / 2) * (w / COLSN) * persp * 0.92;
        const baseY = horizon + d * d * (h * 0.62);
        const hh = heights[j][i] * amp * persp + (j % 2 ? shimmer : -shimmer) * persp;
        return [px, baseY - hh, d, heights[j][i]];
      };

      // rows (back to front)
      for (let j = 0; j <= ROWSN; j++) {
        ctx.beginPath();
        let depth = 0, maxH = 0;
        for (let i = 0; i <= COLSN; i++) {
          const [px, py, d, hv] = project(i, j);
          depth = d;
          maxH = Math.max(maxH, hv);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        const hot = clamp(maxH * (progress / 100) * 1.3, 0, 1);
        ctx.strokeStyle = hot > 0.55 ? COLORS.accent : COLORS.accent2;
        ctx.globalAlpha = lerp(0.12, 0.85, depth) * lerp(0.5, 1, hot);
        ctx.lineWidth = lerp(0.5, 1.3, depth);
        ctx.stroke();
      }
      // columns (sparser)
      for (let i = 0; i <= COLSN; i += 2) {
        ctx.beginPath();
        for (let j = 0; j <= ROWSN; j++) {
          const [px, py] = project(i, j);
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = COLORS.line;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // altitude readout
      ctx.font = "11px var(--mono, ui-monospace, monospace)";
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = "left";
      ctx.fillText(`ELEVATION ${(progress * 18.42).toFixed(0)}m / 1842m`, 16, 22);
      ctx.textAlign = "right";
      ctx.fillStyle = progress >= 100 ? COLORS.good : COLORS.accent;
      ctx.fillText(stepAt(progress).label, w - 16, 22);
    },
    [heights]
  );

  useCanvasLoop(canvasRef, progressRef, draw);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

// ------------------------------------------------------ 4. ボクセル組み立て
function buildPyramidVoxels() {
  const levels = [9, 7, 5, 3, 1];
  const out = [];
  levels.forEach((size, z) => {
    const off = (9 - size) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out.push({ x: x + off, y: y + off, z });
      }
    }
  });
  out.sort((a, b) => (a.z - b.z) || (a.x + a.y - (b.x + b.y)));
  return out;
}

function VoxelDemo({ progressRef }) {
  const canvasRef = useRef(null);
  const voxels = useMemo(buildPyramidVoxels, []);

  const draw = useCallback(
    (ctx, w, h, progress) => {
      ctx.clearRect(0, 0, w, h);
      const ts = Math.min(w, h) / 26;
      const hh = ts / 2;
      const dd = ts * 0.95;
      const cx = w / 2;
      const topY = h * 0.30;
      const N = voxels.length;

      const levelColors = [
        ["#6F66E8", "#5249C4", "#403896"],
        ["#7E76F2", "#5F56D2", "#4A41A6"],
        ["#928BFA", "#6F66E8", "#574EBE"],
        ["#FFB454", "#E08A2E", "#B86E1E"],
        ["#FFD9A0", "#FFB454", "#E08A2E"],
      ];

      voxels.forEach((v, idx) => {
        const threshold = (idx / N) * 97;
        const local = clamp((progress - threshold) / 4, 0, 1);
        if (local <= 0) return;
        const t = easeOutCubic(local);
        const sx = cx + (v.x - v.y) * ts;
        const sy =
          topY + (v.x + v.y) * hh - v.z * dd - (1 - t) * 70;
        const [cTop, cR, cL] = levelColors[v.z];
        ctx.globalAlpha = t;

        // top
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + ts, sy + hh);
        ctx.lineTo(sx, sy + 2 * hh);
        ctx.lineTo(sx - ts, sy + hh);
        ctx.closePath();
        ctx.fillStyle = cTop;
        ctx.fill();
        // right
        ctx.beginPath();
        ctx.moveTo(sx + ts, sy + hh);
        ctx.lineTo(sx + ts, sy + hh + dd);
        ctx.lineTo(sx, sy + 2 * hh + dd);
        ctx.lineTo(sx, sy + 2 * hh);
        ctx.closePath();
        ctx.fillStyle = cR;
        ctx.fill();
        // left
        ctx.beginPath();
        ctx.moveTo(sx - ts, sy + hh);
        ctx.lineTo(sx - ts, sy + hh + dd);
        ctx.lineTo(sx, sy + 2 * hh + dd);
        ctx.lineTo(sx, sy + 2 * hh);
        ctx.closePath();
        ctx.fillStyle = cL;
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      const built = voxels.filter(
        (_, idx) => progress >= (idx / N) * 97 + 4
      ).length;
      ctx.font = "11px var(--mono, ui-monospace, monospace)";
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = "center";
      ctx.fillText(
        progress >= 100 ? "組み立て完了" : `${built} / ${N} ブロック`,
        w / 2,
        h - 14
      );
    },
    [voxels]
  );

  useCanvasLoop(canvasRef, progressRef, draw);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

// ---------------------------------------------------------------- shell
const TABS = [
  {
    id: "stack",
    name: "積層ビルド",
    note: "ステップ=レイヤー。処理段階の対応が一目で分かる。CSS 3D transform のみで実装可。",
  },
  {
    id: "orbit",
    name: "軌道吸収",
    note: "残量を粒子数で表現。「あとどれだけ」が直感的。Canvas 2D で擬似3D。",
  },
  {
    id: "terrain",
    name: "地形生成",
    note: "完成度=地形の隆起。長め処理の演出向き。ノイズ地形をワイヤーフレーム描画。",
  },
  {
    id: "voxel",
    name: "ボクセル組み立て",
    note: "成果物が形になる過程を見せる。形状をロゴ等に差し替え可能。アイソメ投影。",
  },
];

export default function ProgressLab() {
  const { progress, setProgress, playing, setPlaying, replay } =
    useProgressEngine(14000);
  const [tab, setTab] = useState("stack");

  const progressRef = useRef(progress);
  progressRef.current = progress;

  const step = stepAt(progress);
  const done = progress >= 100;
  const activeTab = TABS.find((t) => t.id === tab);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `radial-gradient(1200px 600px at 50% -10%, #221C4D, ${COLORS.bg})`,
        color: COLORS.text,
        fontFamily:
          "'Space Grotesk', 'Hiragino Sans', 'Yu Gothic UI', sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "28px 16px 40px",
        ["--mono"]: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap');
        input[type=range] { accent-color: ${COLORS.accent}; }
        button { font-family: inherit; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      <header style={{ width: "100%", maxWidth: 720, marginBottom: 18 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: "0.25em",
            color: COLORS.accent,
          }}
        >
          PROGRESS LAB
        </div>
        <h1 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 600 }}>
          プログレスバー代替表現 — 4案デモ
        </h1>
      </header>

      {/* tabs */}
      <nav
        style={{
          width: "100%",
          maxWidth: 720,
          display: "flex",
          gap: 6,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${active ? COLORS.accent : COLORS.panelEdge}`,
                background: active ? `${COLORS.accent}1A` : COLORS.panel,
                color: active ? COLORS.accent : COLORS.muted,
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {t.name}
            </button>
          );
        })}
      </nav>

      {/* stage */}
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          height: 380,
          background: COLORS.panel,
          border: `1px solid ${COLORS.panelEdge}`,
          borderRadius: 14,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {tab === "stack" && <LayerStackDemo progress={progress} />}
        {tab === "orbit" && <OrbitDemo progressRef={progressRef} />}
        {tab === "terrain" && <TerrainDemo progressRef={progressRef} />}
        {tab === "voxel" && <VoxelDemo progressRef={progressRef} />}
      </div>

      <p
        style={{
          width: "100%",
          maxWidth: 720,
          margin: "10px 0 16px",
          fontSize: 12.5,
          color: COLORS.muted,
          lineHeight: 1.7,
        }}
      >
        {activeTab.note}
      </p>

      {/* controls */}
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          display: "flex",
          alignItems: "center",
          gap: 14,
          background: COLORS.panel,
          border: `1px solid ${COLORS.panelEdge}`,
          borderRadius: 12,
          padding: "12px 16px",
        }}
      >
        <button
          onClick={() => (done ? replay() : setPlaying(!playing))}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: COLORS.accent,
            color: "#2A1B05",
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {done ? "もう一度" : playing ? "一時停止" : "再生"}
        </button>

        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={progress}
          onChange={(e) => {
            setPlaying(false);
            setProgress(parseFloat(e.target.value));
          }}
          style={{ flex: 1 }}
        />

        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 13,
            minWidth: 56,
            textAlign: "right",
            color: done ? COLORS.good : COLORS.text,
          }}
        >
          {progress.toFixed(0)}%
        </div>

        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            padding: "4px 10px",
            borderRadius: 999,
            border: `1px solid ${done ? COLORS.good : COLORS.accent}55`,
            color: done ? COLORS.good : COLORS.accent,
            whiteSpace: "nowrap",
          }}
        >
          {step.label}
        </div>
      </div>
    </div>
  );
}
