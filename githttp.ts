// git smart HTTP: server side of upload-pack (v2 + v0) and receive-pack (v0),
// built on gitpack.ts (pack read/write) and gitcore.ts (Store).
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Store, type Sha, type GitObjectType } from './gitcore.ts';
import { parsePackBuffer, writePackBuffer } from './gitpack.ts';
import { registry, type RepoRecord } from './repos.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'forge/1';

const pktLine = (str: string | Buffer): Buffer => {
  const buf = typeof str === 'string' ? Buffer.from(str, 'utf8') : str;
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), buf]);
};
const flushPkt = Buffer.from('0000', 'ascii');
const delimPkt = Buffer.from('0001', 'ascii');

function pktLines(items: (string | Buffer | null)[]): Buffer {
  const out: Buffer[] = [];
  for (const it of items) {
    if (it === null) out.push(flushPkt);
    else out.push(pktLine(it));
  }
  return Buffer.concat(out);
}

interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; data?: Buffer; caps?: string }

function parsePktLines(buf: Buffer): { pkts: Pkt[]; trailing: number } {
  const pkts: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenStr = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) return { pkts, trailing: i };
    const len = parseInt(lenStr, 16);
    if (len === 0) { pkts.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { pkts.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { pkts.push({ kind: 'end' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) return { pkts, trailing: i };
    let payload = buf.subarray(i + 4, i + len);
    let caps: string | undefined;
    const nul = payload.indexOf(0);
    if (nul >= 0) {
      caps = payload.subarray(nul + 1).toString('utf8');
      payload = payload.subarray(0, nul);
    }
    pkts.push({ kind: 'data', data: payload, caps });
    i += len;
  }
  return { pkts, trailing: i };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sideBand(data: Buffer, chunkMax = 65515): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunkMax) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(i, i + chunkMax)])));
  }
  out.push(flushPkt);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- refs / advertisement

function sortedRefs(store: Store): { name: string; sha: Sha }[] {
  const refs = store.listRefs().filter((r) => r.name.startsWith('refs/'));
  // HEAD first is not required; sort for determinism
  refs.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return refs;
}

function defaultBranchOf(store: Store): string | null {
  const heads = store.listRefs().filter((r) => r.name.startsWith('refs/heads/')).map((r) => r.name).sort();
  if (heads.includes('refs/heads/main')) return 'refs/heads/main';
  if (heads.length) return heads[0]!;
  return null;
}

function peelTag(store: Store, sha: Sha): Sha | null {
  const obj = store.read(sha);
  if (!obj || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const m = /^object ([0-9a-f]{40})/m.exec(text);
  return m ? (m[1] as Sha) : null;
}

function v2Advertisement(store: Store): Buffer {
  const caps = [
    `agent=${AGENT}`,
    'ls-refs=unborn peel symrefs',
    'fetch=shallow filter thin-pack ofs-delta',
    'object-format=sha1',
  ];
  return Buffer.concat([
    pktLine('version 2\n'),
    ...caps.map((c) => pktLine(c + '\n')),
    flushPkt,
  ]);
}

function v0Advertisement(store: Store, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? ['multi_ack_detailed', 'multi_ack', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', `agent=${AGENT}`]
      : ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];
  const refs = sortedRefs(store);
  const head = defaultBranchOf(store);
  if (head) caps.push(`symref=HEAD:${head}`);
  const capStr = caps.join(' ');
  const out: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt];
  if (refs.length === 0) {
    out.push(pktLine(`${ZERO} capabilities\0${capStr}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const line = first ? `${ref.sha} ${ref.name}\0${capStr}\n` : `${ref.sha} ${ref.name}\n`;
      first = false;
      out.push(pktLine(line));
      const peeled = peelTag(store, ref.sha);
      if (peeled) out.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  out.push(flushPkt);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- upload-pack: object selection

interface FetchPlan {
  store: Store;
  wants: Sha[];
  haves: Sha[];
  shallowIn: Sha[];
  depth: number | null;
}

function walkLimited(store: Store, roots: Sha[], stopAt: Set<Sha>, depth: number | null, honorStops = false): {
  objects: Map<Sha, { type: GitObjectType; data: Buffer }>;
  shallowOut: Sha[];
} {
  const objects = new Map<Sha, { type: GitObjectType; data: Buffer }>();
  const shallowOut: Sha[] = [];
  // BFS over commits, level = depth from roots
  type Node = { sha: Sha; level: number };
  const queue: Node[] = roots.filter((r) => store.read(r)).map((sha) => ({ sha, level: 0 }));
  const seenCommit = new Set<Sha>();
  const addTree = (sha: Sha) => {
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (objects.has(s)) continue;
      const obj = store.read(s);
      if (!obj) continue;
      objects.set(s, { type: obj.type, data: obj.data });
      if (obj.type === 'tree') {
        for (const e of store.parseTree(obj.data)) {
          if (e.mode === '160000') continue;
          stack.push(e.sha);
        }
      }
    }
  };
  let level = 0;
  while (queue.length) {
    const node = queue.shift()!;
    if (seenCommit.has(node.sha)) continue;
    seenCommit.add(node.sha);
    const obj = store.read(node.sha);
    if (!obj || obj.type !== 'commit') continue;
    objects.set(node.sha, { type: 'commit', data: obj.data });
    const parsed = store.parseCommit(obj.data);
    const hasParents = parsed.parents && parsed.parents.length > 0;
    const atClientBoundary = honorStops && stopAt.has(node.sha);
    if (hasParents) {
      if (atClientBoundary) {
        // the client declared this commit shallow: its parents are not known to it
      } else if (depth !== null && node.level + 1 >= depth) {
        // the parents are beyond the requested depth: this commit becomes the boundary
        shallowOut.push(node.sha);
      } else {
        for (const p of parsed.parents) {
          if (store.read(p)) queue.push({ sha: p, level: node.level + 1 });
        }
      }
    }
    addTree(parsed.tree);
  }
  // a shallow clone with depth N: the client must know the tips at level N-1 are shallow
  return { objects, shallowOut: [...new Set(shallowOut)] };
}

function planPack(plan: FetchPlan): { pack: Buffer | null; shallowOut: Sha[]; unshallow: Sha[] } {
  const { store, wants, haves, shallowIn, depth } = plan;
  if (!wants.length) return { pack: null, shallowOut: [], unshallow: [] };
  const stopAt = new Set<Sha>(shallowIn);
  const sendWalk = walkLimited(store, wants, stopAt, depth);
  let sendables = sendWalk.objects;
  const shallowOut = sendWalk.shallowOut.filter((s) => !stopAt.has(s));
  if (haves.length) {
    // subtract exactly what the client already holds: walk each have tip, stopping at
    // the client's shallow boundaries
    const haveWalk = walkLimited(store, haves, stopAt, null, true);
    for (const sha of haveWalk.objects.keys()) sendables.delete(sha);
  }
  if (sendables.size === 0) return { pack: null, shallowOut, unshallow: [] };
  // annotated tags: any tag object whose target made it into the send set must ride along
  for (const ref of store.listRefs()) {
    const obj = store.read(ref.sha);
    if (!obj || obj.type !== 'tag') continue;
    let cursor = ref.sha;
    for (let hop = 0; hop < 8; hop++) {
      const cur = store.read(cursor);
      if (!cur) break;
      if (cur.type === 'tag') {
        const text = cur.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})/m.exec(text);
        if (!m) break;
        if (sendables.has(m[1] as Sha) && !sendables.has(cursor)) sendables.set(cursor, { type: 'tag', data: cur.data });
        cursor = m[1] as Sha;
        continue;
      }
      break;
    }
  }
  const entries = [...sendables.values()];
  return { pack: writePackBuffer(entries), shallowOut, unshallow: [] };
}

// ---------------------------------------------------------------- handler

function contentTypeFor(service: string): string {
  return `application/x-${service}-advertisement`;
}

export async function handleGitHttp(
  repoId: string,
  subpath: string,
  service: string,
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo?: RepoRecord,
): Promise<void> {
  const method = req.method ?? 'GET';
  const protoHeader = String(req.headers['git-protocol'] ?? '');
  const isV2 = service === 'git-upload-pack' && /version=2/.test(protoHeader);

  const answer = (status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}) => {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...extra });
    res.end(buf);
  };
  const notFound = () => answer(404, JSON.stringify({ message: 'Not Found' }), 'application/json');

  // info/refs
  if (subpath === 'info/refs' && method === 'GET') {
    if (isV2) return answer(200, v2Advertisement(store), contentTypeFor(service));
    return answer(200, v0Advertisement(store, service), contentTypeFor(service));
  }

  if (method !== 'POST') return notFound();

  const body = await readBody(req);

  // ---------------- upload-pack
  if (subpath === 'git-upload-pack') {
    if (isV2) {
      const { pkts } = parsePktLines(body);
      let command = '';
      const args: string[] = [];
      let pastDelim = false;
      for (const p of pkts) {
        if (p.kind === 'delim') { pastDelim = true; continue; }
        if (p.kind !== 'data') continue;
        const line = p.data!.toString('utf8').replace(/\n$/, '');
        if (!pastDelim) {
          if (line.startsWith('command=')) command = line.slice(8);
        } else {
          args.push(line);
        }
      }
      if (command === 'ls-refs') {
        const wantPeel = args.includes('peel');
        const wantSymrefs = args.includes('symrefs');
        const wantUnborn = args.includes('unborn');
        const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
        const keep = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
        const out: Buffer[] = [];
        const head = defaultBranchOf(store);
        if (wantUnborn && !head) {
          out.push(pktLine(`unborn HEAD symref-target:refs/heads/main\n`));
        } else {
          if (head && keep('HEAD')) {
            out.push(pktLine(`${store.getRef(head) ?? ZERO} HEAD${wantSymrefs ? ` symref-target:${head}` : ''}\n`));
          }
          for (const ref of sortedRefs(store)) {
            if (!keep(ref.name)) continue;
            let line = `${ref.sha} ${ref.name}`;
            const peeled = wantPeel ? peelTag(store, ref.sha) : null;
            if (peeled) line += ` peeled:${peeled}`;
            out.push(pktLine(line + '\n'));
          }
        }
        out.push(flushPkt);
        return answer(200, Buffer.concat(out), 'application/x-git-upload-pack-result');
      }
      if (command === 'fetch') {
        const wants: Sha[] = [];
        const haves: Sha[] = [];
        const shallowIn: Sha[] = [];
        let depth: number | null = null;
        for (const a of args) {
          if (a.startsWith('want ')) wants.push(a.slice(5).split(' ')[0] as Sha);
          else if (a.startsWith('have ')) haves.push(a.slice(5) as Sha);
          else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8) as Sha);
          else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
        }
        const plan = planPack({ store, wants, haves, shallowIn, depth });
        const out: Buffer[] = [pktLine('acknowledgments\n')];
        out.push(pktLine('NAK\n'));
        out.push(flushPkt);
        if (plan.shallowOut.length) {
          out.push(pktLine('shallow-info\n'));
          for (const s of plan.shallowOut) out.push(pktLine(`shallow ${s}\n`));
          out.push(flushPkt);
        }
        if (plan.pack) {
          out.push(pktLine('packfile\n'));
          out.push(sideBand(plan.pack));
          out.push(flushPkt);
        }
        return answer(200, Buffer.concat(out), 'application/x-git-upload-pack-result');
      }
      // unknown command: answer an empty flush
      return answer(200, flushPkt, 'application/x-git-upload-pack-result');
    }

    // v0 upload-pack
    const { pkts } = parsePktLines(body);
    const wants: Sha[] = [];
    const haves: Sha[] = [];
    const shallowIn: Sha[] = [];
    let depth: number | null = null;
    let caps = '';
    let section = 0;
    for (const p of pkts) {
      if (p.kind === 'flush') { section++; continue; }
      if (p.kind !== 'data') continue;
      const line = p.data!.toString('utf8').replace(/\n$/, '');
      if (line === '') continue;
      if (section === 0) {
        if (line.startsWith('want ')) {
          const rest = line.slice(5);
          const sp = rest.indexOf(' ');
          if (sp >= 0) { wants.push(rest.slice(0, sp) as Sha); caps = rest.slice(sp + 1); }
          else wants.push(rest as Sha);
        } else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8) as Sha);
        else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
      } else {
        if (line.startsWith('have ')) haves.push(line.slice(5) as Sha);
      }
    }
    const done = /(^|\s)done(\s|$)/.test(body.toString('utf8'));
    const plan = planPack({ store, wants, haves, shallowIn, depth: done ? depth : null });
    const out: Buffer[] = [];
    for (const s of plan.shallowOut) out.push(pktLine(`shallow ${s}\n`));
    out.push(pktLine('NAK\n'));
    if (plan.pack) {
      if (caps.includes('side-band-64k')) {
        out.push(sideBand(plan.pack));
        out.push(flushPkt);
      } else {
        out.push(plan.pack);
      }
    } else {
      out.push(flushPkt);
    }
    return answer(200, Buffer.concat(out), 'application/x-git-upload-pack-result');
  }

  // ---------------- receive-pack
  if (subpath === 'git-receive-pack') {
    const { pkts, trailing } = parsePktLines(body);
    const commands: { old: Sha; new: Sha; ref: string }[] = [];
    let caps = '';
    for (const p of pkts) {
      if (p.kind !== 'data') continue;
      const line = p.data!.toString('utf8').replace(/\n$/, '');
      if (!line) continue;
      if (line.startsWith('shallow ') || line.startsWith('push-cert')) continue;
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ old: parts[0] as Sha, new: parts[1] as Sha, ref: parts[2] });
        if (p.caps) caps = p.caps;
      }
    }
    const packBytes = body.subarray(trailing);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length >= 12 && commands.some((c) => c.new !== ZERO)) {
      try {
        const parsed = parsePackBuffer(packBytes, (sha) => store.read(sha) ?? null);
        for (const [sha, obj] of parsed.objects) {
          if (!store.read(sha)) store.write(obj.type, obj.data);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${(err as Error).message}`;
      }
    }
    const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
    for (const cmd of commands) {
      const current = store.getRef(cmd.ref);
      if (cmd.old !== ZERO && cmd.old !== (current ?? ZERO)) {
        report.push(`ng ${cmd.ref} bad old value`);
        continue;
      }
      if (cmd.new === ZERO) {
        if (cmd.old !== ZERO && !current) { report.push(`ng ${cmd.ref} missing ref`); continue; }
        store.deleteRef(cmd.ref);
        report.push(`ok ${cmd.ref}`);
        continue;
      }
      if (cmd.old === ZERO) {
        if (current) { report.push(`ng ${cmd.ref} already exists`); continue; }
        store.setRef(cmd.ref, cmd.new);
        report.push(`ok ${cmd.ref}`);
        continue;
      }
      // update: old must be current and the push must fast-forward
      if (!unpackOk) { report.push(`ng ${cmd.ref} n/a (unpacker error)`); continue; }
      const ff = store.isAncestor(cmd.old, cmd.new);
      if (!ff) { report.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      store.setRef(cmd.ref, cmd.new);
      report.push(`ok ${cmd.ref}`);
    }
    let reportBuf = Buffer.concat([
      pktLine('unpack ok\n'),
      ...report.slice(1).map((r) => pktLine(r + '\n')),
      flushPkt,
    ]);
    if (unpackOk === false) {
      reportBuf = Buffer.concat([pktLine(`unpack ${unpackDetail}\n`), ...report.slice(1).map((r) => pktLine(r + '\n')), flushPkt]);
    }
    if (caps.includes('side-band-64k')) {
      const framed = sideBand(reportBuf);
      return answer(200, framed, 'application/x-git-receive-pack-result');
    }
    return answer(200, reportBuf, 'application/x-git-receive-pack-result');
  }

  return notFound();
}
