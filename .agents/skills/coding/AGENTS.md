# Coding skill maintenance

## Load order

1. `SKILL.md` で対象作業の reference を特定する。
2. 該当する `references/*.md` だけを読む。

## Validation

- エントリは観測可能な事実または命令形の 1 行 bullet にする。
- Vite の dev と build の両方で再現または検証する。
- コード、既存 reference、root `AGENTS.md` と重複させない。

## Governance

- evidence の収集とルール採否を分け、自動処理は review packet の作成までにする。
- reference、exemplar、lint、eval、変更なしのどれにするかは人間が決める。
- 採用時は最も狭い reference に入れ、関連チェックを通してから merge する。
- 根拠がなくなったルールは推測で残さず、反証を確認して削除する。

