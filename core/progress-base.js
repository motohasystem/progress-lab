/**
 * ProgressBase — progress-lab 全バリエーション共通の基底クラス
 *
 * 契約:
 * - `value` (0–100) が「実進捗」。外部(サーバー等)から流し込む唯一の入力。
 * - 表示は value に正直に追従する。巻き戻り・水増し・速度の捏造をしない。
 *   演出による遅延は許容するが、その場合も完了時に必ず 100% に収束させること。
 * - 完了(表示が100%に到達)したら `complete` イベントを1度だけ発火する。
 *
 * バリエーションは onValueChanged(v) を実装(任意)し、
 * 表示が実進捗に遅延追従する場合は displayValue を上書きする。
 */
export class ProgressBase extends HTMLElement {
  static get observedAttributes() {
    return ["value"];
  }

  #value = 0;
  #completed = false;

  /** 実進捗 (0–100) */
  get value() {
    return this.#value;
  }
  set value(v) {
    v = Math.min(100, Math.max(0, Number(v) || 0));
    if (v === this.#value) return;
    const prev = this.#value;
    this.#value = v;
    if (v < 100) this.#completed = false;
    this.onValueChanged?.(v, prev);
  }

  /** 表示上の進捗。遅延追従するバリエーションは上書きする */
  get displayValue() {
    return this.#value;
  }

  attributeChangedCallback(name, _old, val) {
    if (name === "value") this.value = parseFloat(val);
  }

  /** 表示が100%に到達したバリエーションが呼ぶ(多重発火は抑止される) */
  emitComplete() {
    if (this.#completed) return;
    this.#completed = true;
    this.dispatchEvent(new CustomEvent("complete", { bubbles: true }));
  }

  resetCompleted() {
    this.#completed = false;
  }
}
