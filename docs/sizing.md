# 数量計算契約

`api/src/services/order-size-calculator.ts` の `calculateOrderSize` は、Firestore、Hono、broker などの外部 I/O を持たない同期関数である。strategy-symbol policy、symbol の注文制約、確定 position、未確定注文の差分、side、任意の webhook size から、発注数量を決定する。

## 入力

```ts
type CalculateOrderSizeInput = {
    policy: StrategySymbolPolicy
    constraints: OrderConstraints
    confirmedPosition: number
    pendingDelta: number
    side: 'BUY' | 'SELL'
    inputSize?: number
}
```

数量の符号は BUY を正、SELL を負として扱う。計算に使う position は次の値である。

```text
effectivePosition = confirmedPosition + pendingDelta
```

`quantity_step`、position、policy の数値項目、中間結果が有限でない場合は発注可能な数量へ補正せず `REJECT / INVALID_CALCULATION_INPUT` を返す。

## policy 別の候補数量

- `WEBHOOK_CAPPED`: `inputSize` は必須。有限の正数で、`quantity_step` の整数倍でなければならない。不足は `SIZE_REQUIRED`、正数でない値は `INVALID_SIZE`、step 不一致は `INVALID_SIZE_INCREMENT` である。step 不一致の値を丸めて受理しない。
- `MANAGED`: 候補は `base_order_size` である。`inputSize` が指定されている場合は有限の正数かどうかだけ検証し、数量計算には使用しない。未指定でもよい。
- `enabled=false`: 入力契約を検証した後、`SUPPRESS / POLICY_DISABLED` を返す。

`MANAGED` で position を増やす方向（BUY で long、SELL で short）へ発注する場合だけ漸減する。

```text
utilization = min(abs(effectivePosition) / max_abs_position, 1)
rawSize = base_order_size * (1 - taper_strength * utilization)
```

position を縮小する方向では `base_order_size` をそのまま候補とする。position が 0 の場合は増加方向として扱う。

## 共通制約と計算順序

候補数量または漸減後の `rawSize` に、次の制約を順番に適用する。

1. position を増加させる方向は `max_abs_position` までの headroom に制限する。
2. position がすでに上限を超えている場合、増加方向は抑止する。縮小方向は flat までの数量だけ許可する。
3. `no_flip=true` の反対方向注文は flat を越えない数量に制限する。
4. `no_flip=false` の反対方向注文も、反転後の position が `max_abs_position` を超えないよう制限する。
5. `max_order_size` がある場合はその数量まで制限する。
6. 最後に `quantity_step` 単位で下方向へ丸める。上方向へ丸めない。
7. 丸め後が `min_order_size` 未満なら発注を抑止する。

安全上限（headroom、flat/no-flip、`max_order_size`）の clamp と `min_order_size` の判定は、step 整合判定の許容差を使用しない。制約前数量が上限を数値上僅かでも超えていれば必ず上限値を採用し、丸め後数量が最小数量を数値上僅かでも下回れば必ず抑止する。step の許容差は数量の境界整合判定に限って使用する。

step 整合した position 同士から headroom を算出する際は、`5 - 4.9` のような IEEE 754 の減算誤差で有効な 1 step を失わないよう境界 index を使う場合がある。ただし canonical 化した数量を加えた `positionAfter` は数値上厳密に再検証し、上限超過があれば通常の減算結果へ戻して安全側へ丸める。

上限方向の headroom が step 未満の場合は、丸め後に数量が 0 となるため `MAX_POSITION` とする。反対方向の残 position が step／最小注文数量未満となる場合は `NO_FLIP` とする。それ以外の最小数量未満は `BELOW_MIN_ORDER_SIZE` とする。

## 結果

結果は例外ではなく、次の判別可能な decision で返す。

```ts
type SizingDecision =
    | { kind: 'DISPATCH'; effectiveSize: number; reason: 'CALCULATED'; details: SizingDecisionDetails }
    | {
        kind: 'SUPPRESS'
        reason: 'POLICY_DISABLED' | 'MAX_POSITION' | 'NO_FLIP' | 'BELOW_MIN_ORDER_SIZE'
        details: SizingDecisionDetails
    }
    | {
        kind: 'REJECT'
        reason: 'SIZE_REQUIRED' | 'INVALID_SIZE' | 'INVALID_SIZE_INCREMENT' | 'INVALID_CALCULATION_INPUT'
        details: SizingDecisionDetails
    }
```

`details` には、算出できた範囲で次の値を含める。

- `effectivePosition`: confirmed と pending を合算した position
- `candidateSize`: policy から得た候補数量
- `rawSize`: MANAGED の漸減後数量（WEBHOOK_CAPPED では候補数量と同じ）
- `constrainedSize`: position／no-flip／max order 制約適用後、step 丸め前の数量
- `roundedSize`、`effectiveSize`、`positionAfter`
- `quantityStep`、`minOrderSize`、`maxOrderSize`、`maxAbsPosition`、`noFlip`
- `appliedConstraints`: `MAX_POSITION`、`NO_FLIP`、`MAX_ORDER_SIZE`、`QUANTITY_STEP`、`MIN_ORDER_SIZE` の適用履歴
- `invalidField`: reject の原因となった入力フィールド（判定できる場合）

`DISPATCH` の `effectiveSize` は正・有限で、step 整合済みであり、すべての共通制約適用後の数量である。`SUPPRESS` は入力が有効だが安全制約により発注しない状態、`REJECT` は入力契約違反または安全に計算できない状態を表す。

## atomic reservation service

`calculateOrderSize` は純粋関数のまま維持し、`strategy-symbol-reservation-service.ts` が Firestore transaction の snapshot と decision を結び付ける。service は policy、symbol の `order_constraints`、position、event reservation を同じ transaction で読み、同じ snapshot の `confirmed_position + pending_delta` を calculator へ渡す。

- `SUPPRESS` / `REJECT` の decision では reservation と position を書き換えない。calculator の decision はそのまま呼び出し元へ返す。
- `DISPATCH` のときだけ、BUY を正、SELL を負とした `reserved_delta` を作り、reservation の `RESERVED` 作成と position の `pending_delta` 加算を同一 commit で行う。position の `policy_version` も参照した policy version に更新する。
- 永続化直前にも canonical `calculateOrderSize` を同じ snapshot で再評価し、`DISPATCH` 数量が一致しない calculator decision は `INVALID_STORED_STATE` として保存しない。これによりテスト用・互換用の calculator seam が数量制約を迂回できない。
- position document の競合で transaction が retry された場合は、最新の pending を用いて calculator を再実行する。order ID、reservation ID、transaction 外で決めた timestamp は retry ごとに生成し直さない。
- 既存 reservation の event は calculator を再実行せず `SUPPRESS / DUPLICATE_EVENT` とする。order ID または side と符号が一致しない場合は `EVENT_CONFLICT` として永続状態を変更しない。
- dispatch 成功は reservation を `DISPATCHED` にし pending を保持する。明確な失敗だけが `RELEASED` へ遷移し、同じ transaction で `pending_delta -= reserved_delta` を行う。結果不明は reservation と position を `MANUAL_REVIEW` にして pending を保持する。

## 約定結果と仮想 position の同期

entry の約定同期は `orders_v2.id = reservation.event_id = reservation.order_id` を関連付けのキーとして、最新 `orders_v2`、reservation、position を同一 Firestore transaction で再読込する。policy 未登録など reservation のない注文は従来の `orders_v2` lifecycle だけを適用する。reservation には position へ適用済みの符号付き累積量 `executed_delta` を持たせ、旧 document の欠落値は読み取り時だけ `0` として扱い、正常な更新で schema を upgrade する。

累積約定を reservation の符号へ変換した値を `e`、前回の `executed_delta` を `e₀`、今回の増分を `d = e - e₀` とする。stale snapshot では `e` を `e₀` より小さくせず、`d` は 0 とする。`d` が有効なら次を同じ commit で適用する。

- partial fill: `confirmed_position += d`、`pending_delta -= d`、reservation は `DISPATCHED`
- full fill: 上記に加えて未約定分が 0 になり reservation を `SETTLED`
- cancel/expire: 約定済み `d` を移した後、`reserved_delta - executed_delta` だけ pending から解放して `SETTLED`
- fill なしの confirmed `FAILED`: 全 `reserved_delta` を pending から解放して `SETTLED`

同一 snapshot の再適用、10分の entry execution 同期と Saxo の hourly execution reconciliation の重複、transaction retry は `executed_delta` との差分計算で no-op になる。requested/reserved size 超過、identity・side・数量の矛盾、同一数量で価格・時刻・commission・metadata が矛盾する snapshot、終端 reservation 後の新規約定は数量を推測修復せず、pending を保持して `MANUAL_REVIEW` とする。非有限値、符号不一致、overflow、破損した保存値も fail-closed とし、orders_v2・reservation・position の一部だけを成功させない。

policy、symbol の制約、position が存在しない、または保存済み document が壊れている場合は 0 や既定値へ補完せず fail-closed とする。

## broker × symbol position reconciliation

10分 cron の約定同期後に、broker の完全な実positionと strategy ごとの `confirmed_position` を symbol 単位で net 集約する。`pending_delta` は未約定 reservation の監査値として別集約し、broker position との一致判定には混ぜない。複数 strategy の相殺・複数 broker leg は symbol net だけを比較し、帰属不明の差分を任意 strategy に補正しない。

`quantity_step` に依存した ULP 誤差だけを許容するため、`0.1 + 0.2` と `0.3` は一致するが、step=0.1 の経済的な 0.06 差は `MISMATCH` とする。broker 取得失敗、認証欠落、partial response、不正な side/size、保存状態の破損は 0 position に補完せず未判定とする。

MISMATCH、INDETERMINATE、broker fetch failure は警告ログだけを残し、symbol pause、position status/quantity、reservation、orders、webhook dispatch を変更しない。手動売買による broker excess/shortage も同じ MISMATCH として集約し、差分の配分や自動解消注文は行わない。通常 MATCH も write せず、復旧 API や reconciliation 所有の pause は設けない。

## 浮動小数点と fail-closed

数量 helper は、`0.1 + 0.2` のような IEEE 754 の演算由来誤差だけを step 境界の比較で許容する。`0.06` を step `0.1` として受理するような入力補正は行わない。

step の整数比を安全な `Number` で表現できない値、非有限の中間結果、step 境界を安全に識別できない値は reject する。数量の離散化では常に下方向へ丸めるため、上限を超える方向の丸めは発生しない。

step 境界の canonical 表現が浮動小数点の丸めで入力値を僅かに上回る場合は、入力側の表現を維持する。step 整合判定で同一境界として扱える場合でも、`floorToQuantityStep(value, step)` の戻り値は数値として必ず `value` 以下である。

この calculator は webhook schema、HTTP status、Firestore transaction、broker dispatch、注文監査の保存を担当しない。これらは後続の統合層が decision を解釈して実装する。

## Webhook route との接続

Webhook route は登録済み policy の strategy、symbol 制約、仮想 position、同一 event の reservation を atomic reservation transaction で読み、同じ snapshot で calculator を実行する。`REJECT` / `SUPPRESS` は reservation と position を更新せず HTTP と `webhook_events` の監査へマッピングする。`DISPATCH` のときだけ reservation の作成と position の `pending_delta` 加算を commit し、transaction が返した `effectiveSize` を唯一の発注数量として broker dispatch、`orders_v2.requested_size`、dispatch log へ伝播する。

`WEBHOOK_CAPPED` では入力 `size` を calculator に渡すが、上限・no-flip・最小数量・step などの共通制約適用後の `effectiveSize` を発注する。`MANAGED` では `base_order_size` から算出した `effectiveSize` を発注し、入力 `size` は検証と監査にのみ使用して数量へ再利用しない。`input_size` と `effective_size` は dispatch log で別フィールドとして保持する。

broker 成功後に `orders_v2` または dispatch log の保存が失敗しても HTTP は `202` を維持する。provider order ID、event / order / reservation ID、effective size を構造化ログへ残し、orders 保存失敗は reservation を release せず `UNKNOWN` / `MANUAL_REVIEW` とする。明確な broker 拒否だけを `CONFIRMED_FAILURE` として release し、成功かつ追跡保存完了時だけ `CONFIRMED_SUCCESS` として `DISPATCHED` にする。policy-backed dry-run は atomic reservation / sizing と実 payload 検証を行うが `orders_v2` を作成せず、dispatch log に `dry_run: true`、`DRY_RUN`、effective size と sizing 監査情報を保存して reservation を `CONFIRMED_FAILURE` / `RELEASED` に戻す。dry-run dispatcher が UNKNOWN を返しても外部送信なしが保証されるため同じ release を適用し、release 失敗時は安全側に保持して構造化ログを残す。policy 未登録時の既存 dispatch は `ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK` による互換経路として維持し、policy 専用監査 field は optional とする。

policy が未登録の場合の既存 dispatch は、移行用 `ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK` が `true` のときだけ許可する。これは第三の sizing mode ではなく、policy 登録までの互換 fallback である。

## 既存 orders_v2 の identity と移行

`orders_v2.strategy` は既存画面・統計との互換性のため表示値として保持する。policy-backed の新規注文だけは、webhook で解決した正規化済み ID を optional な `effective_strategy_id` に保存し、reservation・position・execution sync の identity に使用する。既存注文でこの値が欠落している場合、execution sync は legacy `strategy` を trim し、連続 whitespace を `_` に置換して `[A-Za-z0-9_-]+` を満たす場合だけ解決する。明示 ID と legacy 表示値が一致しない既存注文を推測で補正しない。

既存データの backfill は [sizing-migration.md](./sizing-migration.md) の検証付き CLI を使用する。CLI は既定で dry-run であり、`orders_v2` を全件 strict 検証して strategy × symbol の confirmed / pending を再構築する。`PENDING` ごとに reservation 候補を作るが、strategy 未設定・unknown・invalid・manifest 未登録、破損数量、broker snapshot 不明、broker 差分、既存 state conflict がある symbol は policy を有効化せず BLOCKED とする。broker の実 position と照合する際は pending を含めず、差分を `manual_trade_candidate` として報告するだけで strategy へ配分しない。
