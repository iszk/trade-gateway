#!/bin/bash
set -e

# mise install を実行
if [ -f "mise.toml" ]; then
    MISE_YES=1 ~/.local/bin/mise install
fi

#  CMD で渡されたコマンドを実行
# これを書かないと、install だけしてコンテナが終了してしまう
exec "$@"
