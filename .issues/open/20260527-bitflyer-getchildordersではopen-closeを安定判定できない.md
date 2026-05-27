# bitflyer の getchildorders では open / close を安定判定できない

## 概要

bitflyer の `GET /v1/me/getchildorders` を使った open / close 判定ロジックに、まだ API 依存の不安定さが残っている。

現状の `api/src/brokers/bitflyer.ts` では `getClosingExecution()` が `child_order_type !== 'MARKET'` を決済注文の判定条件としているが、実地確認では**未約定時は `LIMIT` / `STOP` 等でも、約定済みになると `child_order_type = 'MARKET'` で返る子注文がある**。そのため、現在のロジックでは決済約定を正しく拾えない可能性がある。

## 背景

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

## 実装/修正プラン

- [ ] `getchildorders` / `getparentorder` / `getexecutions` の実レスポンスを、問題のある親注文単位で再収集して比較する
- [ ] open / close を安定して識別できるキーが API レスポンス内に本当に存在するか確認する
- [ ] 候補を検証する
  - 親注文パラメータの順序との対応
  - `side` と親注文のエントリー side との関係
  - `price` / `average_price` / `trigger_price` の整合
  - `child_order_date` と発動順
  - `child_order_acceptance_id` / `child_order_id` の対応規則
- [ ] API 単体で安定判定できない場合は、発注時または初回観測時に open / close の対応情報をこちらで永続化する案を検討する
- [ ] `getClosingExecution()` / `getExecutionPrice()` の判定ロジックを、`child_order_type` 非依存に置き換える
- [ ] 再現テストを追加する
  - 約定済みの決済子注文が `child_order_type = 'MARKET'` で返るケース
  - レスポンス順が毎回異なるケース
  - 見た目上 open / close が判別しづらいケースでも正しい約定情報を返せること

## ログ

### 2026-05-27 23:59:00 GitHub Copilot GPT-5.4

起票した: bitflyer の `getchildorders` は、未約定時と約定済み時で `child_order_type` の見え方が変わることがあり、現在の `child_order_type !== 'MARKET'` ベースの決済判定が成立しないことが確認されたため。レスポンス順も安定しておらず、`getchildorders` 単体では open / close を識別できない可能性があるため、判定戦略を再設計する必要がある。
