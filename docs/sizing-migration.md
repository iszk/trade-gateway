# 既存 sizing データ移行と段階ロールアウト

既存 bot の TradingView payload を変更せず、既存 `orders_v2` から strategy × symbol の virtual position と pending reservation を再構築し、`WEBHOOK_CAPPED` policy へ段階移行する手順である。本番 manifest や broker token は repository に保存しない。

既存注文履歴を持たない新しい strategy × symbol の初期化は、この履歴 migration CLIではなく、[sizing仕様](./sizing.md#新しい-strategy-の-fresh-start-運用) の fresh-start API を使用する。fresh-start は broker 建玉を取り込まず、1リクエスト1組を対象とする。migration CLIの既定 dry-run、broker照合、履歴再構築、既存状態の再実行 `NO_OP` 契約は変更しない。

## 事前条件

1. 対象 symbol の `order_constraints` を Symbols UI または認証付き `PUT /api/symbols/:symbol_id` で登録する。
2. GET で `quantity_step`、`min_order_size`、任意の `max_order_size` を再確認する。
3. policy API で対象 strategy × symbol の `WEBHOOK_CAPPED` policy を登録する前に、移行 CLI の manifest に全 policy を列挙する。manifest の `enabled` は受け付けず、移行成功時だけ `enabled=true` で作成する。
4. 対象 symbol を `PATCH /api/symbols/:symbol_id/trade-control` で `paused` にする。in-flight webhook と cron の完了を待つ。
5. PR #74 以降の `PositionFetcher.fetchPositionsForReconciliation` が利用できる revision を使用する。通常の `fetchAllPositions` は失敗時に空配列へ変換するため、移行の broker 照合には使用しない。

## manifest

```json
{
  "project_id": "your-gcp-project",
  "symbols": [
    {
      "symbol_id": "bitflyer:FX_BTC_JPY",
      "expected_order_constraints": {
        "quantity_step": 0.001,
        "min_order_size": 0.001,
        "max_order_size": 0.1
      },
      "policies": [
        {
          "strategy_id": "ma_crossover",
          "sizing_mode": "WEBHOOK_CAPPED",
          "max_abs_position": 0.1,
          "no_flip": true
        }
      ]
    }
  ]
}
```

`strategy_id` は `[A-Za-z0-9_-]+` の canonical ID とし、`unknown` は使用しない。同一 symbol の strategy は重複させない。`max_abs_position` は symbol の quantity step に整合させ、最小注文数量以上にする。manifest 外 strategy への自動 mapping は行わない。

## dry-run

API workspace から次を実行する。既定動作は必ず read-only である。

```text
npm run migrate:sizing -- --config ./private/sizing-manifest.json
```

出力には symbol ごとの `CREATE`、`NO_OP`、`BLOCKED`、`CONFLICT`、全 issue と warning が含まれる。注文 payload、secret、broker token は出力しない。確認する主な項目は次のとおり。

- `confirmed_position`: EXECUTED だけでなく partial fill 後の CANCELED / FAILED の約定分も含む
- `pending_delta`: PENDING の requested - executed。pending は broker 照合の一致判定には含めない
- pending reservation 候補: `event_id=order_id`、`status=DISPATCHED`、`policy_version=1`
- `MANUAL_TRADE_CANDIDATE`: broker total と confirmed total の未帰属差分。manual trade の確定判定ではない
- `INDETERMINATE`: broker snapshot の失敗、partial、invalid。0 position として扱わない
- `BROKER_ONLY_TICKER`、strategy 未設定 / blank / literal `unknown` / invalid / manifest 未登録、既存 state conflict
- `DRY_RUN_ORDER_EXCLUDED`: provider ID が `DRY_RUN` の legacy order は virtual position に含めない
- `MAX_ABS_POSITION_EXCEEDED`: 再構築した confirmed / effective position が policy の上限を超えている場合の warning。推測補正や上限超過の自動削減は行わない

strict validation issue が1件でもある symbol は apply 対象にならない。dry-run は Firestore write 数が常に 0 である。

## apply と再実行

dry-run で全対象が broker `MATCH`、unresolved 0、symbol が paused であることを確認した後、project guard を明示して apply する。

```text
npm run migrate:sizing -- --config ./private/sizing-manifest.json --apply --confirm-project your-gcp-project
```

apply は symbol ごとに次を同一 Firestore transaction で行う。

1. symbol の broker / ticker / constraints / `paused` を再読込する。
2. dry-run 時の orders projection（status、side、requested / executed、strategy identity、broker / ticker、provider ID）が変化していないことを確認する。
3. policy、position、pending reservation がすべて欠落している場合だけ deterministic document ID で create する。
4. すべて存在して論理的に一致する場合は timestamp を更新せず `NO_OP` とする。
5. 一部欠落、数量・identity・status・version の相違、想定外 reservation、transaction retry 後の競合は上書きせず `CONFLICT` とする。

1 symbol の予定 write 数が安全上限（450）を超える場合は分割せず BLOCKED とする。clean symbol は他の blocked symbol と独立して適用できるが、全体 exit code は非 0 のままである。apply を同じ manifest で再実行し、全対象が `NO_OP`、writes=0 になることを確認する。

apply 後、policy / position / reservation と size あり payload の policy-backed dry-run webhook を確認する。operator が確認してから symbol を `active` に戻す。migration script は自動で active に戻さない。

## fallback の必須化

一定期間、以下が全対象で成立することを監視する。

- fallback warning が 0
- policy が enabled、position が `READY`
- broker aggregate が MATCH
- unresolved / manual review が 0

その後 `ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK=false` を deploy する。未登録 policy は `POLICY_NOT_FOUND` で fail-closed になり、既存 policy の動作は変わらない。

## rollback

`ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK=true` に戻すだけでは、既存 policy に fallback は適用されない。

- 全体 rollback: fallback を true に戻したうえで、policy 導入前の既知 revision へ戻す。
- 個別 symbol: symbol を paused にし、対象 policy document を事前 export する。現行 revision の fallback path を確認した後、policy document の削除は operator が手動で行う。script は削除を実装しない。
- `orders_v2`、position、reservation は削除・reset しない。再移行時は dry-run で既存 state conflict を確認し、人手で復旧方針を決める。
