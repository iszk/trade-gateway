---
title: トレード記録・集計システム刷新（V2）の作成
status: done
---

# 1. 背景と課題
現状のシステムでは、Webhook受信時に `open_trades` に一時保存し、約定確認後に BUY と SELL を FIFO（先入れ先出し）アルゴリズムで突き合わせ（ペアリング）して `trade_records` を生成しています。
しかし、このアプローチには以下の課題があります。

* **バグの温床**: BUY/SELL のペアリングロジックは、部分約定や建玉の不整合、手動決済などが挟まった場合に状態が壊れやすく、保守性が極めて低くなっています。
* **集計キーの複雑化**: `strategy`, `interval`, `ticker`, `broker` の複合キーで集計・マッチングを行っているため、データ構造やクエリが複雑になりすぎています。
* **データソースの信頼性**: システム内で価格推測や計算を行っている部分があり、実際のBroker（取引所）API上の確定状態（Source of Truth）との乖離が起きやすい状態です。

# 2. 新システム（V2）の設計方針

ユーザー要件に基づき、これらの課題を解決する新アーキテクチャを以下のように定めます。

## ① ペアリング（BUY-SELL 1対1紐付け）の完全廃止
データベース上で「エントリー」と「エグジット」を明示的に紐付ける設計を廃止します。
代わりに、**「個別の注文・約定履歴（Order / Execution）」を単一のフラットなコレクションに記録**します。
損益（PnL）や勝率、Max Drawdown などの集計は、この単一の時系列履歴をオンザフライでリプレイ（平均建玉単価の再計算やポジションの増減）することで動的に算出します。

## ② 集計軸のシンプル化
`strategy` のみを一意のキーとして集計を行います。
これにより、同じ戦略内でのパフォーマンスが直感的に把握しやすくなり、UIやAPIもシンプルに保てます。

## ③ Webhook起点の意図（Intent）とBroker確定状態（Truth）の分離
Webhookで注文指示（Intent）を受けた時点で、DBにステータス `PENDING` としてドキュメントを作成します。
その後、定期実行バッチ（Cron）がBrokerのAPIを叩いて確定情報（約定価格、手数料、成否など）を取得し、ステータスを `EXECUTED` などに上書き（Update）します。
「APIから取得した確定情報を正とする」運用を徹底します。

## ④ MARKET / IFDOCO 注文への対応
IFD-OCOのような「親注文＋子注文」の複雑なオーダーも、APIの確定状態から独立した「約定イベント」としてトラッキングします。
親注文が約定した時点でポジション増加、子注文（Take Profit / Stop Loss）が約定した時点でポジション減少としてシンプルに扱えます。

---

# 3. データモデル案（Firestore）

既存システムとの共存を考え、新しいコレクション `orders_v2`（または `trade_executions_v2`）を新設します。

## `orders_v2` コレクション構造

* `id` (String): 自動生成 または webhookの `event_id` を派生
* `strategy` (String): 必須（集計の唯一の軸）
* `broker` (String): 取引所 (bitflyer / saxo 等)
* `ticker` (String): 取引ペア
* `side` (String): `BUY` | `SELL`
* `order_type` (String): `MARKET` | `IFDOCO` 等
* `requested_size` (Number): 要求数量
* `executed_size` (Number): 実約定数量（初期値 `0` または `null`）
* `executed_price` (Number): 実約定価格（初期値 `null`）
* `status` (String): `PENDING` | `EXECUTED` | `FAILED` | `CANCELED`
* `exit_sync_status` (String, optional): IFDOCO 親注文の exit 監視状態。`MONITORING` | `COMPLETED`
* `provider_order_ids` (Array<String>): Broker側で発行された注文ID。IFD-OCOなどの複数IDをトラッキング可能にするため配列で保持。
* `created_at` (Timestamp): Webhook受付時刻
* `updated_at` (Timestamp): 最終確認・更新時刻

---

# 4. 実行プラン（移行ステップ）

既存のログシステム（V1）を壊さずに、並行稼働させながら段階的に移行するためのロードマップです。

## Phase 1: データモデルと型の定義
1. `api/src/types/` 配下に V2用データモデル（例: `order_v2.ts`）を定義する。
2. `api/src/services/` 内に `orders_v2` コレクションに対する CRUD 操作（作成、更新、取得）を行う関数群を作成する。

## Phase 2: Webhook受入時のデュアルライト（並行書き込み）追加
1. `api/src/index.ts` のWebhook発注処理を修正する。
2. 現在の `addOpenTrade` に加えて、新しいコレクションへ `status: 'PENDING'` で保存する処理（`addOrderV2` 等）を並行して実行する。
3. *成果*: 既存システムに影響を与えずに、新形式のデータ蓄積が開始される。

## Phase 3: ステータス同期バッチ（Cron）の実装
1. `orders_v2` から `status: 'PENDING'` なドキュメントを抽出する。
2. Broker API (bitFlyer / Saxo) を叩き、実際のステータスと価格を取得する。
3. 取得結果を用いて `orders_v2` のステータスを `EXECUTED` （または失敗）に確定させる同期バッチを新たに実装・組み込む。

## Phase 4: 新しい集計ロジック（PnL / Stats）の実装
1. `orders_v2` の約定履歴を `strategy` ごとに時系列取得する。
2. バックエンド側で履歴を走査し、現在のポジション数、平均取得単価、実現損益（PnL）、勝率などを動的に算出する計算エンジン（Streaming Calculator）を実装する。
3. V2用の新しいAPIエンドポイント（例: `GET /api/v2/stats`）を作成する。

## Phase 5: UI対応と旧システムのフェードアウト
1. UI側（`ui/`）に、新しい API を利用した `strategy` ベースのシンプルな集計画面を構築する。
2. V2 データの正確性とUIの動作が安定したことを確認できたのち、旧システム（`open_trades`, `trade_records`, 古いCronロジック, 旧UIコンポーネント）を安全に削除する。


# ログ・実装コメント・メモ帳

実装時に気になった点や残しておくべき事項を日時とともに追記していきます。

## 2026-05-25: Phase 1 (データモデルと型の定義) 完了
- `api/src/types/order-v2.ts` に `OrderV2` 型を定義しました。
- `api/src/services/orders-v2.ts` に Firestore CRUD 関数を実装しました。
- 気になる点:
  - Timestamp の取り扱いは、Admin SDK に Date を渡し、読み取り時に `.toDate()` で Date に戻す形で実装しました。

## 2026-05-25: Phase 2 (デュアルライト追加) 完了
- `api/src/index.ts` を修正し、Webhook受付時に既存の `open_trades` への保存と並行して、新設した `orders_v2` へ `PENDING` ステータスとして記録（デュアルライト）するようにしました。
- 注文タイプについて、`stop_loss` と `take_profit` が指定されている場合は `IFDOCO` とし、それ以外は `MARKET` とする判別ロジックを採用しました。
- `api/src/index.test.ts` にも `addOrderV2` をモックして検証するアサーションを追加しました。

## 2026-05-25: Phase 3 (ステータス同期バッチの実装) 完了
- `api/src/services/cron-tasks.ts` に `fetchAndUpdatePendingOrdersV2` を実装し、10分おきの Cron タスク内で `PENDING` ステータスの `orders_v2` ドキュメントの約定確認と `EXECUTED` への更新を行うようにしました。
- 気になる点:
  - IFD-OCO のような複合注文の場合、Webhook での生成時は `provider_order_ids` が配列として記録されますが、現在の同期ロジックでは簡易的に「最初の注文ID (親注文)」のみを利用して API 照会しています。子注文の約定確認も含めた厳密な同期は今後の課題とします。
  - 約定数量 (`executed_size`) についても、APIから部分約定などを正確に拾うのではなく、簡易的に要求数量 (`requested_size`) を設定するようにしています。

## 2026-05-25: Phase 4 (新しい集計ロジックの実装) 完了
- `api/src/services/stats-v2.ts` を新設し、`orders_v2` の時系列履歴（`EXECUTED`ステータス）をリプレイして現在のポジション数、平均取得単価、実現損益（PnL）、勝率などを動的に算出する Streaming Calculator を実装しました。
- `api/src/index.ts` に `/api/v2/stats` エンドポイントを追加し、指定した strategy の PnL および勝率等を返すようにしました。
- 気になる点:
  - 計算時、要求数量と実約定数量の差異をより厳密に扱う場合は API クライアントからのデータ取得側も対応する必要があります。現状は簡易的にフォールバック (`order.executed_size || order.requested_size`) しています。
  - 今回は指定した `strategy` のみの集計ですが、後から複数戦略を同時に返却できるような拡張も視野に入れた方が良さそうです。

## 2026-05-25: 部分約定への対応と戦略スキャンの動的化
- `orders_v2` の同期ロジックを強化し、決済注文（IFD-OCO の exit 側）の部分約定に対応しました。
  - `BitflyerClient.getClosingExecution` において、全ての決済子注文の約定履歴を合算して返すように修正しました。
  - `syncExecutionsForExecutedIfdOrders` において、既に exit レコードが存在する場合でも、Broker 側の約定数量が増加していれば `executed_size` と `executed_price` を更新するようにしました。
- IFD-OCO の同期対象とする戦略のハードコードを廃止しました。
  - `orders_v2` の IFDOCO 親注文には `exit_sync_status` を持たせ、`MONITORING` の間だけ exit 同期対象に含めるようにしました。
  - `orders_v2` コレクションに対し、`status: "EXECUTED"` かつ `order_type: "IFDOCO"` かつ `exit_sync_status: "MONITORING"` なドキュメントを直接クエリする `getActiveIfdOrdersV2` 関数を導入しました。
  - exit の `executed_size >= requested_size` が成立した親注文は `exit_sync_status: "COMPLETED"` に更新し、次回以降の再監視対象から外すようにしました。
  - これにより、新しい戦略が追加された場合でも、ソースコードの変更なしに自動的に同期対象に含まれるようになりました。
- 気になる点:
  - Firestore クエリ (`status == "EXECUTED" AND order_type == "IFDOCO" AND exit_sync_status == "MONITORING"`) は、複合インデックスが必要になる可能性があります。
  - 既存の `EXECUTED` な IFDOCO 親注文へは backfill が必要です。未設定レコードは新クエリでは同期対象に入りません。
  - `stats-v2.ts` による再計算時、レコードの更新 (`updated_at`) が発生するため、キャッシュ等の最適化を行う場合は考慮が必要です。

## 2026-05-25: Phase 5 (UI対応と旧システムのフェードアウト) について
- バックエンドの API エンドポイントまで完成したため、要件にある「一旦共存を考えている」という方針に基づき、新旧データの並行蓄積を開始する状態としました。
- 旧システムのロジック (`open_trades`, `trade_records` のペアリング処理など) は削除せずに残してあります。
- 今後、`orders_v2` に十分なデータが蓄積され、V2 API `/api/v2/stats` への疎通・UI表示の構築が完了した段階で、旧システムのコードとCronジョブのフェードアウト（Phase 5 の最終段階）を実施することをおすすめします。
