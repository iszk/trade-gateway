---
title: orders-v2 の view で約定時刻を使う
status: done
---

# 概要

`orders-v2` の view におけるフィルタ条件と画面表示に使う時刻を、`created_at` ではなく `executed_at` 基準へ切り替える。

`executed_at` が存在しない既存データについては、互換性維持のため `created_at` へのフォールバックを維持する。

# 背景

- [0006](./0006-add-execution-time-to-orders-v2-records.md) により、`orders-v2` レコードへ `executed_at` が追加された
- ただし view 側の絞り込みや表示は、引き続き `created_at` ベースのままになっている可能性がある
- 発注時刻と約定時刻がずれる注文では、画面上の時系列や日付フィルタ結果が実際の約定と一致しない
- 特に IFDOCO の exit や指値約定では、ユーザーが見たいのは「いつ作ったか」ではなく「いつ約定したか」である

# 実装/修正プラン

- [x] `orders-v2` view の一覧表示で使っている時刻項目を洗い出す
- [x] 日付フィルタや期間絞り込みを `executed_at ?? created_at` 基準へ変更する
- [x] 画面上の時刻表示も `executed_at ?? created_at` を使うように変更する
- [x] API 側と UI 側のどちらで変換責務を持つか整理し、既存の設計に沿って反映する
- [x] `executed_at` が未設定の既存データでも挙動が壊れないことをテストで担保する
- [x] 必要なら README や関連ドキュメントの表示仕様を更新する

# ログ

## 2026-06-01 00:00 GitHub Copilot GPT-5.4

起票した。`orders-v2` レコードには `executed_at` が入るようになった一方、view 側のフィルタや表示が `created_at` を見続けると、約定ベースでの時系列確認ができない。保存仕様の追加と view 上の利用を分離して追跡するため、`0006` のフォローアップ issue として切り出した。

## 2026-06-01 01:11 GitHub Copilot GPT-5.4

着手した。API では `created_at` 単独の Firestore 範囲検索をやめ、`executed_at` 範囲と `created_at` 範囲を両方取得して `executed_at ?? created_at` で再フィルタ・再ソートするように変更した。これにより「作成は期間外だが約定は期間内」の注文を取り込め、`executed_at` 未設定の既存データは従来どおり `created_at` へフォールバックする。UI では一覧表示の時刻列を `executed_at ?? created_at` に切り替え、フィルタ入力ラベルも約定時刻基準であることが分かる表記へ更新した。加えて、期間抽出の優先順位とフォールバックを固定する単体テストを追加した。クローズ確認はまだ取っていないため、status は `wip` のままにする。

## 2026-06-01 01:15 GitHub Copilot GPT-5.4

検証まで完了した。追加した `api/src/services/orders-v2.test.ts` で `executed_at` 優先と `created_at` フォールバックの期間抽出を確認し、あわせて `mise run test` を実行して終了コード `0` を確認した。今回の変更では表示仕様の説明ドキュメント更新が必要になる既存記述は見当たらなかったため、関連ドキュメントの更新は不要と判断した。残作業は issue をクローズするかどうかの確認のみ。

## 2026-06-01 01:16 GitHub Copilot GPT-5.4

クローズした。クローズ理由: `orders-v2` view における期間フィルタと一覧表示の時刻基準を `executed_at ?? created_at` へ切り替え、`executed_at` 未設定の既存データもフォールバックで扱えることを単体テストと `mise run test` で確認できたため。

## 2026-06-02 10:26 GitHub Copilot GPT-5.4

追加要件に着手した。`orders-v2` の order list は API 側で `executed_at ?? created_at` を昇順ソートしていたため、売買時刻の新しい順で見たい要件に合っていなかった。`createListOrdersV2ByDateRangeFn` の Firestore 取得順と最終ソートを降順へ変更し、既存テストも降順期待値へ更新した。UI 側では日時表示を `Asia/Tokyo` 固定の formatter に寄せ、一覧ヘッダを `Executed At (JST)` に変えて日本時間表示であることを明示した。今回は一覧の並び順と時刻表示の明確化に限定し、フィルタ条件や API パラメータ仕様は変更していない。クローズ確認は未実施のため、status は `wip` のままにする。

## 2026-06-02 10:42 GitHub Copilot GPT-5.4

クローズした。クローズ理由: `orders-v2` の order list を `executed_at ?? created_at` 基準の降順へ変更し、一覧の約定時刻表示も `Asia/Tokyo` 固定で `Executed At (JST)` として明示した。関連する単体テスト更新と `mise run test` の通過まで確認でき、今回依頼された表示変更は完了したため。
