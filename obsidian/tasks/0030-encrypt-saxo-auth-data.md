---
title: Saxo 認証トークンを Firestore 保存前に暗号化する
status: todo
---

# 概要

`saxo_auth_data/saxo_auth` に保存している Saxo OAuth token を暗号化保存に変更する。

# 背景

現行実装では `accessToken` と `refreshToken` を Firestore にそのまま保存している。Firestore 権限は制限されている前提でも、broker 認証情報として機微度が高く、漏えい時の影響が大きい。

# 実装/修正プラン

- 保存前に `accessToken` / `refreshToken` を暗号化する方式を決める
- 復号は Saxo API 呼び出しや refresh の直前に限定する
- 既存 `saxo_auth_data/saxo_auth` からの移行方針を決める
- ログやエラー出力に token が混入しないことを確認する
- 単体テストを追加し、`just check` と `just test` を通す

# ログ

## 2026-07-02 11:26 Codex GPT-5

ドキュメント棚卸しで、`saxo_auth_data/saxo_auth` に Saxo OAuth token が平文保存されていることを確認した。現行仕様へのドキュメント修正とは分離し、暗号化対応を別 task として起票した。
