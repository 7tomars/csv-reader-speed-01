# csv-reader-speed-01 — a faster drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/7tomars/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/7tomars/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

An entry for make.fun's **csv-reader-speed-01**: a dependency-free ES module whose `run(input)`
returns, for every input `{text, header}`, exactly the answer csv-reader 1.0.0 returns —
`{columns, rows, errors}` under csv-reader's broken-row policy — in less CPU time.

## The reading policy (identical to csv-reader 1.0.0)

- A U+FEFF at the very start of the text is dropped.
- A record ends at LF or CRLF; a line left with no characters is no record.
- Outside quotes, a CR not followed by LF is dropped (`stray_cr`).
- A field that opens with a quote runs to the next quote that is not doubled: `""` inside it is
  one quote, and each CRLF or lone CR inside it is read as LF. What follows its closing quote, up
  to the next comma or line break, is appended as it stands (`quote_junk`, when the field ends).
  A quote that never closes is a literal character, and the text after it is read again as
  unquoted (`unterminated_quote`).
- A quote inside an unquoted field is a literal character. Fields stay strings, never trimmed
  or converted.
- `columns` is the first record when `header` is true, else `null`; `rows` holds the records
  after it (every record when `header` is false), each padded with `""` (`short_row`, with
  `fields`: its field count) or cut (`long_row`, with `extra`: the cut fields) to the first
  record's width.
- Each error is `{code, line, row}` in the order met: `line` the 1-based line its record starts
  on (every LF, CRLF and lone CR inside quotes counted), `row` its record's index in `rows`,
  `null` for the header.

## How it works

`solve.js` makes one left-to-right pass over the text and never builds a field a character at a
time:

- **Plain-line fast path.** A record whose whole line holds no quote and no CR but a CRLF's at
  its end is split in one native `split(',')` — exactly the fields the field-by-field read
  would produce.
- **Sliced fields.** Unquoted fields are scanned with `charCodeAt` to their terminator and
  taken as a single slice of the text.
- **Quoted fields.** The closing quote is found with `indexOf`, skipping doubled quotes.
  Content with no CR and no doubled quote is sliced whole (only its line breaks are counted);
  content that needs its CRs and doubled quotes rewritten is rebuilt in pieces.
- **Slow paths only where needed.** A stray CR inside a field, junk after a closing quote, and
  an unterminated quote each fall back to a piece-collecting read for that one field; the rest
  of the file keeps the fast paths.

Correctness is the gate: the answers must equal csv-reader 1.0.0's on every case, and this
implementation is verified against the reference on the kit's practice set and on adversarial
cases covering every rule above.

## How to run

The harness runs the driver:

```sh
node main.ts   # reads /input/cases.json, writes /output/answers.json
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and
`/output`. Or call the module directly:

```js
import { run } from './solve.js';

const answer = run({ text: 'a,b\n1,2\n', header: true });
// { columns: ['a', 'b'], rows: [['1', '2']], errors: [] }
```

Requires Node 22.18 or later. No dependencies.
