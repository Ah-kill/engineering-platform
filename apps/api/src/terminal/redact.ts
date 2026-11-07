/**
 * Removes known secret values from a byte stream (terminal output) before it reaches the
 * browser. A secret can arrive split across chunks, so the end of each chunk that could be
 * the start of a secret is held back (never more than the longest secret length − 1 bytes)
 * until the next chunk shows whether it completes one. The caller flushes held bytes on a
 * short timer so an interactive shell never waits on output. Output is also cut only on
 * UTF-8 character boundaries, so a multi-byte character is never split between messages.
 *
 * Best effort, like all redaction: a secret printed in pieces more than one flush apart, or
 * transformed (base64, reversed, ...), is not recognised. The primary control is still not
 * giving the workspace secrets it does not need.
 */

export const REDACTED = '[redacted]';
/** Values shorter than this are not redacted: they would mangle ordinary output. Matches redactSecrets. */
export const MIN_SECRET_LENGTH = 8;

export class StreamRedactor {
  private readonly needles: Buffer[];
  private readonly replacement: Buffer;
  private held: Buffer = Buffer.alloc(0);

  constructor(secrets: Iterable<string>, replacement = REDACTED) {
    const unique = new Set<string>();
    for (const s of secrets) if (typeof s === 'string' && s.length >= MIN_SECRET_LENGTH) unique.add(s);
    // Longest first, so a secret that contains another is replaced whole.
    this.needles = [...unique].map((s) => Buffer.from(s, 'utf8')).sort((a, b) => b.length - a.length);
    this.replacement = Buffer.from(replacement, 'utf8');
  }

  get active(): boolean {
    return this.needles.length > 0;
  }

  /** Bytes currently held back. */
  get pending(): number {
    return this.held.length;
  }

  /** Accepts a chunk and returns the bytes that are safe to send now (possibly empty). */
  push(chunk: Buffer): Buffer {
    const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    if (!this.needles.length) {
      const cut = utf8Boundary(data, data.length);
      this.held = Buffer.from(data.subarray(cut));
      return data.subarray(0, cut);
    }
    const { out, rest } = this.replaceComplete(data);
    let cut = rest.length - this.partialSuffix(rest);
    cut = utf8Boundary(rest, cut);
    this.held = Buffer.from(rest.subarray(cut));
    out.push(rest.subarray(0, cut));
    return Buffer.concat(out);
  }

  /** Returns everything still held back (redacting any complete secret), e.g. on a timer or at exit. */
  flush(): Buffer {
    if (!this.held.length) return Buffer.alloc(0);
    const { out, rest } = this.replaceComplete(this.held);
    this.held = Buffer.alloc(0);
    out.push(rest);
    return Buffer.concat(out);
  }

  /** Replaces every complete occurrence; returns the pieces so far and the unmatched remainder. */
  private replaceComplete(data: Buffer): { out: Buffer[]; rest: Buffer } {
    const out: Buffer[] = [];
    let pos = 0;
    for (;;) {
      let best = -1;
      let bestLen = 0;
      for (const n of this.needles) {
        const at = data.indexOf(n, pos);
        if (at >= 0 && (best < 0 || at < best || (at === best && n.length > bestLen))) {
          best = at;
          bestLen = n.length;
        }
      }
      if (best < 0) break;
      out.push(data.subarray(pos, best), this.replacement);
      pos = best + bestLen;
    }
    return { out, rest: data.subarray(pos) };
  }

  /** Length of the longest suffix of `data` that is a proper prefix of some secret. */
  private partialSuffix(data: Buffer): number {
    let longest = 0;
    for (const n of this.needles) {
      const max = Math.min(n.length - 1, data.length);
      // Candidate starts: positions in the last `max` bytes holding the secret's first byte.
      for (let start = data.length - max; start < data.length; start++) {
        const len = data.length - start;
        if (len <= longest) break;
        if (data[start] === n[0] && data.subarray(start).equals(n.subarray(0, len))) {
          longest = len;
          break;
        }
      }
    }
    return longest;
  }
}

/**
 * The largest position ≤ `cut` where `buf` can be split without cutting a multi-byte UTF-8
 * character: if the character that starts before `cut` does not end by `cut`, split before it.
 */
export function utf8Boundary(buf: Buffer, cut: number): number {
  const end = Math.min(Math.max(cut, 0), buf.length);
  let i = end - 1;
  // Walk back over continuation bytes (10xxxxxx) to the character's first byte.
  for (let back = 0; i >= 0 && back < 3 && (buf[i]! & 0xc0) === 0x80; back++) i--;
  if (i < 0) return end;
  const lead = buf[i]!;
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i + size > end ? i : end;
}
