# Justfile: タスクランナー Just の設定ファイル

set dotenv-load := true

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
    just gcloud-auth
    just api deploy

gcloud-auth:
    gcloud auth activate-service-account --key-file=gcloud.key.json

test:
    just api test

check:
    npm run typecheck
    npm run lint:unused
