# AGENTS.md

## 基本

- 基本的に日本語で回答する。
- ユーザーが「反映してほしい」「変更してほしい」など明示しない場合、ファイル変更前に確認する。

## 公開用パッケージ作成

ユーザーが「公開用パッケージを作って欲しい」「extensions.gnome.org 用の
ZIPを作って欲しい」などを依頼した場合は、この手順を参照する。

### 前提

- アップロード先は `https://extensions.gnome.org/upload/`。
- 配布ZIPはリポジトリ直下には置かず、原則として `/tmp` に作る。
- ZIPに含めるファイルは最小構成にする。
- このExtensionでは、通常は以下のみを含める。
  - `metadata.json`
  - `extension.js`
  - `LICENSE`
- `.git/`, `.codex/`, `.serena/`, `.agents/`, `readme.md`,
  `CHANGELOG.md`, 一時ファイルは配布ZIPに含めない。

### 作成手順

1. `metadata.json` がJSONとして妥当か確認する。

```bash
python3 -m json.tool metadata.json
```

2. 既存の配布ZIPがあれば削除し、一時ディレクトリを作る。

```bash
rm -f /tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip
tmpdir="$(mktemp -d /tmp/active-window-layout-ego-pack.XXXXXX)"
```

3. 必要ファイルだけを一時ディレクトリへコピーする。

```bash
cp metadata.json "$tmpdir/metadata.json"
cp extension.js "$tmpdir/extension.js"
cp LICENSE "$tmpdir/LICENSE"
```

4. `gnome-extensions pack` で `/tmp` にZIPを作る。

```bash
gnome-extensions pack \
  -f \
  -o /tmp \
  --extra-source=LICENSE \
  "$tmpdir"
```

5. ZIPの内容と整合性を確認する。

```bash
unzip -l /tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip
unzip -t /tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip
unzip -p /tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip \
  metadata.json | \
  python3 -m json.tool
```

6. `shexli` で静的解析する。

`shexli` が未導入の場合は、ネットワークアクセスが必要になる。仮想環境は
`/tmp` 配下に作る。

```bash
python3 -m venv /tmp/shexli-venv
/tmp/shexli-venv/bin/pip install -U shexli
/tmp/shexli-venv/bin/shexli \
  /tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip
```

期待する結果は以下。

```text
shexli: clean (0 findings, 0 errors, 0 warnings)
```

7. 最後にSHA-256を確認してユーザーに伝える。

```bash
sha256sum /tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip
```

### 現在の公開用ZIP

2026-06-26 時点では、以下で作成・検証済み。

- `/tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip`
- `shexli`: clean
