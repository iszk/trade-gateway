---
title: bitflyer の getchildorders では open / close を安定判定できない
status: todo
---

# 概要

bitflyer の `GET /v1/me/getchildorders` を使った open / close 判定ロジックに、まだ API 依存の不安定さが残っている。

現状の `api/src/brokers/bitflyer.ts` では `getClosingExecution()` が `child_order_type !== 'MARKET'` を決済注文の判定条件としているが、実地確認では**未約定時は `LIMIT` / `STOP` 等でも、約定済みになると `child_order_type = 'MARKET'` で返る子注文がある**。そのため、現在のロジックでは決済約定を正しく拾えない可能性がある。

# 背景

- 直近の修正で、`getchildorders` のレスポンス順序に依存した判定は解消した
- その後の実地確認で、`child_order_type` 自体も open / close 判定の安定した根拠にならないことが分かった
- 確認できた現象:
  - 未約定の子注文は `child_order_type = 'LIMIT'` などで返る
  - しかし約定済みの子注文は、本来決済注文であっても `child_order_type = 'MARKET'` で返ることがある
  - `getchildorders` のレスポンス順序も一定ではない
  - レスポンスを見ただけでは、どの子注文が open でどの子注文が close かを安定して判別できない
- このため、現在の以下の前提は崩れている
  - `MARKET` = エントリー注文
  - `MARKET` 以外 = 決済注文

# 対応方針

## スコープ

- 今後の運用で残るコードの単純さ・明快さを優先する
- 既存データの互換維持や救済は、この issue の設計制約にしない
- 既存データがどう処理されるかは保証しない
- 必要なら backfill や既存データ破壊が起きても許容する
- 実装の第一対象は `orders_v2` のみとする
- `open_trades` は今回の主対象にしない
- ただし `orders_v2` だけに閉じられない依存が判明した場合に限り、必要最小限で `open_trades` 側にも同じ metadata を入れる

## 方針の中核

- `getchildorders` のレスポンスから open / close を事後推定するのをやめる
- open / close の役割は、**注文送信時にこちらが知っている情報**を起点に保持する
- `child_order_type` やレスポンス順は補助情報としても信用しない

## 実装方針

- [ ] `sendparentorder` 成功時の返り値を拡張し、親注文受付 ID に加えて「エントリー条件」「決済条件」のメタデータをアプリ側へ返せるようにする
- [ ] webhook 受信直後に作成している `open_trades` / `orders_v2` に、bitFlyer IFD / IFDOCO 用の open / close 対応メタデータを保存できるようにする
- [ ] メタデータ形状を固定し、以後はその shape を前提に `getExecutionPrice()` / `getClosingExecution()` を組み立てる
- [ ] 初回 cron 観測時に `getparentorder` / `getchildorders` を使って子注文一覧を取得し、**送信時に保存した条件**と突き合わせて child acceptance id を一度だけ確定・保存する
- [ ] `getExecutionPrice()` は「エントリー child acceptance id」を優先して参照する
- [ ] `getClosingExecution()` は「決済 child acceptance id の集合」だけを参照する

## メタデータの正規形

保存先のフィールド名は仮に `broker_order_metadata` とする。

```ts
type BitflyerChildRole = 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS'

type BitflyerExpectedChildOrder = {
  role: BitflyerChildRole
  side: 'BUY' | 'SELL'
  condition_type: 'MARKET' | 'LIMIT' | 'STOP'
  size: number
  price?: number
  trigger_price?: number
}

type BitflyerResolvedChildOrder = {
  acceptance_id: string | null
}

type BitflyerParentOrderMetadataV1 = {
  kind: 'bitflyer_parent_order_v1'
  parent_order_acceptance_id: string
  order_method: 'IFD' | 'IFDOCO'
  entry: {
    expected: BitflyerExpectedChildOrder
    resolved: BitflyerResolvedChildOrder
  }
  exits: Array<{
    expected: BitflyerExpectedChildOrder
    resolved: BitflyerResolvedChildOrder
  }>
}
```

## この shape にする理由

- child order の役割を `ENTRY` / `TAKE_PROFIT` / `STOP_LOSS` として明示できる
- `expected` と `resolved` を分けることで、「送信時点で知っている事実」と「後から API で解決した結果」が混ざらない
- `acceptance_id` を child ごとに持てるため、`getExecutionPrice()` と `getClosingExecution()` が同じメタデータを参照できる
- `exits` を配列にしておくと、IFD と IFDOCO を同じ構造で扱える
- `kind` を discriminant にしておくと、将来 broker ごとに別 metadata を足しても分岐が単純になる

## 保存ルール

- `provider_order_id` / `provider_order_ids[0]` には従来どおり親注文受付 ID を入れる
- `broker_order_metadata.kind === 'bitflyer_parent_order_v1'` の場合だけ、child order 解決ロジックを有効にする
- `entry.resolved.acceptance_id` と `exits[].resolved.acceptance_id` は初期値 `null`
- cron の初回解決後は、同じドキュメントに acceptance id を上書き保存する
- child role の解決は `child_order_type` ではなく `expected` との一致で行う

## 保存先ごとの扱い

- `orders_v2`
  - `provider_order_ids[0]` は親注文受付 ID
  - `broker_order_metadata` を追加する
- `open_trades`
  - 今回は変更しない前提
  - `orders_v2` 単独で閉じられない場合のみ追従する
- `order_dispatch_logs`
  - デバッグ用に残すなら同 shape をそのまま保存する

## `orders_v2` に閉じるための前提

- entry 約定価格の確定は `fetchAndUpdatePendingOrdersV2()` 側だけで完結できる
- close 約定価格の確定は `syncExecutionsForExecutedIfdOrders()` 側だけで完結できる
- `open_trades` の IFD / IFDOCO close 判定は、今回の修正対象外として一旦壊れたままでも許容する
- つまり今回の修正のゴールは、`orders_v2` の entry / exit 同期が metadata ベースで正しく動くことに限定する

## 解決アルゴリズムの前提

- `getchildorders` から返った child を、`expected.side` / `expected.condition_type` / `expected.size` / `price` / `trigger_price` との一致で role に割り当てる
- 同一候補が複数あり一意に決まらない場合は、その場で `null` を返して失敗として扱う
- あいまいな推定を入れず、解決できたときだけ child acceptance id を保存する

## 期待する挙動

- 修正後に作成された IFD / IFDOCO 注文は、`getchildorders` の順序や `child_order_type` の揺れに関係なく、同じ child order を open / close として参照できる
- 新しいコードは metadata 前提で読めるので、legacy 互換の分岐を持たない
- あいまいな child order は無理に open / close 判定しないことで、誤った trade record 作成を防ぐ

## テスト方針

- [ ] `sendparentorder` の返り値または保存処理に、bitFlyer IFD / IFDOCO 用メタデータが含まれるテストを追加する
- [ ] child order 一覧の順序が毎回異なっても、保存済みメタデータで同じ child acceptance id に解決できるテストを追加する
- [ ] 約定済みの決済 child が `child_order_type = 'MARKET'` で返っても、close 側として拾えるテストを追加する
- [ ] child 候補が複数あり一意に解決できない場合に `null` を返し、誤った約定価格を返さないテストを追加する

## 補足

- API レスポンスだけで open / close を安定判定する道が後から見つかったとしても、この issue ではそれを主解にしない
- 理由は、送信時点で役割情報を保持できる以上、そのほうが再現性が高く、API の表示揺れに再度引きずられないため

# ログ

## 2026-05-27 23:59:00 GitHub Copilot GPT-5.4

起票した: bitflyer の `getchildorders` は、未約定時と約定済み時で `child_order_type` の見え方が変わることがあり、現在の `child_order_type !== 'MARKET'` ベースの決済判定が成立しないことが確認されたため。レスポンス順も安定しておらず、`getchildorders` 単体では open / close を識別できない可能性があるため、判定戦略を再設計する必要がある。
