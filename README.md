# progress-lab — プログレスバー代替表現コレクション

「待ち時間」を遊びに変えるプログレスバーの実験場。
どのバリエーションも `el.value = 実進捗` を流し込むだけの共通APIで動き、
**表示は実進捗に正直に従い、遊びは演出側にだけ宿る**という設計思想を共有する。

進捗報告(ポーリング / SSE / WebSocket など)で得た 0–100 の値を
カスタム要素の `.value` に流し込めば、あとは各バリエーションが思い思いの表現で
進捗を可視化し、完了時に `complete` イベントを1度だけ発火する。

## デモを見る

[`progress-lab/index.html`](progress-lab/index.html) を開くと全バリエーションの
一覧から各デモへ飛べる。ES Modules を使うため、ファイル直開きではなくローカル
サーバー経由で開くこと(センサー機能は HTTPS が必要)。

```bash
# 例: リポジトリ直下で
npx serve progress-lab
# → http://localhost:3000/index.html
```

## バリエーション

| 名前 | 状態 | 概要 |
|---|---|---|
| [water](progress-lab/variants/water/) — 水位型 | ✅ 完成 | 粒子物理(Matter.js)で水滴が注がれ、水位=進捗。端末の傾きで水面が揺れ、手描きの障害物で水滴の流路を作って遊べる。 |
| [tnt](progress-lab/variants/tnt/) — TNT爆破型 | ✅ 完成 | 実進捗の分だけTNTが土の地形に降り積もり、タップで着火→誘爆チェーン。爆発が地面も掘る採掘ゲーム。 |
| stack — 積層ビルド | 💡 構想 | 処理ステップ=レイヤーが積み上がる。CSS 3D transform のみで依存ゼロ。 |
| orbit — 軌道吸収 | 💡 構想 | 残タスクの粒子が軌道を周回し、処理されると中心核へ螺旋を描いて吸収される。 |
| terrain — 地形生成 | 💡 構想 | 進捗に応じてワイヤーフレームの山が隆起する。長時間処理向き。 |
| voxel — ボクセル組み立て | 💡 構想 | 成果物がブロック単位で組み上がる。形状データ差し替え可能。 |

完成済みバリエーションは各ディレクトリの README に詳しい仕様・調整パラメータ・
試行錯誤の記録がある。

## 共通API

全バリエーションは [`core/progress-base.js`](progress-lab/core/progress-base.js) の
`ProgressBase`(`HTMLElement` 派生)を基底とし、次の契約を満たす。

```html
<script type="module" src="progress-lab/variants/water/water-progress.js"></script>
<water-progress id="p"></water-progress>

<script>
  const p = document.getElementById("p");

  // 実進捗(0–100)を流し込むだけ
  onServerProgress((pct) => { p.value = pct; });

  // 表示も100%に到達したら1度だけ発火
  p.addEventListener("complete", () => { /* … */ });
</script>
```

| メンバー | 説明 |
|---|---|
| `value` (0–100) | **実進捗**。外部から流し込む唯一の入力 |
| `displayValue` | 表示上の進捗。演出で遅延追従する場合のみ実進捗から乖離する |
| `steps` | 進捗しきい値ごとのテキストラベル(下記) |
| `note` | 進捗とは独立した任意の一行コメント(下記) |
| `complete` イベント | 表示が100%に到達したとき1度だけ発火 |

### テキスト表示 — `steps` と `note`

数字の進捗だけでなく「xxxをしています…」のような文字も出せる。
完成バリエーション(water / tnt)は画面**左上**に2種類のテキストを表示する。

```js
// steps: 進捗に応じて自動で切り替わるステップ名(value から逆引き)
p.steps = [
  { label: "ファイルをアップロード中…", until: 40 },
  { label: "サーバーで処理中…",       until: 90 },
  { label: "仕上げ中…",             until: 100 },
];

// note: 進捗に連動しない任意の一行コメント。設定した瞬間に表示、空文字で消える
p.note = "サーバーA と通信しています…";
p.note = "";  // 非表示
```

`steps` は「進捗に正直」なラベル(`value` から導出)、`note` はそれとは独立した
自由なメッセージ欄。再試行中の通知や対象ファイル名など、進捗と無関係な情報に使える。

### 正直契約

- 表示は実進捗に**遅れる**ことはあっても**嘘をつかない**(巻き戻り・水増し・速度の捏造をしない)。
- 演出による遅延は許容するが、完了時には必ず 100% に収束させる。
- 各バリエーションは「放置しても必ず完走する」フォールバック(自然発火・完了フラッシュ等)を持つ。

## ディレクトリ構成

```
progress-lab/
├─ index.html              バリエーション一覧(ランディング)
├─ core/
│  └─ progress-base.js     共通基底クラス ProgressBase
├─ variants/
│  ├─ water/               水位型(完成)
│  │  ├─ water-progress.js
│  │  ├─ demo.html
│  │  └─ README.md
│  └─ tnt/                 TNT爆破型(完成)
│     ├─ tnt-progress.js
│     ├─ demo.html
│     └─ README.md
└─ prototypes/
   └─ progress-lab-4ideas.jsx   構想バリエーションのReactスケッチ
```

## 依存

- `water` / `tnt` は物理エンジン [Matter.js](https://brm.io/matter-js/) を使う
  (未ロードなら cdnjs から自動取得。バンドルする場合は事前に `window.Matter` を用意)。
- ビルドツール不要。ブラウザネイティブの ES Modules で動く。
