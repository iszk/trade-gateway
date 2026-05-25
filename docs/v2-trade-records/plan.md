# トレード記録・集計システム刷新（V2）の検討結果と実行プラン

## 1. 背景と課題
現状のシステムでは、Webhook受信時に `open_trades` に一時保存し、約定確認後に BUY と SELL を FIFO（先入れ先出し）アルゴリズムで突き合わせ（ペアリング）して `trade_records` を生成しています。
しかし、このアプローチには以下の課題があります。

* **バグの温床**: BUY/SELL のペアリングロジックは、部分約定や建玉の不整合、手動決済などが挟まった場合に状態が壊れやすく、保守性が極めて低くなっています。
* **集計キーの複雑化**: `strategy`, `interval`, `ticker`, `broker` の複合キーで集計・マッチングを行っているため、データ構造やクエリが複雑になりすぎています。
* **データソースの信頼性**: システム内で価格推測や計算を行っている部分があり、実際のBroker（取引所）API上の確定状態（Source of Truth）との乖離が起きやすい状態です。

## 2. 新システム（V2）の設計方針

ユーザー要件に基づき、これらの課題を解決する新アーキテクチャを以下のように定めます。

### ① ペアリング（BUY-SELL 1対1紐付け）の完全廃止
データベース上で「エントリー」と「エグジット」を明示的に紐付ける設計を廃止します。
代わりに、**「個別の注文・約定履歴（Order / Execution）」を単一のフラットなコレクションに記録**します。
損益（PnL）や勝率、Max Drawdown などの集計は、この単一の時系列履歴をオンザフライでリプレイ（平均建玉単価の再計算やポジションの増減）することで動的に算出します。

### ② 集計軸のシンプル化
`strategy` のみを一意のキーとして集計を行います。
これにより、同じ戦略内でのパフォーマンスが直感的に把握しやすくなり、UIやAPIもシンプルに保てます。

### ③ Webhook起点の意図（Intent）とBroker確定状態（Truth）の分離
Webhookで注文指示（Intent）を受けた時点で、DBにステータス `PENDING` としてドキュメントを作成します。
その後、定期実行バッチ（Cron）がBrokerのAPIを叩いて確定情報（約定価格、手数料、成否など）を取得し、ステータスを `EXECUTED` などに上書き（Update）します。
「APIから取得した確定情報を正とする」運用を徹底します。

### ④ MARKET / IFDOCO 注文への対応
IFD-OCOのような「親注文＋子注文」の複雑なオーダーも、APIの確定状態から独立した「約定イベント」としてトラッキングします。
親注文が約定した時点でポジション増加、子注文（Take Profit / Stop Loss）が約定した時点でポジション減少としてシンプルに扱えます。

---

## 3. データモデル案（Firestore）

既存システムとの共存を考え、新しいコレクション `orders_v2`（または `trade_executions_v2`）を新設します。

### `orders_v2` コレクション構造

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
* `provider_order_ids` (Array<String>): Broker側で発行された注文ID。IFD-OCOなどの複数IDをトラッキング可能にするため配列で保持。
* `created_at` (Timestamp): Webhook受付時刻
* `updated_at` (Timestamp): 最終確認・更新時刻

---

## 4. 実行プラン（移行ステップ）

既存のログシステム（V1）を壊さずに、並行稼働させながら段階的に移行するためのロードマップです。

### Phase 1: データモデルと型の定義
1. `api/src/types/` 配下に V2用データモデル（例: `order_v2.ts`）を定義する。
2. `api/src/services/` 内に `orders_v2` コレクションに対する CRUD 操作（作成、更新、取得）を行う関数群を作成する。

### Phase 2: Webhook受入時のデュアルライト（並行書き込み）追加
1. `api/src/index.ts` のWebhook発注処理を修正する。
2. 現在の `addOpenTrade` に加えて、新しいコレクションへ `status: 'PENDING'` で保存する処理（`addOrderV2` 等）を並行して実行する。
3. *成果*: 既存システムに影響を与えずに、新形式のデータ蓄積が開始される。

### Phase 3: ステータス同期バッチ（Cron）の実装
1. `orders_v2` から `status: 'PENDING'` なドキュメントを抽出する。
2. Broker API (bitFlyer / Saxo) を叩き、実際のステータスと価格を取得する。
3. 取得結果を用いて `orders_v2` のステータスを `EXECUTED` （または失敗）に確定させる同期バッチを新たに実装・組み込む。

### Phase 4: 新しい集計ロジック（PnL / Stats）の実装
1. `orders_v2` の約定履歴を `strategy` ごとに時系列取得する。
2. バックエンド側で履歴を走査し、現在のポジション数、平均取得単価、実現損益（PnL）、勝率などを動的に算出する計算エンジン（Streaming Calculator）を実装する。
3. V2用の新しいAPIエンドポイント（例: `GET /api/v2/stats`）を作成する。

### Phase 5: UI対応と旧システムのフェードアウト
1. UI側（`ui/`）に、新しい API を利用した `strategy` ベースのシンプルな集計画面を構築する。
2. V2 データの正確性とUIの動作が安定したことを確認できたのち、旧システム（`open_trades`, `trade_records`, 古いCronロジック, 旧UIコンポーネント）を安全に削除する。
