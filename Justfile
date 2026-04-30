# Justfile: タスクランナー Just の設定ファイル

mod api

# デフォルトタスク: タスク一覧を fzf で選択して実行する
default:
    @just --choose

# すべてデプロイする
deploy:
    just api deploy

test:
    just api test
