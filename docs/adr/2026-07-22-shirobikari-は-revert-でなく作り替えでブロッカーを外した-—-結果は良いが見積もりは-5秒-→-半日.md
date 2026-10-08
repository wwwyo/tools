# `shirobikari` は revert でなく作り替えでブロッカーを外した — 結果は良いが見積もりは 5秒 → 半日にスライドした

- Status: Accepted
- Date: 2026-07-22

07-21 の deploy を止めていた `src/shirobikari/main.ts` の未完成差分について、朝の TODO は「`git checkout` で 5秒」と書いていた。実際には**「SDR 画像を光らせる」変換ツールへの作り替え**をやり切って [#3](https://github.com/wwwyo/tools/pull/3) を merge・deploy した。ブロッカーは消え価値も足されたので結果は成功だが、**最安手を計画に書いて実行時に高い手へ乗り換えた**のは「新規が出口の詰まりを隠す」の変種でもある（今回は新規が出口そのものに接続したので害が出なかっただけ）。設計面の判断: 出力は **UltraHDR JPEG**（HDR 非対応環境では普通の JPEG として壊れない graceful degradation）と **PQ JPEG** の2系統に分け、用途で使い分ける（単一フォーマットへ寄せるより現実的）。旧解説デモは削除せず `<details>` へ退避し、`main.ts` は UI 配線だけに残して `convert.ts`（画素変換）/ `ultrahdr.ts`（コンテナ組み立て）/ `pqjpeg.ts` / `demos.ts` に分割。**スライダー文言は「ヘッドルーム / カーブ」→「明るさ / 光らせる範囲」**へ（正確さより非専門家に伝わることを優先）
