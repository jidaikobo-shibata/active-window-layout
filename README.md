# Active Window Layout

GNOME ShellのウィンドウをD-Bus経由で配置する拡張。
一枚の移動・リサイズ、同じアプリの複数ウィンドウの整列、状態による条件分岐、
操作の取り消しを、xremapなどから呼び出せる。

## 既存の呼び出し方

次のメソッドの名前・引数・戻り値は維持している。

| メソッド | 引数 | 動作 |
| --- | --- | --- |
| `GetWorkArea` | なし | アクティブウィンドウのモニターの作業領域を返す |
| `ResizeInWorkArea` | 幅、高さ（整数） | サイズを変更 |
| `MoveInWorkArea` | x、y（整数） | 作業領域内で移動 |
| `MoveResizeInWorkArea` | x、y、幅、高さ（整数） | 移動とリサイズ |
| `MoveToMonitor` | モニター番号（整数） | 指定モニターへ移動 |
| `MoveResizeSemantic` | x、y、幅、高さ（すべて文字列） | キーワード・割合を使った配置 |

たとえば `MoveResizeSemantic left top 1000 '90%'` は従来どおり動く。
位置・サイズを維持する文字列 `null` も引き続き使える。
変更メソッドは要求を発行した場合 `true`、対象がない場合などは `false`。
アプリが要求したサイズを受け入れたことや、配置完了を保証するものではない。

## 条件付き配置の統一形式

`MoveResizeConditional` に、次の構造のJSONを文字列として渡す。
試作段階の「ルール配列を直接渡す形式」は、このオブジェクト形式へ置き換えた。
上記の既存メソッドには影響しない。

```json
{
  "scope": "current-workspace-monitor",
  "tolerance": 20,
  "rules": [
    {
      "when": {"target": "active", "width": 1000},
      "then": {"target": "active", "width": 1200}
    },
    {
      "then": {"target": "active", "width": 1000}
    }
  ]
}
```

- 上から判定し、最初に一致したルールを一つだけ実行する。実行回数は記憶しない。
- `when` の省略は常に一致する既定のルール。通常は最後に置く。
- 一致しなければ何もせず `false`。単一配置の計算結果が現在値と同じ場合も `false`。
- `when` と `then` の `target` は必須。`active` または `same-app`。
  判定対象と変更対象は異なっていてよい。
- `scope` は `current-workspace-monitor` のみ対応、省略時も同じ。
- `tolerance` は位置・サイズ各項目の許容差。既定20論理px、0～4096。
  `when.tolerance` でその条件だけ上書きできる。0なら完全一致。
- 設定全体の書式・値を検証してから操作する。未知の項目、不正な値はエラー。
  選ばれた変更先が画面上で成立するかも、ウィンドウを動かす前に計算する。
- 最大100ルール、JSONは65536文字まで。複数操作の対象は最大100ウィンドウ。

### 一枚の位置・サイズ：target active

| 項目 | 指定値 |
| --- | --- |
| `x` | 整数座標、`left` / `center` / `middle` / `right`、整数の `0%`～`100%` |
| `y` | 整数座標、`top` / `center` / `middle` / `bottom`、整数の `0%`～`100%` |
| `width`, `height` | 50以上の整数サイズ、または整数の `1%`～`100%` |

位置は作業領域の左上が基準。サイズの割合は作業領域に対する割合。
位置の割合はウィンドウを収められる移動範囲に対する割合で、50%は中央。
いずれもGNOME Shellの論理座標・ウィンドウ枠の寸法を使う。

`when` は省略した項目を判定しない。指定した項目をすべて満たす必要がある。
中央・右端・下端の位置条件は、現在の実寸から計算する。
`then` は省略した項目またはJSONの `null` を現在値のまま維持する。
どちらも少なくとも一つの位置・サイズ項目を指定する。
計算後の変更先サイズは幅・高さとも50px以上が必要。

### 複数ウィンドウの配置：target same-app

`layout` を指定する。配置の計算を、条件の判定と実行の両方で共用する。

| layout | 配置 |
| --- | --- |
| `grid` | 格子。2枚なら左右、3～4枚は2×2、5～6枚は3×2 |
| `columns` | 横一列 |
| `rows` | 縦一列 |
| `cascade` | 同じサイズで少しずつ右下へ重ねる |

格子・横・縦は `gap` で隙間を指定する（整数0～4096、既定12）。
外周の余白は設けず、パネル・ドックを除いた作業領域を分割する。
格子の最後の行に空き枠があっても各枠の大きさは同じ。1枚なら作業領域全体。
計算した枠が50px未満になる変更先はエラーにする。

カスケードでは次を指定できる。

```json
{
  "target": "same-app",
  "layout": "cascade",
  "width": "70%",
  "height": "75%",
  "offsetX": 40,
  "offsetY": 40
}
```

幅70%・高さ75%、横・縦40pxが既定。サイズは整数pxまたは整数の割合。
offsetは0～4096の整数。端を越える前に左上へ折り返す。
片方を0にすれば横・縦だけにずらせる。両方0なら左上の同じ位置に重なる。
カスケードのサイズは作業領域内に収まる必要がある。`gap` は使わない。

対象はアクティブウィンドウと同じアプリで、現在のワークスペース・同じモニターにある
移動・リサイズ可能な通常ウィンドウ。最小化、全画面、ダイアログ、タスクバー対象外は除く。
新形式の `active` もこの通常ウィンドウの条件に従う。
全ワークスペースに表示するウィンドウは、現在のワークスペースにも属する扱い。
アプリの同一性はGNOME Shellの判定に従い、別プロファイル等の扱いは環境による。

整列時はアクティブを先頭、残りを生成順で配置する。
カスケードだけは、残りを奥から配置し、最後にアクティブを手前へ置く。
キーボードフォーカスは変更しない。

**配置条件の判定では順番を問わず、すべての対象が別々の枠に一致するか調べる。**
配置後に別のウィンドウをアクティブにしても判定できる。
カスケード条件も位置・サイズで判定し、重なり順は条件にしない。
最大化したウィンドウを含む場合は配置条件に一致しない。
枚数の変化や手動移動で条件から外れた場合は、次のルールを調べる。
現在の画面では成立しない配置条件も不一致として扱う。

アプリの最小サイズ・サイズの丸めにより、隙間や重なりが出る場合がある。
許容差を超える場合は配置条件にも一致しない。実寸に合わせた枠の再分割は行わない。

## xremap：リサイズ・均等配置・カスケードの切り替え

既存の `remap` に次のキー設定を置く。
通常は「中央1000×700 → 全体を均等配置 → 全体をカスケード」と切り替わる。
実際の状態で判定するため、条件をすでに満たしている場合はその分岐から始まる。

```yaml
      Shift-Ctrl-e:
        launch:
          - sh
          - -eu
          - -c
          - |
            dest=org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout
            path=/org/gnome/Shell/Extensions/jidaikobo/shibata/ActiveWindowLayout
            exec gdbus call --session --dest "$dest" \
              --object-path "$path" \
              --method "$dest.MoveResizeConditional" \
              '{
                "scope": "current-workspace-monitor",
                "tolerance": 20,
                "rules": [
                  {
                    "when": {"target": "same-app", "layout": "grid"},
                    "then": {"target": "same-app", "layout": "cascade"}
                  },
                  {
                    "when": {
                      "target": "active", "width": 1000, "height": 700
                    },
                    "then": {"target": "same-app", "layout": "grid"}
                  },
                  {
                    "then": {
                      "target": "active", "x": "center", "y": "center",
                      "width": 1000, "height": 700
                    }
                  }
                ]
              }'
```

均等配置とカスケードだけを切り替えるなら、ルールを次にする。

```json
{
  "rules": [
    {
      "when": {"target": "same-app", "layout": "grid"},
      "then": {"target": "same-app", "layout": "cascade"}
    },
    {"then": {"target": "same-app", "layout": "grid"}}
  ]
}
```

同じ状態に複数の条件が一致する場合は、上に書いた条件が優先される。
特定の枚数・画面寸法では配置同士が同じ寸法になることもあるため、
これは固定の実行順を保証する機能ではない。

## 条件なしで同じアプリを整列する

`ArrangeSameApp` も利用でき、同じ配置計算・対象選択・履歴を使う。
JSONは `{"layout":"grid","gap":12}`、カスケードなら
`{"layout":"cascade","width":"70%","height":"75%","offsetX":40,"offsetY":40}`。
`{}` なら既定の格子。`scope` は省略可能で `current-workspace-monitor` のみ対応。
ここでは `target` を書かない。JSONは4096文字まで。

## 元に戻す

`UndoLastOperation` を引数なしで呼ぶ。

```yaml
      Shift-Ctrl-u:
        launch:
          - sh
          - -eu
          - -c
          - |
            dest=org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout
            path=/org/gnome/Shell/Extensions/jidaikobo/shibata/ActiveWindowLayout
            exec gdbus call --session --dest "$dest" \
              --object-path "$path" --method "$dest.UndoLastOperation"
```

- この拡張で行った操作を、アプリ横断で新しい順に最大20回戻せる。
  現在のアクティブウィンドウではなく、その操作で変更したウィンドウを復元する。
- 一回のD-Bus呼び出しが一組。複数ウィンドウの整列も一回でまとめて戻す。
  既存メソッドの移動・リサイズ・モニター移動も履歴に入る。
- `MoveToMonitor` のあとに `MoveResizeSemantic` を呼ぶ設定は二回の操作なので、
  両方を戻すにはUndoを二回呼ぶ。Undo自体は新しい履歴を作らない。
- 要求直前の位置・サイズ・モニター・最大化状態・全画面状態を保存する。
  カスケードについては対象同士の重なり順も復元する。
- 閉じたウィンドウは履歴から除く。別のワークスペースへ手動で移したウィンドウは、
  Undo時に飛ばす。ワークスペースやフォーカスを自動で切り替えることはない。
- 作業領域の変更（モニター構成・解像度・パネル等の変更）、拡張の無効化・再読み込み、
  ログアウトで履歴は消える。ディスクに保存しない。
- 復元要求を発行できれば `true`。履歴がない、またはすべて飛ばした場合は `false`。
  飛ばした履歴は消費する。

GNOME独自のタイル・スナップ状態そのもの、最大化解除時にGNOMEが使う内部の復元枠、
他アプリを含む完全な重なり順は保存しない。アプリのサイズ制約はUndoにも適用される。
また、操作は非同期の配置要求なので、短時間に連打すると適用途中の実寸が履歴に入る。
途中で操作が失敗しても保存した履歴は残すが、自動ロールバックは行わない。

## 実装構成と拡張

- `layout.js`: JSON検証、配置計算、単一・複数ウィンドウの条件判定。
  GNOMEに依存しない。新しい配置はここに追加し、条件と実行で同じ計算を使う。
- `history.js`: 一組単位の最大20件の履歴、終了したウィンドウの除去、監視の解放。
- `extension.js`: D-Bus、対象選択と状態取得、配置の実行、GNOMEの状態復元。
  既存メソッドは従来の引数解釈を維持し、履歴の記録を共用する。
- `tests/placement.test.cjs`: 純粋な計算とGNOMEモックを使う回帰テスト。

対象を一度取得し、条件を評価して配置計画を作り、変更前の状態を保存してから実行する。
将来の対象選択、主役＋脇役などの配置、順送りにも同じ計画・履歴を使える構成。
順送り、Redo、複数アクションを並べる構文は現時点では未実装。

## 検証と読み込み

```bash
node tests/placement.test.cjs
node --input-type=module --check < extension.js
node --input-type=module --check < layout.js
node --input-type=module --check < history.js
```

Waylandで更新を確実に読み込むには、作業を保存してログアウト・ログインする。
xremap側の設定変更・再読み込みは別途必要。
