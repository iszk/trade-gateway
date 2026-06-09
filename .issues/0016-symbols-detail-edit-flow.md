---
title: Symbols detail edit flow
status: done
---

# 概要

symbols 一覧画面を参照専用にし、作成・更新・取引制御などの操作は個別画面で行えるようにする。

# 背景

現在の symbols 画面は一覧上に作成フォームと pause/resume 操作を持っており、一覧表示と編集操作の責務が混在している。
一覧から個別画面に遷移して編集する導線に分離することで、誤操作を減らし、画面責務を明確にする。

# 実装/修正プラン

- `/symbols` は一覧表示のみとし、作成・更新・取引制御のフォームを削除する
- 一覧の各行から個別 symbol 画面へ遷移できるようにする
- 個別 symbol 画面で保存と pause/resume を実行できるようにする
- 変更に対応するテストを追加・更新する

# ログ

## 2026-06-08 12:04 Codex GPT-5
ユーザー依頼に基づき起票。実装前の作業範囲として、symbols 一覧の参照専用化と個別画面での編集導線追加を追跡する。

## 2026-06-08 12:04 Codex GPT-5
実装開始のため status を wip に変更。API 側には個別取得・更新・取引制御のエンドポイントが既にあるため、UI ルート追加と一覧画面の責務分離を中心に進める。

## 2026-06-08 12:08 Codex GPT-5
`/symbols` から POST ハンドラ、作成フォーム、pause/resume フォームを削除し、一覧は参照専用に変更した。各行には個別画面へ遷移する `Open` リンクのみを配置した。

`/symbols/[symbol_id]` を追加し、個別画面で metadata 保存と trade control の pause/resume を実行できるようにした。symbol_id はコロンを含むため、画面 URL と API URL の生成を `ui/app/lib/symbols.ts` に集約し、エンコードのテストを追加した。

検証として `npm run typecheck --workspace @trade-gateway/ui`、`npm run test --workspace @trade-gateway/ui`、`mise run test`、`npm run build --workspace @trade-gateway/ui` が成功した。issue のクローズはユーザー確認が必要なため、status は wip のままにしている。
