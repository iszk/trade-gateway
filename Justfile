# Justfile: タスクランナー Just の設定ファイル

mod api

# デフォルトタスク: タスク一覧を fzf で選択して実行する
default:
    @just --choose

setup:
    @mise trust --yes
    @mise install
    @npm ci

# すべてデプロイする
deploy:
    just api deploy

test:
    just api test

check:
    npm run typecheck
    npm run lint:unused
