# Active Window Layout

アクティブなウィンドウの位置とサイズをD-Bus経由で変更するGNOME Shell拡張。
既存の `MoveResizeSemantic` などのメソッドは従来どおり利用できる。

## 条件付き配置

`MoveResizeConditional` にルールのJSON配列を文字列として渡す。
実行時のアクティブウィンドウの位置・サイズを調べ、最初に一致したルールを
一つだけ実行する。実行回数は記憶しない。同じアプリの別ウィンドウには影響しない。

- `when`: 条件。省略すると常に一致するため、既定のルールとして最後に置く。
- `then`: 変更先。最低一つの位置・サイズを指定する。
- `x`, `y`: 作業領域左上からの数値座標、整数の割合 `0%`～`100%`、
  または `x` では `left` / `center` / `middle` / `right`、
  `y` では `top` / `center` / `middle` / `bottom`。
- `width`, `height`: 数値サイズ、または作業領域に対する整数の割合。
  数値サイズ・割合から計算された変更先サイズは50px以上。
- `when` で省略した項目は判定しない。指定した項目はすべて満たす必要がある。
- `when.tolerance`: 各項目の許容差。既定20px。完全一致なら `0`。
  中央・右端・下端などの位置条件は、現在の実寸から算出する。
- `then` で省略した項目、またはJSONの `null` を指定した項目は現在値を維持する。
- 一致しなければ何もせず `false`。要求を発行した場合は `true`。
  `true` は配置完了やアプリによるサイズ受け入れを保証しない。
- 不正なJSON・項目・値は、配置を変更する前にエラーにする。
  最大100ルール、JSON文字列は65536文字まで。

許容差の範囲が重なる場合も、先に書いたルールが優先される。
最大化状態などの専用条件はなく、その時点のウィンドウ枠の実寸を判定する。
座標・サイズはGNOME Shellの論理座標で扱う。

## xremap設定例

Terminal用の既存の `remap` に次のキー設定を置く。
左上に配置し、幅を1000 → 1200 → 1400 → 1000と切り替える。
高さは作業領域の90%。最初の実行でも条件を満たしていれば次の幅へ進む。

```yaml
      Shift-Ctrl-w:
        launch:
          - sh
          - -eu
          - -c
          - |
            dest=org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout
            path=/org/gnome/Shell/Extensions/jidaikobo/shibata/ActiveWindowLayout
            result=$(gdbus call --session --dest "$dest" \
              --object-path "$path" --method "$dest.MoveToMonitor" 0)
            [ "$result" = '(true,)' ]
            exec gdbus call --session --dest "$dest" \
              --object-path "$path" \
              --method "$dest.MoveResizeConditional" \
              '[
                {
                  "when": {"width": 1000},
                  "then": {
                    "x": "left", "y": "top",
                    "width": 1200, "height": "90%"
                  }
                },
                {
                  "when": {"width": 1200},
                  "then": {
                    "x": "left", "y": "top",
                    "width": 1400, "height": "90%"
                  }
                },
                {
                  "then": {
                    "x": "left", "y": "top",
                    "width": 1000, "height": "90%"
                  }
                }
              ]'
```

上の例は幅だけを条件にするため、モニター移動時の位置変更には依存しない。
`MoveToMonitor` と条件付き配置は別の呼び出しであり、モニター移動完了を待つ
一体の操作ではない。移動直後の位置・割合を条件に含める場合は注意する。

左右の切り替えなら、JSONを次のようにする。

```json
[
  {"when": {"x": "left"}, "then": {"x": "right"}},
  {"then": {"x": "left"}}
]
```

幅・高さ・上下位置を保ったまま、左右を切り替える。
両端が同じ位置になる作業領域いっぱいの幅では、切り替えても位置は変わらない。

## 検証と読み込み

```bash
node tests/placement.test.cjs
node --input-type=module --check < extension.js
```

Waylandで更新を確実に読み込むには、作業を保存してログアウト・ログインする。
xremap側の設定変更・再読み込みは別途必要。
