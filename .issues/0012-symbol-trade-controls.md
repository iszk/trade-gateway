---
title: symbol trade controls
status: wip
---

# 概要

broker + ticker を正規キーとする `tradable_symbols` を追加し、UI から symbol ごとの停止/再開を操作できるようにする。

# 背景

TradingView webhook から受けた注文を symbol 単位で一時停止したい。あわせて broker + ticker の表示名や通貨など、UI 表示に必要な情報をまとめて扱えるようにする。

# 実装/修正プラン

- `tradable_symbols/{symbol_id}` を追加する
- `symbol_id` は `broker:ticker` とし、broker は最初の `:` より前、ticker はそれ以降全部とする
- `tradable_symbols` がない場合は webhook 上では active として扱い、事後に `currency = JPY` の空に近いレコードを作成する
- `webhook_events.status` と `order_dispatch_logs.result` に `suppressed` を追加する
- paused の場合は broker dispatch を行わず `202 Accepted` を返す
- 停止/再開 API と簡素な UI を追加する
- UI 上で symbol_id または ticker を表示している箇所は `display_name ?? symbol_id` を使う

# ログ

## 2026-06-03 13:53 Codex GPT-5
ユーザーと合意した設計を issue 化し、実装を開始する。停止/再開履歴は専用コレクションを作らず info ログに残す。currency は売買判定では参照しない。

## 2026-06-03 14:01 Codex GPT-5
`tradable_symbols` サービス、symbols API、Webhook の paused 判定、suppressed 記録、Symbols UI を実装した。`tradable_symbols` がない場合は active として扱い、既知 broker の場合は `currency = JPY` のデフォルトレコードを事後作成する。既存 UI の ticker 表示は symbols 一覧を参照して `display_name ?? broker:ticker` にした。`mise run test`、API/UI typecheck、API/UI build は通過した。
