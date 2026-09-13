import "../global.css";
import "./styles.css";
import { countAll, type TextCounts } from "./count";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

appEl.innerHTML = `
  <main class="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-10">
    <header class="flex flex-col gap-1.5">
      <h1 class="font-serif text-2xl font-bold">文字数カウンター</h1>
      <p class="text-sm text-muted-foreground">テキストの文字数を数えます。絵文字も結合文字も1文字として数えます。</p>
    </header>

    <div class="flex flex-col gap-2">
      <textarea
        id="text-input"
        placeholder="ここにテキストを入力・貼り付け"
        class="w-full min-h-40 field-sizing-content resize-none rounded border border-border bg-background px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      ></textarea>
      <p id="privacy-notice" class="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-bold text-primary">
        入力したテキストはこのページ内だけで処理され、サーバーや外部に一切送信されません（通信ゼロ）
      </p>
      <div class="flex justify-end">
        <button
          type="button"
          id="clear-button"
          class="rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >クリア</button>
      </div>
    </div>

    <section class="flex flex-col gap-2">
      <div class="rounded border border-border px-4 py-4">
        <p class="text-sm text-muted-foreground">文字数</p>
        <p id="count-main" class="font-serif text-4xl font-bold text-foreground">0</p>
      </div>

      <table class="w-full border-collapse text-sm">
        <tbody>
          <tr class="border-b border-border">
            <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">文字数（空白・改行を除く）</th>
            <td id="count-no-whitespace" class="py-1.5 text-right font-mono text-foreground">0</td>
          </tr>
          <tr class="border-b border-border">
            <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">文字数（改行を除く）</th>
            <td id="count-no-newline" class="py-1.5 text-right font-mono text-foreground">0</td>
          </tr>
          <tr>
            <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">行数</th>
            <td id="count-lines" class="py-1.5 text-right font-mono text-foreground">0</td>
          </tr>
        </tbody>
      </table>

      <details id="reference-details" class="rounded border border-border px-4 py-2.5">
        <summary class="cursor-pointer text-sm font-bold text-muted-foreground">参考値</summary>
        <table class="mt-2 w-full border-collapse text-sm">
          <tbody>
            <tr class="border-b border-border">
              <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">コードポイント数</th>
              <td id="count-codepoints" class="py-1.5 text-right font-mono text-foreground">0</td>
            </tr>
            <tr class="border-b border-border">
              <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">UTF-16長（.length）</th>
              <td id="count-utf16" class="py-1.5 text-right font-mono text-foreground">0</td>
            </tr>
            <tr class="border-b border-border">
              <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">UTF-8バイト数</th>
              <td id="count-utf8" class="py-1.5 text-right font-mono text-foreground">0</td>
            </tr>
            <tr>
              <th scope="row" class="py-1.5 text-left font-normal text-muted-foreground">全角換算</th>
              <td id="count-fullwidth" class="py-1.5 text-right font-mono text-foreground">0</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>
  </main>
`;

const textInputEl = document.getElementById("text-input") as HTMLTextAreaElement;
const clearButtonEl = document.getElementById("clear-button") as HTMLButtonElement;
const countMainEl = document.getElementById("count-main") as HTMLParagraphElement;
const countNoWhitespaceEl = document.getElementById("count-no-whitespace") as HTMLTableCellElement;
const countNoNewlineEl = document.getElementById("count-no-newline") as HTMLTableCellElement;
const countLinesEl = document.getElementById("count-lines") as HTMLTableCellElement;
const countCodepointsEl = document.getElementById("count-codepoints") as HTMLTableCellElement;
const countUtf16El = document.getElementById("count-utf16") as HTMLTableCellElement;
const countUtf8El = document.getElementById("count-utf8") as HTMLTableCellElement;
const countFullwidthEl = document.getElementById("count-fullwidth") as HTMLTableCellElement;

/** 全角換算は0.5刻みで出るため、整数のときだけ小数点を省く */
function formatFullwidth(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function render(counts: TextCounts): void {
  countMainEl.textContent = String(counts.graphemes);
  countNoWhitespaceEl.textContent = String(counts.graphemesExcludingWhitespace);
  countNoNewlineEl.textContent = String(counts.graphemesExcludingNewline);
  countLinesEl.textContent = String(counts.lines);
  countCodepointsEl.textContent = String(counts.codePoints);
  countUtf16El.textContent = String(counts.utf16Length);
  countUtf8El.textContent = String(counts.utf8Bytes);
  countFullwidthEl.textContent = formatFullwidth(counts.fullwidthEquivalent);
}

function update(): void {
  render(countAll(textInputEl.value));
}

textInputEl.addEventListener("input", update);

clearButtonEl.addEventListener("click", () => {
  textInputEl.value = "";
  textInputEl.focus();
  update();
});

update();
