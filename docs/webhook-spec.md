# Webhook 仕様（MVP）

## 目的
TradingView から受信するアラートを正規化し、bitFlyer 向け発注リクエストに変換できる最小契約を定義する。

## スコープ
- 対象: bitFlyer 向け現物売買の成行注文、サクソバンク証券向け成行注文（子注文含む）
- 非対象: 指値注文（成行のみ）

## 実装方針（MVP）
- `src/index.ts` は broker 非依存とし、Webhook受信処理に集中する
- broker固有処理は dispatcher 層を介して実行する
- 抽象化は軽量に留める（dispatcher + broker handler）

## エンドポイント
- Method: `POST`
- Path: `/api/webhooks/tradingview`
- Content-Type: `application/json`
- Response Header: `X-Request-Id`

## リクエストスキーマ

### 必須項目
- `time` (string): シグナル発生時刻。ISO 8601形式の文字列（例: `2026-03-24T12:00:00Z`）
- `occurred_at` (integer): TradingView 側からこちらに向けて Webhook が送信された時刻（unix milliseconds）
- `symbol` (string): 取引銘柄。`"brokerName:brokerTickerCode"` の形式（例: `"bitflyer:FX_BTC_JPY"`, `"saxo:CfdOnIndex:4911"`）を必須とする。ここからブローカーとティッカーが決定される。`brokerTickerCode` は broker に渡せる正規値を指定する。
- `side` (string): `BUY` または `SELL`
- `size` (number, optional): 発注数量。`WEBHOOK_CAPPED` と policy 未登録 fallback では必須。`MANAGED` では省略でき、指定時は正の有限値として検証するが数量計算には使用しない。
- `webhook_secret` (string): 共有シークレット

### 任意項目
- `event_id` (string): 送信元で一意となるイベントID。未指定時は `time`, `symbol`, `side` などから自動生成される。
- `order_type` (string): 指定時は `MARKET` のみ許可
- `price` (number): 価格情報。`stop_loss` / `take_profit` を使用する場合は必須
- `interval` (string): TradingView の時間足
- `strategy` (string): シグナル生成元の戦略名
- `dry_run` (boolean): policy-backed では sizing / payload 検証だけを行い、実注文を作成せず reservation を release する。policy 未登録の migration fallback は既存挙動を維持する
- `strategy_id` (string): sizing policy を参照する strategy ID。英数字、`_`、`-`のみ。指定時は `strategy` より優先する。
- `note` (string): 運用メモ
- `stop_loss` (string): ストップロス幅。`"2.5%"` のようなパーセント文字列で指定。`price` を基準に計算される
- `take_profit` (string): テイクプロフィット幅。`"2.5%"` のようなパーセント文字列で指定。`price` を基準に計算される

### 認証方式（直接連携）
- TradingView 側で任意カスタムヘッダは付与できない前提とする
- 認証は body の `webhook_secret` 一致で行う
- 送信元 IP を allowlist で制限する

## バリデーション
1. JSON であること
2. 必須項目が欠落していないこと
3. `time` が ISO 8601 形式の文字列であること
4. `occurred_at` が Unix time（milliseconds）の数値であること
5. `side` が許可値であること
6. `size` が指定されている場合は number であること。正数・必須性は解決した sizing mode に従う
7. `symbol` が 1 文字以上であること（`brokerName:brokerTickerCode` 形式）
8. `order_type` 指定時は許可値であること（MVP は `MARKET` のみ）
9. `webhook_secret` がサーバ設定値と一致すること
10. 送信元 IP が allowlist に含まれること

## TradingView 連携制約
- Webhook の送信は HTTP POST
- Alert message が valid JSON の場合のみ `application/json`
- 送信先 URL のポートは 80/443 のみ
- IPv6 は非対応
- 2FA 有効化が必要
- 許可対象 IP（2026-03-18 時点）
  - `52.89.214.238`
  - `34.212.75.30`
  - `54.218.53.128`
  - `52.32.178.7`

## TradingView Alert 設定

### Webhook URL
TradingView の Alert notification 設定で以下の URL を指定：

```
https://api.trade-gateway.example.com/api/webhooks/tradingview
```

> **プレースホルダ**: `api.trade-gateway.example.com` は実際のホスト名に置き換え

### Alert Message 設定
Alert の "Message" フィールドに以下の JSON を指定（改行は削除）：

```json
{
  "time": "{{time}}",
  "occurred_at": {{timenow}},
  "symbol": "bitflyer:FX_BTC_JPY",
  "side": "{{strategy.order.action}}",
  "size": {{strategy.order.contracts}},
  "webhook_secret": "__YOUR_WEBHOOK_SECRET__",
  "strategy": "my awesome strategy",
  "interval": "{{interval}}",
  "price": {{strategy.order.price}},
  "note": "{{strategy.order.comment}}",
  "stop_loss": "2.0%",
  "take_profit": "3.0%"
}
```

> **プレースホルダの説明**:
> - `{{time}}`: 現在時刻の ISO 8601 time（自動置換）
> - `{{timenow}}`: 現在時刻の Unix time（milliseconds, 自動置換）
> - `bitflyer:FX_BTC_JPY`: 取引銘柄に応じて broker 側の正規 ticker に変更
> - `BUY` / `SELL`: シグナルに応じて変更
> - `0.01`: 発注単位に応じて変更
> - `__YOUR_WEBHOOK_SECRET__`: サーバ管理者から支給されたシークレットに置き換え
> - `strategy`, `note`: 任意項目、不要なら削除可
> - `stop_loss`, `take_profit`: 任意項目。`"2.0%"` のように記述。`price` も同時に指定が必要

### TradingView Pine Script での例
Strategy の Alert callback 例：

```pine
strategy.entry("Long", strategy.long, when=longSignal)
alert(json.stringify(
  object.new(
    time=str.tostring(time),
    occurred_at=timenow,
    symbol="bitflyer:FX_BTC_JPY",
    side="BUY",
    size=0.01,
    webhook_secret="__YOUR_WEBHOOK_SECRET__",
    strategy="MA Crossover",
    note="Condition met"
  )
))
```

## 重複判定
- 一意キーは `event_id`
- `event_id` が未指定の場合は、ペイロードの項目 (`time`, `symbol`, `side` など) から自動的にハッシュ生成される。
- 生成後または指定された `event_id` が既処理なら重複として拒否する

## レスポンス

### 成功
- Status: `202 Accepted`
- 備考: broker dispatch が失敗した場合も Webhook は受理済みとして `202` を返す（失敗詳細はログで追跡）
- symbol が停止中の場合も `202 Accepted` を返し、broker dispatch は行わない
- Body:

```json
{
  "status": "accepted",
}
```

### エラー
- `400 Bad Request`: 形式不正・必須欠落・許可値違反
- `401 Unauthorized`: `webhook_secret` 不正
- `403 Forbidden`: 送信元 IP 不正
- `409 Conflict`: 重複イベント
- `500 Internal Server Error`: 想定外エラー

### エラーコード / reason 対応

| HTTP Status | `error.code` | `reason` | 条件 |
| --- | --- | --- | --- |
| `400` | `INVALID_REQUEST` | `invalid_content_type` | `Content-Type` が `application/json` ではない |
| `400` | `INVALID_REQUEST` | `invalid_json` | JSON パースに失敗した |
| `400` | `INVALID_REQUEST` | `validation_error` | スキーマ検証に失敗した |
| `401` | `INVALID_WEBHOOK_SECRET` | `invalid_webhook_secret` | `webhook_secret` が一致しない |
| `403` | `FORBIDDEN_SOURCE_IP` | `forbidden_source_ip` | 送信元 IP が allowlist に含まれない |
| `409` | `DUPLICATED_EVENT` | `duplicated_event` | `event_id` が既処理 |

### Symbol 停止中

`tradable_symbols/{broker}:{ticker}` の `trade_control.status` が `paused` の場合、Webhook は受理するが発注しない。

- `webhook_events.status`: `suppressed`
- `webhook_events.rejection_reason`: `symbol_paused`
- `order_dispatch_logs.result`: `suppressed`
- `order_dispatch_logs.error_code`: `SYMBOL_PAUSED`
- レスポンス: `202 Accepted`

broker × symbol reconciliation は read-only の監視であり、差分や取得失敗を検出しても symbol pause、`POSITION_NOT_READY`、縮小を含む webhook 抑止を追加しない。手動売買による broker excess/shortage も同じ MISMATCH 集約ログへ残るが、Webhook の受付・dispatch は既存の trade-control と sizing policy の契約に従う。保存状態が不正な場合も reconciliation は write せず、警告ログだけを残す。

### Sizing policy による webhook 判定

symbol が active で strategy-symbol policy が登録されている場合、Webhook は strategy、symbol、position、同一 event の reservation を atomic reservation transaction で読み、同じ snapshot の `calculateOrderSize` の decision を発注承認に使用する。`DISPATCH` のときだけ reservation の作成と position の `pending_delta` 加算を commit し、transaction が返した `effective_size` を broker、`orders_v2`、dispatch log のすべてに渡す。独立 read した position や webhook の `size` を発注数量として再利用しない。

- `WEBHOOK_CAPPED`: `size` を候補数量として扱う。欠落は `SIZE_REQUIRED`、正数でない値は `INVALID_SIZE`、`quantity_step` 不一致は `INVALID_SIZE_INCREMENT`。
- `MANAGED`: policy の `base_order_size` を使用する。`size` は指定時だけ監査し、`input_size_ignored: true` とする。`stop_loss`、`take_profit`、`stop_loss_pct`、`take_profit_pct` は `MANAGED_ATTACHED_ORDERS_UNSUPPORTED` で拒否する。
- policy が disabled、上限・no-flip・最小数量・position 状態により発注できない場合は `202` と `dispatch_status: "suppressed"` を返す。
- policy-backed の `DISPATCH` は reservation と webhook event の保存後に broker へ dispatch し、レスポンスは従来どおり `202` と `dispatch_status: "sizing_approved"` を返す。broker の成否や保存処理の詳細は同期レスポンスへ露出しない。
- webhook event の保存が失敗した場合、または duplicate event が判明した場合は broker を呼ばない。作成済み reservation は未発注が確定したときだけ `CONFIRMED_FAILURE` として release し、release に失敗した場合は安全側に保持して構造化ログで復旧対象を示す。
- broker の明確な拒否（HTTP 4xx。ただし HTTP 408 は除く）は `CONFIRMED_FAILURE` として reservation を release する。HTTP 408、transport exception、timeout、5xx、成功 response の provider order ID 欠落、`orders_v2` 保存失敗など受付有無を確定できない場合は `UNKNOWN` として reservation と position を `MANUAL_REVIEW` にし、pending を保持する。成功かつ追跡情報を保存できた場合だけ `CONFIRMED_SUCCESS` として reservation を `DISPATCHED` にする。
- policy-backed の `dry_run: true` も atomic reservation と sizing を実行し、effective size と監査情報を得る。dispatcher には `dryRun: true` を渡し、検証結果の provider ID `DRY_RUN` を dispatch log に保存するが、実注文ではないため `orders_v2` は作成しない。外部 broker へ送信していないことが契約で保証されるため、dispatcher が UNKNOWN を返しても reservation は `CONFIRMED_FAILURE` として `RELEASED` にし、pending を戻す。release に失敗した場合は reservation を安全側に保持して event / reservation / effective size を構造化ログに残す。レスポンスは通常の policy-backed dispatch と同じ `202` / `sizing_approved` とする。policy 未登録時の migration fallback における dry-run は従来挙動を維持する。

decision の拒否は `400`、抑止は `202` で、いずれも `event_id` と `sizing_decision` を返す。`sizing_decision` には `kind`、`reason`、`sizing_mode`、`policy_version`、`input_size`、`effective_size`、`input_size_ignored`、calculator の `details` を含む。policy/constraints/position の欠落・破損は fail-closed である。

`strategy_id` がない場合、legacy `strategy` の前後空白を除去し、連続 whitespace を `_` に変換した値を policy lookup に使用する。どちらもない場合は `unknown` を使用する。legacy `strategy` は orders の表示値として保持し、event ID 生成規則には `strategy_id` を追加しない。

policy 未登録時は `ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK=true`（既定値）の間だけ、正の `size` を必須とする既存 dispatch path を使用する。この fallback は sizing mode ではない。`false` にすると `POLICY_NOT_FOUND` を返して発注しない。環境変数は `true` または `false` 以外を許可しない。

## ログ仕様
- 受信ログ: `event = "webhook:received"`
- 受理ログ: `event = "webhook:accepted"`
- 拒否ログ: `event = "webhook:rejected"`（入力拒否に加え、broker dispatch failure もここで記録）
- 抑止ログ: `event = "webhook:suppressed"`（symbol 停止中など、受理したが発注しなかった場合）
- 各ログは `request_id` を含む
- 拒否ログは `reason`, `error`, `event_id`, `rawBody`, `payload` を可能な範囲で含む
- `webhook_secret` はログ出力時に `[REDACTED]` へマスクする
- policy-backed decision のログにも `webhook_secret` を出力しない

broker dispatch の `order_dispatch_logs` には、発注に使った `size` / `effective_size` に加えて、policy 経路では `input_size`（入力がある場合のみ）、`sizing_mode`、`policy_version`、`position_before`、`position_after`、`decision_reason`、`strategy_id`、`symbol_id`、`order_id`、`reservation_id` を保存する。broker が返した場合は `provider_order_id` も保存する。policy-backed dry-run では `dry_run: true` と `provider_order_id: "DRY_RUN"` を保存する。`certainty` は `CONFIRMED_SUCCESS`、`CONFIRMED_FAILURE`、`UNKNOWN` を区別し、`orders_v2` 保存失敗や監査保存失敗も provider ID と event / reservation ID を含む構造化ログから追跡できるようにする。

## 受け入れ観点
- 正常系: 正常 payload + 正しい `webhook_secret` + 許可 IP + 未処理 event_id で `202`
- 異常系: `webhook_secret` 不正で `401`
- 異常系: 許可外 IP で `403`
- 異常系: 必須欠落で `400`
- 異常系: 同一 event_id 再送で `409`

## サンプルペイロード

### リクエスト例 1: BUY シグナル

```json
{
  "time": "2026-03-19T00:00:00.000Z",
  "occurred_at": 1773930645000,
  "symbol": "bitflyer:FX_BTC_JPY",
  "side": "BUY",
  "order_type": "MARKET",
  "size": 0.05,
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2",
  "strategy": "MA Crossover Strategy",
  "note": "50EMA > 200EMA on 4H chart"
}
```

### リクエスト例 3: ストップロス / テイクプロフィット付き（サクソバンク向け）

```json
{
  "time": "2026-03-19T01:00:00.000Z",
  "occurred_at": 1773935200000,
  "symbol": "saxo:CfdOnIndex:4911",
  "side": "BUY",
  "size": 1,
  "price": 18500.0,
  "stop_loss": "2.0%",
  "take_profit": "3.0%",
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2"
}
```

> BUY の場合、`stop_loss` は `price * (1 - 2.0%)` = `18130.0`、`take_profit` は `price * (1 + 3.0%)` = `19055.0` で子注文が発注される。

### リクエスト例 2: SELL シグナル（最小限の項目）

```json
{
  "time": "2026-03-19T02:00:00.000Z",
  "occurred_at": 1773935130000,
  "symbol": "bitflyer:FX_BTC_JPY",
  "side": "SELL",
  "size": 0.05,
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2"
}
```

### レスポンス例（成功）

```json
{
  "status": "accepted",
}
```

HTTP Status: `202 Accepted`

### レスポンス例（エラー）

#### webhook_secret 不正
Status: `401 Unauthorized`
```json
{
  "status": "unauthorized",
  "error": "Invalid webhook_secret"
}
```

#### 必須項目欠落
Status: `400 Bad Request`
```json
{
  "status": "bad_request",
  "error": "Missing required field: size"
}
```

#### 重複イベント
Status: `409 Conflict`
```json
{
  "status": "conflict",
  "error": "Event already processed",
}
```
