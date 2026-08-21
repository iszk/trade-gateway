# DB 仕様（MVP / Firestore）

## 目的
webhook 重複防止、発注監査、注文状態、銘柄制御、Saxo 認証状態、cron 実行状態に必要なデータモデルを定義する。

## 採用 DB
- Firestore（Native mode）

## 方針
- すべての日時は UTC で保存する
- MVP ではコレクション設計を最小限にし、過剰な正規化は行わない
- 整合性は Firestore のトランザクションとアプリケーション制御で担保する
- Saxo 認証トークンは `saxo_auth_data/saxo_auth` の `encryptedTokens` v1 として暗号化保存し、平文 token field は保存しない

## コレクション定義（論理）

## 1. `webhook_events`
受信 webhook の受付記録と重複判定に利用する。

### ドキュメント ID
- `{broker}:{symbol}:{event_id}`
- 例: `bitflyer:BTC_JPY:evt-001`

### フィールド
- `event_id` (string, required)
- `source` (string, required)
- `broker` (string, required)
- `symbol` (string, required)
- `side` (string, required)
- `order_type` (string, required)
- `size` (number, optional) — `MANAGED` の size 省略を許可。指定された入力値は `input_size` にも監査保存する
- `occurred_at` (timestamp, required)
- `received_at` (timestamp, required)
- `status` (string, required)
  - `accepted` | `rejected` | `suppressed`
- `rejection_reason` (string, optional)
- `effective_strategy_id` (string, optional)
- `sizing_mode` (string, optional) — `WEBHOOK_CAPPED` | `MANAGED`
- `input_size` (number, optional)
- `effective_size` (number, optional)
- `decision_kind` (string, optional) — `REJECT` | `SUPPRESS` | `DISPATCH`
- `decision_reason` (string, optional) — machine-readable sizing reason
- `decision_details` (map, optional) — calculator の監査詳細
- `input_size_ignored` (boolean, optional) — `MANAGED` で input size を計算に使わなかった場合
- `expire_at` (timestamp, required, TTL 用)

policy-backed webhook の `DISPATCH` は atomic reservation transaction による予約作成と position の `pending_delta` 加算を伴う受付記録である。transaction の同じ snapshot から得た `effective_size` だけを broker、`orders_v2.requested_size`、dispatch log に伝播する。event 保存後に broker を呼び、event 保存失敗または duplicate では broker を呼ばず、作成済み reservation を明確な未発注として確認できる場合だけ release する。`dry_run: true` では reservation / sizing と payload 検証まで通常どおり行うが、dispatcher が broker client の dry-run 契約で外部送信を抑止し、`orders_v2` は作成しない。`DRY_RUN` を provider ID として dispatch log に残し、reservation は `RELEASED`、pending は同一 transaction で戻す。dry-run dispatcher の結果が UNKNOWN でもこの未送信契約を根拠に release する。

### 重複判定仕様
- `{broker}:{symbol}:{event_id}` をドキュメント ID とし、作成時は存在しないことを前提条件にする
- 既存ドキュメントがある場合は重複として扱い、API は `409` を返す
- 重複イベント自体は `webhook_events` に新規保存しない（監査はアプリログで補完）

## 2. `order_dispatch_logs`
ブローカーへの発注試行ログを保持する。

### ドキュメント ID
- 自動採番 ID

### フィールド
- `event_id` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `side` (string, required) — `BUY` | `SELL`
- `size` (number, required)
- `input_size` (number, optional) — webhook に指定された入力数量。`MANAGED` で省略された場合は保存しない
- `effective_size` (number, optional) — policy-backed dispatch では atomic reservation が算出し、実際に broker へ渡した数量。`size` と同値。broker dispatch を伴わない suppression では保存しない
- `sizing_mode` (string, optional) — `WEBHOOK_CAPPED` | `MANAGED`
- `policy_version` (number, optional) — 数量決定に使用した policy version
- `position_before` (number, optional) — reservation commit 前の effective position
- `position_after` (number, optional) — reservation commit 後の effective position
- `decision_reason` (string, optional) — sizing decision の reason
- `dry_run` (boolean, optional) — policy-backed dry-run の dispatch log で `true`。実注文を作成していないことを示す
- `certainty` (string, optional) — `CONFIRMED_SUCCESS` | `CONFIRMED_FAILURE` | `UNKNOWN`
- `strategy_id` (string, optional)
- `symbol_id` (string, optional)
- `order_id` (string, optional) — reservation / `orders_v2` の論理注文 ID
- `reservation_id` (string, optional)
- `provider_order_id` (string, optional) — ブローカー側の注文 ID
- `request_payload` (map, required)
- `response_payload` (map, optional)
- `result` (string, required)
  - `success` | `failure` | `suppressed`
- `error_code` (string, optional)
- `created_at` (timestamp, required)
- `expire_at` (timestamp, required, TTL 用)

## 3. `orders_v2`
注文の source of truth。webhook 受付時に親注文を保存し、cron が約定情報と IFDOCO の exit を同期する。`/api/trade-records*` のクローズ済みトレード一覧・統計は、このコレクションの EXECUTED 注文から FIFO で再構成する。

### ドキュメント ID
- `id`（Webhook の `event_id` など）
- exit 注文は親注文 ID に `-exit` を付与して表現する

### フィールド
- `id` (string, required)
- `strategy` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `side` (string, required) — `BUY` | `SELL`
- `order_type` (string, required) — `MARKET` | `IFDOCO` | `LIMIT` | `STOP`
- `requested_size` (number, required) — broker に渡した effective size。Webhook の input size ではない。policy-backed dry-run では `orders_v2` 自体を作成しない
- `executed_size` (number, required)
- `executed_price` (number | null, required)
- `execution_costs` (map, optional)
  - `commission` (number, optional) — broker execution が返した明示 commission の累積値。`0` は known zero、フィールド不在は unknown
- `executed_at` (timestamp, optional) — `status=EXECUTED` では required
- `status` (string, required) — `PENDING` | `EXECUTED` | `FAILED` | `CANCELED`
- `exit_sync_status` (string, optional) — `MONITORING` | `COMPLETED`
- `provider_order_ids` (string[], required)
- `broker_order_metadata` (map, optional)
  - `bitflyer_parent_order_v1`: parent acceptance id、entry 子注文、TP/SL 子注文の expected/resolved acceptance id を保持する
  - `saxo_order_v1`: entry order id、`ExternalReference`、Saxo related orders の expected/resolved order id を保持する。related order を持たない Saxo MARKET 注文でも entry 同期のため保存する。Saxo の発注レスポンスで related order id が返らない場合、resolved order id は `null` のままとし、exit 同期は安全に no-op する。現状は Saxo 1アカウント前提のため account/client は保存していない。複数アカウント対応時は [saxo.md](./saxo.md) を参照して metadata と polling 状態を account/client ごとに分離する
- `saxo_ifdoco_recovery` (map, optional, internal only)
  - `status` (string, required) — `RETRY_PENDING` | `MANUAL_REVIEW` | `COMPLETED`
  - `attempt_count` (number, required) — broker evidence recovery の累積試行回数
  - `last_attempt_at` (timestamp, required)
  - `next_attempt_at` (timestamp, optional) — `RETRY_PENDING` の次回試行可能時刻
  - `result_kind` (string, required) — 最終 recovery result または内部判定
  - `reason` (string, optional) — 集約監視・手動確認用の失敗理由
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)

### 制約
- 親注文・exit 注文ともにドキュメント ID を一意キーとして upsert / update する
- `orders_v2` の entry 同期では、execution が `requested_size` 以上なら `EXECUTED`、部分 execution と confirmed cancel/expire が共存する場合は execution snapshot を保持して `CANCELED`、execution なしの confirmed cancel/expire は `CANCELED` とする。`Placed + Rejected` は confirmed fill/placement がない場合だけ `FAILED` とする。rejected cancel/change、`DoneForDay`、未知または曖昧な activity は `PENDING` を継続する
- 部分 terminal の snapshot は `executed_price`、`executed_size`、`executed_at`、取得できた `execution_costs.commission` を保存する。commission の `0` は known zero、field 不在は unknown として区別し、terminal reason は DB schema に保存しない
- 同一 execution snapshot、status、metadata の再取得では `updated_at` を進める Firestore update を発行しない。requested size を超える overfill は status・execution とも更新しない
- orders_v2 の約定同期は専用の Firestore transaction で document を再読込して適用する。取得開始時の stale snapshotを直接updateせず、transaction内の最新 `executed_size`、status、execution snapshot、broker metadataを基準に単調mergeする。数量が増えるsnapshotだけが execution fields を更新し、同値では未設定fieldだけを補完し、数量後退や terminal status の downgrade は行わない
- クローズ済みトレードの read model は別コレクションに保存せず、`orders_v2` から再計算する
- 一覧・統計・トレード再構成の日時基準は `executed_at` とする。`status=EXECUTED` で `executed_at` が欠落している既存データは集計対象外とし、`created_at` へはフォールバックしない
- cron による `orders_v2` の約定・exit 同期は `broker_order_metadata` を前提にする。ただし Saxo の `broker=saxo`、`order_type=MARKET`、トップレベル metadata 未設定（field 欠落または `null`）、非空かつ `DRY_RUN` ではない先頭 `provider_order_ids`、有効な side / requested_size をすべて満たす単体 MARKET だけは、先頭 provider order ID を entry `OrderId` とする最小 `saxo_order_v1` metadata（`exits: []`、`external_reference` なし）を10分同期で自己修復する。metadata を生成しただけでは status や execution を変更しない。confirmed fill、cancel/expire、placement rejection は Saxo OrderActivities resolver の結果だけを適用する。no-match、deferred、rate limit、API failure でも metadata-only result は transaction で保存する。provider ID 欠落 / `DRY_RUN`、別 broker、別 kind、malformed または order/provider と矛盾する既存 metadata は API を呼ばず no-op とする
- トップレベル metadata が未設定（field 欠落または `null`）の Saxo IFDOCO は、有効な entry provider ID、side、requested size、`AssetType:Uic` ticker を持つ場合だけ broker evidence recovery candidate に分類する。recovery API は entry/2 child の完全な OrderActivities と、利用可能な open order の `RelatedOpenOrders` を照合する。open-order response は `{ Data: OrderResponse[] }` を runtime validation し、厳密な singleton かつ要求 `OrderId` 一致の場合だけ採用する。空・複数・対象不一致・不正 payload は fail-closed とし、entry と TAKE_PROFIT / STOP_LOSS の全 ID、side、size、type、price、instrument が一意に一致する場合だけ、全 exit ID が非 null の完全な `saxo_order_v1` を返す。entry-only、`exits: []`、partial response、履歴不足、矛盾、曖昧な related order では metadata を返さない
- IFDOCO recovery result は `SUCCESS`、retryable な `TEMPORARY_FAILURE` / `INSUFFICIENT_HISTORY`、非 retryable な `CONFLICT` / `MANUAL_REVIEW` を `reason` とともに返す。10分 cron は recovery state が未設定または試行時刻到来済みの候補を `next_attempt_at`、最終試行、作成時刻、ID の順で公平に選び、1 run 最大2件を処理する
- retryable result は最大5回、10分を基準とする指数 backoff（10、20、40、80分）で再試行する。5回目、非 retryable result、runtime validation に通らない SUCCESS metadata は注文の `status=PENDING` を維持して `MANUAL_REVIEW` へ移す。以後は broker API を再呼び出さない
- SUCCESS metadata は entry と2 exit の ID が全て解決済みであることを再検証し、その metadata を使った通常 entry 照会結果とともに transaction へ渡す。最新 document が PENDING、トップレベル metadata が field 欠落または `null`、recovery state 非更新の場合だけ `broker_order_metadata`、`COMPLETED` state、確認済み execution / terminal 差分を原子的に保存する。競合 metadata、異なる kind、終端状態、先行 recovery 更新は上書きしない。保存後は専用 recovery API を反復せず、途中失敗時も後続 cron の通常 entry / exit 同期へ戻す
- `saxo_ifdoco_recovery` は内部運用情報であり、注文更新 DTO と orders API response から除外する。cron は個別注文ごとの反復 warn を出さず、recovered、retry、manual review、deferred、reason を run 単位で集約ログに記録する
- 合成 metadata の同期結果は `SET_IF_UNSET` guard 付きで transaction 内に適用する。最新のトップレベル metadata が field 欠落または `null` なら metadata と lifecycle 差分を同時に保存し、同一 metadata が先に保存済みなら lifecycle の単調差分だけを適用する。別 metadata または異なる kind が先行保存済みなら metadata・execution・status をすべて保持する。通常の broker metadata merge は従来どおりとする
- `execution_costs` と `execution_costs.commission` は optional とする。Firestore 上で `execution_costs` またはその `commission` field が未設定の場合は、legacy order、broker 未対応、約定情報の欠落などで値が unknown であることを表し、`0` とは区別する。注文更新 API の DTO では DB 上の未設定を `execution_costs: { commission: null }` に正規化して公開する（[注文更新 API OpenAPI](./openapi/order-updates.openapi.yaml)、[API 利用仕様](./api-spec.md#order-updates-api)）。
- commission は broker execution の明示手数料だけを保存する。spread、funding、slippage、売買価格差などの実質コストはこの field に含めず、現行 schema では保存しない。
- TTL は現時点で使用しない

## 4. `tradable_symbols`
broker + ticker のメタデータと、symbol 単位の売買停止状態を保持する。

### ドキュメント ID
- `broker:ticker`
- 例: `bitflyer:BTC_JPY`, `saxo:FX:NAS100`
- broker は最初の `:` より前、ticker は最初の `:` より後ろすべて
- `/` は使用不可

### フィールド
- `id` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `display_name` (string, optional)
- `currency` (string, required) — 例: `JPY`, `USD`
- `note` (string, optional)
- `order_constraints` (map, optional) — broker × ticker 固有の注文数量制約
  - `quantity_step` (number, required) — 有限の正数
  - `min_order_size` (number, required) — 有限の正数
  - `max_order_size` (number, optional) — 有限数かつ `min_order_size` 以上
- `trade_control` (map, required)
  - `status` (string, required) — `active` | `paused`
  - `reason` (string, optional)
  - `updated_at` (timestamp, required)
  - `updated_by` (string, optional)
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)

### 制約
- ドキュメントが存在しない symbol は `active` として扱う
- Webhook で未知の symbol を受けた場合、売買処理とは独立して `currency = JPY` のデフォルトレコードを事後作成する
- `currency` は UI 表示・整理用途であり、Webhook の売買判定では参照しない
- `order_constraints` がない legacy document は制約未設定として読み書きできる。metadata または `trade_control` の更新で既存の制約を削除してはならない
- `order_constraints` が存在する場合は上記の型・範囲を満たす必要があり、不正値は保存せず、読み取り時もエラーとして扱う

## 5. `strategy_symbol_policies`
strategy と tradable symbol の組み合わせごとに、数量計算で使用する固定 sizing policy を保持する。仮想 position、reservation、注文状態はこのコレクションへ保存しない。

### ドキュメント ID
- `{strategy_id}:{symbol_id}`
- 例: `mean_reversion:bitflyer:BTC_JPY`
- `strategy_id` は trim 済みの `[A-Za-z0-9_-]+`。`symbol_id` は既存の `broker:ticker` 形式で `/` を含めない
- `id` fieldにも同じ値を保存し、読み取り時に document ID と `id` / `strategy_id` / `symbol_id` の一致を検証する

### フィールド
- `id` (string, required)
- `strategy_id` (string, required)
- `symbol_id` (string, required)
- `sizing_mode` (string, required) — `WEBHOOK_CAPPED` | `MANAGED`
- `enabled` (boolean, required)
- `max_abs_position` (number, required) — 有限の正数。累積 position 上限
- `no_flip` (boolean, required)
- `base_order_size` (number, required for `MANAGED`) — 有限の正数。`WEBHOOK_CAPPED` には保存しない
- `taper_strength` (number, required for `MANAGED`) — 有限数、`0` 以上 `1` 以下。`WEBHOOK_CAPPED` には保存しない
- `version` (positive integer, required) — 作成時 `1`、更新ごとに1増加
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)

### 制約と更新
- PUT は `tradable_symbols/{symbol_id}` と現在の policy document を同一 Firestore transaction snapshot で読み取る
- symbol が存在しない場合、または `order_constraints` が設定されていない場合は policy を保存しない
- `max_abs_position >= min_order_size` かつ `quantity_step` の整数倍とする。`MANAGED` では `min_order_size <= base_order_size <= max_abs_position`、`base_order_size` は `quantity_step` の整数倍、`max_order_size` 設定時はその以下とする
- `max_abs_position` は累積上限のため、1注文上限である `max_order_size` 以下である必要はない
- `enabled=false` でも同じ検証を行い、不整合な下書きは保存しない。小数 step の判定は浮動小数誤差を許容するが、値を丸めない
- 更新時は全置換し、`created_at` を保持して `updated_at` のみを進める。transaction retry を含む同時 PUT でも version を取りこぼさない
- 保存済み document の型、mode 別 field、日時、ID、version が壊れている場合は暗黙補正せず読み取り・更新を失敗させる

## 6. `strategy_symbol_positions`
strategy × symbol ごとの仮想 position を保持する runtime state。policy の固定設定や reservation の配列は保存しない。

### ドキュメント ID
- policy と同じ `{strategy_id}:{symbol_id}`。`createStrategySymbolPolicyId` と共通の契約を使う
- `strategy_id` は trim 済みの `[A-Za-z0-9_-]+`、`symbol_id` は既存の `broker:ticker` 形式で `/` を含めない
- `id`、`strategy_id`、`symbol_id` は document ID から再計算した値と一致しなければならない

### フィールド
- `id` (string, required)
- `strategy_id` (string, required)
- `symbol_id` (string, required)
- `confirmed_position` (number, required) — broker 約定を反映済みの符号付き数量。有限数、0 許可。BUY 正、SELL 負
- `pending_delta` (number, required) — 予約中の符号付き数量。有限数、0 許可。BUY 正、SELL 負
- `status` (string, required) — `READY` | `MANUAL_REVIEW` | `MISMATCH`
- `policy_version` (number, required) — 数量決定時に参照した正の safe integer。policy 設定値は重複保存しない
- `updated_at` (timestamp, required)
- `reconciled_at` (timestamp | null, required) — 未照合は明示的な `null`。日時は `updated_at` より後にできない

`MANUAL_REVIEW` は dispatch 結果不明等の状態であり、pending を保持する。`MISMATCH` は broker aggregate との差分を表す停止状態で、差分を strategy へ推測配分しない。

## 7. `strategy_symbol_reservations`
event 単位の注文 reservation。position document 内の配列や subcollection ではなく、常に top-level の個別 document として保存する。

### ドキュメント ID
- `strategy_id`、`symbol_id`、`event_id` の UTF-8 byte 長付き tuple を SHA-256 で digest し、`r_<hex>`（固定長）とする
- event ID は `/`、`:`、Unicode、長い値を取り得るため document path へ直接連結しない。空文字または空白だけは拒否する
- `event_id` は document field に元の値を完全に保存し、読み取り時に tuple から再計算した ID と照合する

### フィールド
- `id` (string, required)
- `event_id` (string, required)
- `position_id` (string, required) — `strategy_symbol_positions/{strategy_id}:{symbol_id}` への論理参照
- `strategy_id` (string, required)
- `symbol_id` (string, required)
- `order_id` (string, required) — `orders_v2` の決定済み論理 ID。注文 document 作成前でも保存する
- `reserved_delta` (number, required) — 予約時の符号付き数量。有限かつ非 0。side や policy 設定値は重複保存しない
- `status` (string, required) — `RESERVED` | `DISPATCHED` | `RELEASED` | `MANUAL_REVIEW` | `SETTLED`
- `policy_version` (number, required) — 予約数量決定時に参照した正の safe integer
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required) — `created_at` 以降

状態遷移は自己遷移を冪等として許可する。`RESERVED` からは `DISPATCHED`、`RELEASED`、`MANUAL_REVIEW`、`DISPATCHED` からは `SETTLED`、`MANUAL_REVIEW` からは `DISPATCHED`、`RELEASED`、`SETTLED` へ遷移できる。`RELEASED` と `SETTLED` は終端状態である。timeout や結果不明を `RELEASED` へ自動遷移させず、`MANUAL_REVIEW` として reservation および position の pending を保持する。

両 collection の repository は、検証済み document の全置換保存と document ID lookup による単一取得だけを提供する。position と reservation の同時更新、create-if-absent、compare-and-set、pending の加減算は `strategy-symbol-reservation-service` の atomic transaction の責務である。現時点では backfill、TTL、追加の複合 index は行わない。

### atomic reserve / dispatch outcome

reserve は policy、tradable symbol、position、event reservation の document reference を同一 Firestore transaction snapshot で読み、全 read の後にのみ write を行う。policy、symbol の `order_constraints`、position の保存値は既存の strict parser で検証する。missing や破損値を 0 position・既定 constraint へ補完せず、policy/symbol/position の欠落はそれぞれ `POLICY_NOT_FOUND`、`SYMBOL_NOT_FOUND`、`POSITION_NOT_FOUND`、制約未設定は `SYMBOL_CONSTRAINTS_REQUIRED` として拒否する。position が `READY` 以外の場合は `POSITION_NOT_READY` として suppress し、書き込まない。

reservation が存在しない event で calculator が `DISPATCH` を返した場合だけ、reservation を `RESERVED` で作成し、BUY の正または SELL の負の `reserved_delta` を position の `pending_delta` に加算する。position の `policy_version` と `updated_at` も同じ commit で更新する。calculator の `SUPPRESS` / `REJECT` は reservation を作成せず、position も更新しない。transaction の競合 retry では最新 snapshot から数量を再計算するため、複数の webhook が同じ strategy × symbol の上限を超えて予約することはない。

同じ strategy × symbol × event の reservation が既に存在する場合、identity、order ID、side（`reserved_delta` の符号）が一致すれば calculator を再実行せず `DUPLICATE_EVENT` として suppress する。`RESERVED` の再処理も broker の受付有無を判定できないため再 dispatch しない。一致しない order ID または side は `EVENT_CONFLICT` とし、既存 state と pending を変更しない。

dispatch outcome の更新も reservation と position を同一 transaction で再読込する。`CONFIRMED_SUCCESS` は `RESERVED` または `MANUAL_REVIEW` の reservation を `DISPATCHED` にし、pending は保持する。`CONFIRMED_FAILURE` は `RESERVED` または、手動確認後に未発注と確定した `MANUAL_REVIEW` から `RELEASED` に遷移し、同じ commit で `pending_delta -= reserved_delta` を行う。`RELEASED` への再適用は no-op とし、`DISPATCHED` / `SETTLED` からの release は拒否する。`UNKNOWN` は `RESERVED` / `DISPATCHED` の reservation と position を `MANUAL_REVIEW` にし、`reserved_delta` と pending を変更しない。結果不明の再適用、同じ outcome の再適用は no-op とする。dry-run は外部送信なしが保証されるため、dispatcher の戻り値が UNKNOWN でも `CONFIRMED_FAILURE` を適用する。許可されない逆遷移、非有限な加減算、保存値の破損は fail-closed で、片方だけを書き込まない。

## 8. `cron_metadata`
Cloud Run 上で動作するスロットスケジューラーが、各周期タスクの実行済みスロットIDを管理するために使用する（詳細は [slot-scheduler.md](./slot-scheduler.md) を参照）。また、Saxo audit orderactivities の batch polling 状態も保持する。

### ドキュメント ID
- `task_status`（固定）
- `saxo_orderactivities_poll_state` — Saxo audit orderactivities の batch polling 状態
- `saxo_orderactivities_reconciliation_state` — Saxo direct recovery と hourly range reconciliation の状態

### フィールド
`task_status`:

- `last_slot_10m` (number, required) — 10分周期タスクが最後に実行されたスロットID
- `last_slot_1h` (number, required) — 1時間周期タスクが最後に実行されたスロットID
- 新しい周期タスクを追加する場合は、対応する `last_slot_<interval>` フィールドを追加する

`saxo_orderactivities_poll_state`:

- `last_poll_at` (timestamp string, optional) — 最後に Saxo audit orderactivities の batch polling を試行した時刻
- `next_poll_url` (string, optional) — Saxo の `__nextPoll` URL。空文字の場合は未保持として扱う

### 制約
- `task_status` は Firestoreトランザクションを使用して読み書きを行い、重複実行を防止する
- `saxo_orderactivities_poll_state` は Saxo audit polling の cursor/lookback 管理専用で、30分超の実行間隔では `last_poll_at` から30分巻き戻して再取得する
- `saxo_orderactivities_reconciliation_state` は batch polling と分離し、direct recovery と hourly range reconciliation の state を同じ document に merge 保存する。TTL は不要（上書きで管理）

`saxo_orderactivities_reconciliation_state`:

- `direct_lookup_after_order_id` (string, optional) — 次の10分 sessionで round-robin を開始する直前の Saxo entry OrderId。direct callを1件以上開始した session の最後の開始位置だけを保存する
- `last_direct_lookup_at` (timestamp string, optional) — direct recovery stateを最後に保存した session時刻
- `last_reconciliation_started_at` (timestamp string, optional) — hourly range reconciliation の開始時刻
- `last_reconciliation_completed_at` (timestamp string, optional) — 全ページ取得と結果適用準備が完了した最後の時刻。incomplete runでは更新しない
- `last_reconciliation_window_from` (timestamp string, optional) — 最後に開始または再試行した range の開始時刻
- `last_reconciliation_window_to` (timestamp string, optional) — 最後に開始または再試行した range の終了時刻
- `last_reconciliation_outcome` (string, optional) — `COMPLETE`、`INCOMPLETE`、`RATE_LIMITED`、`FAILED` のいずれか

Saxo direct recovery は1 sessionあたり最大10注文、HTTP request最大20回（paging/retry込み）、1注文あたり最大5ページ、audit request共有同時数2で制限する。state write failureでは注文データを巻き戻さず、次回同じ候補を再照会し得る。batch hitの注文はdirect stateの候補にも含めない。

Hourly range reconciliation は直近48時間を初期 window とし、range end 時点で作成24時間以内の Saxo entry PENDING だけを対象にする。`FromDateTime`、`ToDateTime`、`EntryType=All`、`$top=500` を使い、最大20ページを共通 audit concurrency limiter（2）で取得する。page limit、HTTP failure、parse failure、429では partial activity を適用せず、`INCOMPLETE` または `RATE_LIMITED` と window を保存して次回同じ window を再試行する。

hourly range は `saxo_orderactivities_poll_state` を読み書きせず、response の `__nextPoll` も保存しない。既存 direct recovery の state fields を削除しないよう、reconciliation state document は常に merge 更新する。24時間を超える stale order と exit related order は hourly range の適用対象外で、前者は OrderId direct recovery、後者は exit 同期の責務とする。

## 9. `saxo_auth_data`
Saxo の暗号化済み OAuth token と account 情報を保持する。`saxo_auth_data/saxo_auth` の固定ドキュメントを使う。

### ドキュメント ID
- `saxo_auth`（固定）

### フィールド
- `encryptedTokens` (map, required) — encrypted document v1 envelope
  - `version` (number, required) — `1`
  - `algorithm` (string, required) — `aes-256-gcm`
  - `iv` (string, required) — 12 byte random IV の canonical base64
  - `ciphertext` (string, required) — `{ accessToken, refreshToken }` JSON payload の暗号文を canonical base64 で保持
  - `authTag` (string, required) — 16 byte authentication tag の canonical base64
- `accessTokenExpiresAt` (number, required) — Unix time milliseconds
- `refreshTokenExpiresAt` (number, required) — Unix time milliseconds
- `accounts` (array, optional)
  - `accountKey` (string, required)
  - `clientKey` (string, required)
  - `legalAssetTypes` (string[], required)
  - `currency` (string, required)
  - `displayName` (string, required)
- `refreshingUntil` (number, optional) — access token refresh の短時間ロック用。成功時は `saveAuth` の上書き保存で消える

### 制約
- 現状は Saxo 1アカウント運用を前提にする
- `accessToken` / `refreshToken` の平文 field は廃止済みで、新規保存・更新では作成しない
- 暗号化鍵は Firestore に保存せず、Secret Manager から `SAXO_TOKEN_ENCRYPTION_KEY` として注入する 32 byte canonical base64 key を使う
- AES-256-GCM の AAD は `saxo_auth_data/saxo_auth:v1` に固定し、token pair だけを暗号化する。期限と account/client metadata は暗号化対象外とする
- access token の期限が近い場合は Firestore transaction で `refreshingUntil` を更新し、複数プロセスの同時 refresh を抑制する
- legacy 平文 document は初回 read 時に検証し、Firestore transaction 内で encrypted document v1 へ全置換する。transaction 競合時は最新 document を再読込し、古い token へ巻き戻さない
- encrypted/plaintext field の混在、不正 schema、鍵の未設定・不正、wrong key、IV/ciphertext/authTag の不正または改ざんは fail-closed とし、平文 fallback や token なしでの継続を行わない
- legacy migration の parse・暗号化・transaction commit が失敗した場合は元 document を変更せず、request を失敗させる
- TTL は使用しない

## 保持期間（MVP）
- `webhook_events`: 90 日
- `order_dispatch_logs`: 180 日
- `orders_v2`: 現時点では明示的な TTL を設定しない
- `tradable_symbols`: 明示的な TTL を設定しない
- `strategy_symbol_positions`: TTL なし（runtime state を上書きで管理）
- `strategy_symbol_reservations`: TTL なし（event 単位の監査・状態を保持）
- `cron_metadata`: TTL なし（上書きで管理）
- `saxo_auth_data`: TTL なし（認証連携中は保持）

## TTL 設計（MVP）
- `webhook_events.expire_at` に `received_at + 90 日` を設定
- `order_dispatch_logs.expire_at` に `created_at + 180 日` を設定
- その他の現行 collection は TTL を使用しない
- Firestore TTL ポリシーは対象コレクションごとに有効化する

## インデックス（MVP）
- Firestore の単一フィールドインデックスはデフォルト利用
- 追加の複合インデックス（必要時のみ）
  - `order_dispatch_logs`: `result` 昇順 + `created_at` 降順
  - `orders_v2`: `status` / `order_type` / `exit_sync_status` の複合条件、または `executed_at` 範囲 + 降順並び替えが必要なクエリで、Firestore から要求された場合に追加する
- `webhook_events`, `tradable_symbols`, `strategy_symbol_positions`, `strategy_symbol_reservations`, `cron_metadata`, `saxo_auth_data` はドキュメント ID 参照または単純な一覧取得を基本とする。position/reservation 用の追加複合 index は作成しない

## 整合性ルール
1. `webhook_events` のドキュメント ID は `{broker}:{symbol}:{event_id}` とし、同一 broker / symbol / event の重複を拒否する
2. `order_dispatch_logs.event_id` は webhook の `event_id` と同じ値を保存する
3. `orders_v2` は broker が注文を受け付け、provider order ID を取得した後に `requested_size=effective_size` で作成する。保存に失敗した場合は注文が成立済みのため reservation を release せず `UNKNOWN` / `MANUAL_REVIEW` とし、provider order ID を dispatch log と構造化アプリログから復旧できるようにする。policy-backed dry-run は broker 注文ではないため `orders_v2` を作成せず、`DRY_RUN` と reservation release を dispatch log に残す
4. `orders_v2` の約定・exit 同期は `broker_order_metadata` を前提にする。限定された Saxo 単体 MARKET は最小 metadata を自己修復し、Saxo IFDOCO は完全な broker evidence recovery に成功した場合だけ metadata を transaction 保存して通常同期へ戻す。不完全・矛盾・上限到達は PENDING の手動確認状態とする
5. `cron_metadata/task_status` の更新は Firestore transaction で行う
6. `saxo_auth_data/saxo_auth.refreshingUntil` の更新は Firestore transaction で行う

## セキュリティ要件（MVP）
- API secret、webhook secret、broker API secret は環境変数で管理し、Firestore に保存しない
- `saxo_auth_data` の OAuth token は AES-256-GCM で暗号化し、暗号鍵は Secret Manager で管理する
- Firestore と Secret Manager のアクセス権限を、それぞれ必要な runtime service account に限定する
- OAuth token endpoint の失敗時は raw response body を Error / logger へ渡さず、HTTP status と安全な固定メッセージだけを記録する

## 廃止済み・未使用コレクション
- `open_trades` と `trade_records` は v1 系 read model として廃止した
- `oidc_connections` は現行ソースコードでは使用していない
- 既存データは移行せず、不要になった時点で手動削除する前提とする
