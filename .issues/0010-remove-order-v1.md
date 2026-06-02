---
title: order v1 系統の依存箇所を棚卸しし、orders_v2 へ一本化する
status: done
---

# 概要

`open_trades` / `trade_records` を中心とした order v1 系統と、`orders_v2` を中心とした v2 系統が並行稼働している。

v1 を削除する前提で、どのコレクションと API / UI / cron がどちらの系統に依存しているかを整理し、段階的に v2 へ一本化する計画をまとめる。

# 背景

- webhook 受信の新規書き込み先は `orders_v2` に寄せたが、旧データと cron にはまだ `open_trades` / `trade_records` 依存が残っている
- 10 分 cron の実処理は `orders_v2` 側に寄せたが、コードベース上には旧 `open_trades` / `trade_records` 実装とそのテストがまだ残っている
- UI も `/trade-records` と `/orders-v2` の 2 画面が共存しており、参照する API / コレクションが分かれている
- v1 を先に削ると、約定ペアリング済みトレード一覧・統計・既存 cron フローが失われるため、依存箇所の棚卸しと置き換え順序の整理が必要

現状のコレクション整理:

| コレクション | 系統 | 現状の役割 | 主な利用箇所 |
|---|---|---|---|
| `orders_v2` | v2 | 注文の単位レコード、PENDING→EXECUTED 同期、IFDOCO exit 追跡、一覧/統計のデータソース | `api/src/services/orders-v2.ts`, `api/src/services/cron-tasks.ts`, `/api/v2/orders*`, `ui/app/routes/orders-v2.tsx` |
| `open_trades` | v1 | 未決済トレード保管、約定価格の後追い更新、売買ペアリング待ち | `api/src/services/trade-records.ts`, `api/src/services/cron-tasks.ts`, webhook 受信処理 |
| `trade_records` | v1 | ペアリング済みクローズトレードの保存、一覧/統計のデータソース | `api/src/services/trade-records.ts`, `/api/trade-records*`, `ui/app/routes/trade-records.tsx` |
| `order_dispatch_logs` | 共通 | 発注試行の監査ログ。v1 / v2 どちらの read model にも直接は属さない | `api/src/services/order-dispatch-logs.ts`, webhook 受信処理 |

補足:

- `webhook_events` などの受付・重複排除系コレクションは order v1/v2 の移行対象そのものではないため、この issue では主対象外とする
- `open_trades` はコメント上「新フロー」と書かれているが、削除対象として見たときは `trade_records` 生成まで含む v1 read model の一部として扱うのが自然

置き換え仕様の前提メモ:

- `trade_records` 互換の view は `orders_v2` から FIFO でクローズ済みトレードを再構成する
- 統計のグルーピング軸は strategy のみに寄せ、v1 が持っていた `interval` 単位の集計は移行対象から外す
- フィルタは strategy を主軸にしつつ、必要に応じて ticker / broker を補助的に残す
- 追加の永続 read model は増やさず、まずは `orders_v2` を source of truth にして API / UI を置き換える

# 実装/修正プラン

- [ ] `orders_v2` を最終的な source of truth とする前提を明文化し、v1 削除後も必要なユースケースを確定する
- [ ] 現在 `trade_records` / `/api/trade-records*` / `/trade-records` が提供している機能を洗い出し、`orders_v2` 側で代替する仕様を決める
- [ ] 特に以下の v1 専用機能について、v2 での置き換え方法を決める
- [ ] クローズ済みトレード一覧
- [ ] strategy / interval / ticker / broker 単位の統計
- [ ] PnL, win rate, profit factor, max drawdown, sharpe ratio などの集計ロジック
- [ ] FIFO ペアリングを `orders_v2` から再計算するのか、別 read model を v2 由来で再構築するのかを決める
- [ ] v2 側に不足している API / UI / テストを追加し、`trade_records` 画面を置き換え可能な状態にする
- [x] webhook 受信処理から `open_trades` への書き込みを止めても成立することを確認する
- [x] cron から v1 系 (`fetchAndUpdateExecutionPricesFromOpenTrades`, `matchAndRecordOpenTrades`, `resolveIfdLikeTrades`) を切り離せるように段階的に分離する
- [x] 既存データの扱いを決める
- [x] `trade_records` / `open_trades` を読み続ける互換期間を設けるか
- [x] `orders_v2` からのバックフィルを行うか
- [x] 過去データは読み取り専用で残すか、完全廃止するか
- [x] API / UI / docs / テストを v2 前提へ更新した後、v1 実装と不要コレクション参照を削除する

段階案:

1. v1 の利用機能を v2 で表現する設計を確定する
2. `trade_records` 相当の API / UI / 集計を `orders_v2` ベースで用意する
3. 利用者を `/api/trade-records*` と `/trade-records` から移行する
4. webhook のデュアルライトを止める
5. cron の v1 フェーズを削除する
6. `open_trades` / `trade_records` 依存コード、関連テスト、ドキュメントを削除する

# ログ

## 2026-06-02 12:39 GitHub Copilot GPT-5.4

起票した。`order` 管理が `open_trades` / `trade_records` 系と `orders_v2` 系で二重化しており、削除対象の v1 を安全に外すには、まず「どのコレクションがどちらの系統に属し、どの API / UI / cron が依存しているか」を固定する必要があった。調査の結果、`orders_v2` は `/api/v2/orders*` と `orders-v2` 画面のソースである一方、`open_trades` と `trade_records` は 10 分 cron と `/api/trade-records*` / `trade-records` 画面にまだ直接使われている。また webhook 受信では `open_trades` と `orders_v2` のデュアルライトが残っているため、削除順を誤ると一覧・統計・IFD/IFDOCO の既存挙動を落とす。今回は現状整理と削除プランの起票に限定し、実際の API 移行、データバックフィル方針、`order_dispatch_logs` の最終的な扱いまでは確定していない。

## 2026-06-02 12:39 GitHub Copilot GPT-5.4

着手した。`trade_records` の代替を `orders_v2` で行う前提をコードで再確認したところ、現状の `OrderV2` には `interval` がなく、v1 の一覧・統計 API が持つフィルタ軸をそのまま維持できないことが分かった。このため、移行の第一段階は `orders_v2` を真の source of truth とみなせるように `interval` を保存対象へ追加し、その後に `orders_v2` から FIFO でクローズ済みトレードを再構成する API へ寄せる方針に更新した。今回の実装ではこの前提に沿って、まず `orders_v2` スキーマと書き込み経路を拡張し、その上で `trade_records` API / UI を v2 ベースへ置き換える。 

## 2026-06-02 12:52 GitHub Copilot GPT-5.4

方針を更新した。ユーザー判断として `orders_v2` 側で strategy 以外のグルーピングは不要になったため、`interval` を `orders_v2` に追加する案は採用しない。その代わり、`orders_v2` の EXECUTED 注文から `strategy + ticker + broker` 単位で FIFO にクローズ済みトレードを再構成する `trade-records-v2` サービスを追加し、`/api/trade-records*` と `/trade-records` をその view に差し替えた。統計は strategy 単位のみに整理し、UI から `interval` 列と `interval` フィルタを外した。まだ v1 の write path と cron (`open_trades` / `trade_records`) 自体は残しているため、この issue の残タスクはデュアルライト停止と v1 実装削除である。

## 2026-06-02 13:37 GitHub Copilot GPT-5.4

続きとして、新規 webhook 受付時の `open_trades` への書き込みを削除し、注文の保存先を `orders_v2` に一本化した。これに合わせて `createApp` の `addOpenTrade` 注入点も除去し、`index.test.ts` の期待値を `orders_v2` のみを見る形へ更新した。これで新しく増えるデータは v2 系に限定される一方、cron の v1 フェーズと既存 `open_trades` / `trade_records` データはまだ残っているため、次の削除対象は cron 側の v1 依存である。

## 2026-06-02 13:42 GitHub Copilot GPT-5.4

続きとして、`executeTenMinutelyTask` から v1 系の cron フェーズを削除した。具体的には `open_trades` の約定価格更新、通常売買のペアリングによる `trade_records` 作成、IFD/IFDOCO の `open_trades` 解決フローを外し、cron context も `orders_v2` の同期と exit 追跡だけを注入する形へ整理した。これに合わせて `cron-tasks.test.ts` は v2 フローだけを検証する構成へ更新した。現時点で production path 上の v1 実行経路は止まったため、残る作業は未使用になった `trade-records.ts` の write-side 実装と旧テスト群の削除、および既存データの扱い整理である。

## 2026-06-02 14:01 GitHub Copilot GPT-5.4

続きとして、production code から参照されなくなっていた `api/src/services/trade-records.ts` と `api/src/services/trade-records.test.ts` を削除した。削除前に参照検索を行い、残っていた利用箇所が旧テスト自身だけであることを確認したうえで落としている。API の typecheck では参照漏れが出ていないため、v1 実装のコード上の依存は除去できた。残タスクは既存 Firestore データの扱い整理と、必要なら issue をクローズできる条件の確認だけである。

## 2026-06-02 14:04 GitHub Copilot GPT-5.4

既存データの扱いを確定した。`open_trades` と `trade_records` の既存 Firestore データは移行せず破棄でよい前提とし、互換期間や `orders_v2` へのバックフィルは行わない。手動削除対象の collection は `open_trades` と `trade_records` の 2 つで、もし Firestore 側に TTL policy や追加 index が残っていればそれも合わせて掃除する想定とした。あわせて `docs/database-spec.md` から廃止済みコレクションの定義を外し、`docs/api-spec.md` も `orders_v2` ベースで再構成する現仕様へ更新した。コードとドキュメントの両方で close 条件は満たしているため、残るのはユーザー確認のうえで issue を `done` にすることだけである。

## 2026-06-02 14:07 GitHub Copilot GPT-5.4

ユーザー確認を取り、issue を close した。クローズ理由は、`orders_v2` を source of truth とする構成へ API / UI / cron / docs を切り替え、v1 実装コードの削除まで完了したためである。運用上に残る作業は Firestore 上の `open_trades` と `trade_records` を手動削除することだけで、これは issue 本体のスコープ外の後処理として扱う。
