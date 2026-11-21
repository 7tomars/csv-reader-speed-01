// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's answer for every input
// {text, header} — {columns, rows, errors} under csv-reader's broken-row policy — and runs faster.
//
// The policy, matched behaviour for behaviour:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled: "" inside it is one
//     quote, each CRLF or lone CR inside it is read as LF; what follows its closing quote, up to the
//     next comma or line break, is appended as it stands (quote_junk, when the field ends); a quote
//     that never closes is a literal character and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, with fields: its field
//     count) or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside quotes counted), row its record's index in rows, null for
//     the header; a record's short_row or long_row comes when the record ends.
//
// How it is fast:
//   - one left-to-right pass over the text; fields are taken as single slices of the text, never
//     built a character at a time;
//   - a record whose line holds no quote and no stray CR is split in one native split(',');
//   - a closing quote is found with indexOf, skipping doubled quotes; quoted content is sliced
//     whole when it holds no CR and no doubled quote, and only then are its line breaks counted;
//   - the slow paths (a stray CR inside a field, junk after a closing quote, an unterminated
//     quote, quoted content that needs its CRs and doubled quotes rewritten) are taken only by
//     the fields that need them.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field read ended, and how many characters the last unquoted read kept.
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break, the slow way: a
  // stray CR is in there somewhere, so the field is collected in pieces with the CRs dropped.
  function readUnquotedSlow(value) {
    const parts = [];
    if (value !== '') parts.push(value);
    let added = 0;
    let seg = pos;
    let i = pos;
    let ended = END;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) { ended = COMMA; break; } // ,
      if (c === 10) { ended = LINE_BREAK; break; } // LF
      if (c === 13) { // CR
        if (text.charCodeAt(i + 1) === 10) { ended = LINE_BREAK; break; } // CRLF
        if (i > seg) { parts.push(text.slice(seg, i)); added += i - seg; }
        error('stray_cr');
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    if (i > seg) { parts.push(text.slice(seg, i)); added += i - seg; }
    if (ended === COMMA) pos = i + 1;
    else if (ended === LINE_BREAK) { pos = i + (text.charCodeAt(i) === 13 ? 2 : 1); line += 1; }
    else pos = n;
    fEnded = ended;
    fAdded = added;
    return parts.join('');
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed
  // by LF is dropped (stray_cr). Sets fEnded and fAdded (the characters kept).
  function readUnquoted(value) {
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10) break;
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) break; // CRLF ends the field
        return readUnquotedSlow(value); // a stray CR: the slow path drops it
      }
      i += 1;
    }
    const kept = i - pos;
    fAdded = kept;
    if (kept > 0) value = value === '' ? text.slice(pos, i) : value + text.slice(pos, i);
    if (i >= n) {
      pos = n;
      fEnded = END;
    } else if (text.charCodeAt(i) === 44) {
      pos = i + 1;
      fEnded = COMMA;
    } else if (text.charCodeAt(i) === 10) {
      pos = i + 1;
      line += 1;
      fEnded = LINE_BREAK;
    } else { // CR of a CRLF
      pos = i + 2;
      line += 1;
      fEnded = LINE_BREAK;
    }
    return value;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const start = pos + 1;
    // The closing quote is the next quote that is not doubled.
    let j = start;
    let close = -1;
    let doubled = false;
    for (;;) {
      const q = text.indexOf('"', j);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) { doubled = true; j = q + 2; continue; }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again as
      // unquoted. `line` was never moved by the search, so nothing needs restoring.
      error('unterminated_quote');
      pos = start;
      return readUnquoted('"');
    }
    const raw = text.slice(start, close);
    let value;
    if (!doubled && raw.indexOf('\r') === -1) {
      // The common quoted field: its content stands as it is; only its line breaks need counting.
      value = raw;
      let k = raw.indexOf('\n');
      while (k !== -1) { line += 1; k = raw.indexOf('\n', k + 1); }
    } else {
      // Doubled quotes become one quote and each CRLF or lone CR becomes LF, in pieces.
      const parts = [];
      let seg = 0;
      let i = 0;
      const m = raw.length;
      while (i < m) {
        const c = raw.charCodeAt(i);
        if (c === 34) { // a doubled quote (the search above guarantees they come in pairs)
          if (i > seg) parts.push(raw.slice(seg, i));
          parts.push('"');
          i += 2;
          seg = i;
        } else if (c === 13) { // CR or CRLF: one LF
          if (i > seg) parts.push(raw.slice(seg, i));
          parts.push('\n');
          line += 1;
          i += raw.charCodeAt(i + 1) === 10 ? 2 : 1;
          seg = i;
        } else {
          if (c === 10) line += 1;
          i += 1;
        }
      }
      if (m > seg) parts.push(raw.slice(seg, m));
      value = parts.join('');
    }
    pos = close + 1;
    if (pos >= n) { fEnded = END; return value; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fEnded = COMMA; return value; }
    if (c === 10) { pos += 1; line += 1; fEnded = LINE_BREAK; return value; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; fEnded = LINE_BREAK; return value; }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (fAdded > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;
    let lastQuoted = false;

    // A record whose whole line is plain — no quote anywhere in it, and no CR but a CRLF's at its
    // end — splits in one native call, exactly as the field-by-field read would split it.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    let plainEnd = lineEnd;
    if (nl !== -1 && plainEnd > pos && text.charCodeAt(plainEnd - 1) === 13) plainEnd -= 1; // CRLF
    const plain = text.slice(pos, plainEnd);
    if (plain.indexOf('"') === -1 && plain.indexOf('\r') === -1) {
      fields = plain.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      fields = [];
      let ended;
      do {
        if (pos < n && text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          fields.push(readQuoted());
        } else {
          lastQuoted = false;
          fields.push(readUnquoted(''));
        }
        ended = fEnded;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors
    // stay). The plain path never produces one: its line held a character that was no line break.
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
