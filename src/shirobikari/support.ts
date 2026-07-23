/**
 * サポート状況表示のロジック（HDR ディスプレイ検出 / dynamic-range-limit 対応判定 /
 * サポートリスト描画）。
 */

export type SupportItem = { label: string; ok: boolean; detail?: string };

/**
 * サポート状況の <li> リストを描画する。
 */
export function renderSupportList(el: HTMLUListElement, items: SupportItem[]): void {
  el.innerHTML = items
    .map(
      (item) => `
        <li class="flex items-start gap-2">
          <span class="mt-0.5">${item.ok ? "✅" : "⚠️"}</span>
          <span>
            <span class="text-foreground">${item.label}</span>
            ${item.detail ? `<span class="block text-xs text-muted-foreground">${item.detail}</span>` : ""}
          </span>
        </li>
      `,
    )
    .join("");
}

/**
 * CSS dynamic-range-limit プロパティのサポート判定。
 */
export function supportsDrl(): boolean {
  return typeof CSS !== "undefined" && CSS.supports("dynamic-range-limit", "standard");
}

/**
 * HDR ディスプレイの検出。
 */
export function detectHdrDisplay(): boolean {
  return window.matchMedia("(dynamic-range: high)").matches;
}
