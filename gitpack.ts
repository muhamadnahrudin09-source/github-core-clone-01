import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { GitObject, GitObjectType, Sha } from './gitcore.ts';

const TYPE_NUM: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_ID: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate the zlib stream that starts exactly at `start`; returns data + the offset after it. */
export function inflateAt(buf: Buffer, start: number, expectedSize?: number): { data: Buffer; end: number } {
  // Doubling then binary search on the input window: inflateSync errors on truncated input.
  let lo = 1;
  let hi = Math.min(buf.length - start, 1 << 24);
  let okData: Buffer | null = null;
  let okEnd = -1;
  // find a window that works
  let probe = Math.min(hi, Math.max(64, (expectedSize ?? 0) + 32));
  let found = -1;
  let failed = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      inflateSync(buf.subarray(start, start + probe));
      found = probe;
      break;
    } catch {
      failed = probe;
      if (probe >= hi) break;
      probe = Math.min(hi, probe * 2);
    }
  }
  if (found === -1) throw new Error(`cannot inflate at ${start}`);
  hi = found; lo = failed + 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const data = inflateSync(buf.subarray(start, start + mid));
      okData = data;
      okEnd = start + mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (!okData) throw new Error(`cannot inflate at ${start}`);
  return { data: okData, end: okEnd };
}

export interface ParsedPack {
  objects: Map<Sha, { type: GitObjectType; data: Buffer }>;
  count: number;
  deltaCount: number;
}

function readVarintSize(buf: Buffer, i: number): { size: number; type: number; next: number } {
  let b = buf[i++];
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    b = buf[i++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { size, type, next: i };
}

function readOffsetVarint(buf: Buffer, i: number): { value: number; next: number } {
  let b = buf[i++];
  let value = b & 0x7f;
  while (b & 0x80) {
    b = buf[i++];
    value = ((value + 1) << 7) | (b & 0x7f);
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const baseSize = readVar();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVar();
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (i < delta.length) {
    const cmd = delta[i++];
    if (cmd & 0x80) {
      let off = 0;
      let len = 0;
      if (cmd & 0x01) off |= delta[i++];
      if (cmd & 0x02) off |= delta[i++] << 8;
      if (cmd & 0x04) off |= delta[i++] << 16;
      if (cmd & 0x08) off |= delta[i++] << 24;
      if (cmd & 0x10) len |= delta[i++];
      if (cmd & 0x20) len |= delta[i++] << 8;
      if (cmd & 0x40) len |= delta[i++] << 16;
      if (len === 0) len = 0x10000;
      base.copy(out, o, off, off + len);
      o += len;
    } else if (cmd > 0) {
      delta.copy(out, o, i, i + cmd);
      i += cmd;
      o += cmd;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  if (o !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Parse a v2 packfile. `thinLookup` resolves ref-delta bases missing from the pack itself
 * (thin packs pushed over git smart HTTP reference objects the receiver already has).
 */
export function parsePackBuffer(buf: Buffer, thinLookup?: (sha: Sha) => { type: GitObjectType; data: Buffer } | null): ParsedPack {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const stored = buf.subarray(0, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (createHash('sha1').update(stored).digest('hex') !== trailer) throw new Error('pack checksum mismatch');
  const objects: Map<Sha, { type: GitObjectType; data: Buffer }> = new Map();
  const raw: { offset: number; type: number; data: Buffer; baseOfs?: number; baseRef?: Sha }[] = [];
  let i = 12;
  for (let n = 0; n < count; n++) {
    const { size, type, next } = readVarintSize(buf, i);
    if (type >= 1 && type <= 4) {
      const { data, end } = inflateAt(buf, next, size);
      raw.push({ offset: i, type, data });
      i = end;
    } else if (type === 6) {
      const { value: rel, next: afterOfs } = readOffsetVarint(buf, next);
      const { data, end } = inflateAt(buf, afterOfs, size);
      raw.push({ offset: i, type, data, baseOfs: i - rel });
      i = end;
    } else if (type === 7) {
      const baseRef = buf.subarray(next, next + 20).toString('hex');
      const { data, end } = inflateAt(buf, next + 20, size);
      raw.push({ offset: i, type, data, baseRef });
      i = end;
    } else {
      throw new Error(`bad pack object type ${type}`);
    }
  }
  // resolve, applying deltas as needed
  const byOffset = new Map<number, number>(); // offset -> index in resolved list
  const resolved: ({ type: GitObjectType; data: Buffer } | null)[] = raw.map(() => null);
  const resolve = (idx: number, depth = 0): { type: GitObjectType; data: Buffer } => {
    const r = raw[idx];
    if (resolved[idx]) return resolved[idx]!;
    if (depth > 64) throw new Error('delta too deep');
    let out: { type: GitObjectType; data: Buffer };
    if (r.type >= 1 && r.type <= 4) {
      out = { type: TYPE_NUM[r.type]!, data: r.data };
    } else if (r.type === 6) {
      let baseIdx = byOffset.get(r.baseOfs!);
      if (baseIdx === undefined) {
        baseIdx = raw.findIndex((x) => x.offset === r.baseOfs);
        if (baseIdx >= 0) byOffset.set(r.baseOfs!, baseIdx);
      }
      if (baseIdx === undefined || baseIdx < 0) throw new Error('ofs delta base missing');
      const base = resolve(baseIdx, depth + 1);
      out = { type: base.type, data: applyDelta(base.data, r.data) };
    } else {
      // ref delta: base may be inside the pack or a thin base from the store
      let found: { type: GitObjectType; data: Buffer } | null = null;
      for (let k = 0; k < raw.length; k++) {
        if (k === idx) continue;
        if (!resolved[k] && raw[k].type >= 1 && raw[k].type <= 4) {
          const o = resolve(k, depth + 1);
          const h = createHash('sha1').update(Buffer.from(`${o.type} ${o.data.length}\0`)).update(o.data).digest('hex');
          if (h === r.baseRef) { found = o; break; }
        } else if (resolved[k]) {
          const o = resolved[k]!;
          const h = createHash('sha1').update(Buffer.from(`${o.type} ${o.data.length}\0`)).update(o.data).digest('hex');
          if (h === r.baseRef) { found = o; break; }
        }
      }
      if (!found && thinLookup) {
        const t = thinLookup(r.baseRef);
        if (t) found = t;
      }
      if (!found) throw new Error(`ref delta base ${r.baseRef} missing`);
      out = { type: found.type, data: applyDelta(found.data, r.data) };
    }
    resolved[idx] = out;
    return out;
  };
  let deltaCount = 0;
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw[idx].type >= 6) deltaCount++;
    const o = resolve(idx);
    const h = createHash('sha1').update(Buffer.from(`${o.type} ${o.data.length}\0`)).update(o.data).digest('hex');
    objects.set(h, o);
  }
  return { objects, count, deltaCount };
}

/** Build a v2 packfile from plain (non-delta) objects in the given order. */
export function writePackBuffer(entries: { type: GitObjectType; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  chunks.push(head);
  for (const e of entries) {
    // type + size varint
    let size = e.data.length;
    let b = (TYPE_ID[e.type] << 4) | (size & 0x0f);
    size >>= 4;
    let hdr: number[] = [];
    while (size > 0) {
      hdr.push(b | 0x80);
      b = size & 0x7f;
      size >>= 7;
    }
    hdr.push(b);
    chunks.push(Buffer.from(hdr));
    chunks.push(deflateSync(e.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
