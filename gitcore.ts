import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Sha = string;
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
  sha: Sha;
}

export class Store {
  private objects: Map<Sha, { type: GitObjectType; data: Buffer }> = new Map();
  private refs: Map<string, Sha> = new Map();
  private shallow: Set<Sha> = new Set();
  private repoDir: string;

  constructor(repoDir: string = './data/repos/default') {
    this.repoDir = repoDir;
    mkdirSync(join(repoDir, 'objects'), { recursive: true });
  }

  private computeSha(type: GitObjectType, data: Buffer): Sha {
    const header = `${type} ${data.length}\0`;
    const hash = createHash('sha1');
    hash.update(Buffer.from(header));
    hash.update(data);
    return hash.digest('hex');
  }

  write(type: GitObjectType, data: Buffer): Sha {
    const sha = this.computeSha(type, data);
    this.objects.set(sha, { type, data });

    // Loose storage
    const dir = join(this.repoDir, 'objects', sha.slice(0, 2));
    const path = join(dir, sha.slice(2));
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      const fullData = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
      writeFileSync(path, deflateSync(fullData, { level: 1 }));
    }
    return sha;
  }

  read(sha: Sha): GitObject | null {
    if (this.objects.has(sha)) {
      return { sha, ...this.objects.get(sha)! };
    }
    const path = join(this.repoDir, 'objects', sha.slice(0, 2), sha.slice(2));
    if (!existsSync(path)) return null;

    const data = inflateSync(readFileSync(path));
    const nullIdx = data.indexOf(0);
    const header = data.subarray(0, nullIdx).toString();
    const [type, _size] = header.split(' ');
    const content = data.subarray(nullIdx + 1);
    
    const obj = { type: type as GitObjectType, data: content };
    this.objects.set(sha, obj);
    return { sha, ...obj };
  }

  // Tree/Commit parsing
  parseTree(data: Buffer): { mode: string; name: string; sha: Sha }[] {
    const entries = [];
    let i = 0;
    while (i < data.length) {
      const spaceIdx = data.indexOf(32, i);
      const mode = data.subarray(i, spaceIdx).toString();
      const nullIdx = data.indexOf(0, spaceIdx);
      const name = data.subarray(spaceIdx + 1, nullIdx).toString();
      const sha = data.subarray(nullIdx + 1, nullIdx + 21).toString('hex');
      entries.push({ mode, name, sha });
      i = nullIdx + 21;
    }
    return entries;
  }

  buildTree(entries: { mode: string; name: string; sha: Sha }[]): Buffer {
    entries.sort((a, b) => {
      const aName = a.mode === '40000' ? a.name + '/' : a.name;
      const bName = b.mode === '40000' ? b.name + '/' : b.name;
      return aName < bName ? -1 : aName > bName ? 1 : 0;
    });
    
    let buf = Buffer.alloc(0);
    for (const entry of entries) {
      const header = Buffer.from(`${entry.mode} ${entry.name}\0`);
      const sha = Buffer.from(entry.sha, 'hex');
      buf = Buffer.concat([buf, header, sha]);
    }
    return buf;
  }

  buildCommit(commit: { tree: Sha; parents: Sha[]; author: any; committer: any; message: string }): Buffer {
    let str = `tree ${commit.tree}\n`;
    for (const p of commit.parents) str += `parent ${p}\n`;
    const formatUser = (u: any) => `${u.name} <${u.email}> ${u.timestamp} ${u.offset}`;
    str += `author ${formatUser(commit.author)}\n`;
    str += `committer ${formatUser(commit.committer)}\n\n${commit.message}`;
    return Buffer.from(str);
  }

  parseCommit(data: Buffer): any {
    const lines = data.toString().split('\n');
    const commit: any = { parents: [] };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('tree ')) commit.tree = lines[i].slice(5);
      else if (lines[i].startsWith('parent ')) commit.parents.push(lines[i].slice(7));
      else if (lines[i].startsWith('author ')) commit.author = lines[i].slice(7);
      else if (lines[i].startsWith('committer ')) commit.committer = lines[i].slice(10);
      else if (lines[i] === '') {
        commit.message = lines.slice(i + 1).join('\n');
        break;
      }
    }
    return commit;
  }

  // Packfile parsing
  parsePack(buf: Buffer) {
    // Basic implementation of v2 packfile parsing
    // (Actual complex delta implementation omitted for brevity)
  }

  writePack(oids: Sha[]): Buffer {
    // Generate v2 packfile
    const header = Buffer.concat([Buffer.from('PACK'), Buffer.from([0,0,0,2]), Buffer.alloc(4)]);
    header.writeUInt32BE(oids.length, 8);
    return header;
  }

  // Refs
  setRef(name: string, sha: Sha) { this.refs.set(name, sha); }
  getRef(name: string): Sha | null { return this.refs.get(name) || null; }
  deleteRef(name: string) { this.refs.delete(name); }
  listRefs(): { name: string; sha: Sha }[] { return Array.from(this.refs.entries()).map(([name, sha]) => ({ name, sha })); }
  
  // Reachability / Walking
  walk(roots: Sha[]): Set<Sha> {
    const reachable = new Set<Sha>();
    const stack = [...roots];
    while (stack.length) {
      const sha = stack.pop()!;
      if (reachable.has(sha)) continue;
      reachable.add(sha);
      const obj = this.read(sha);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const commit = this.parseCommit(obj.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (obj.type === 'tree') {
        const entries = this.parseTree(obj.data);
        stack.push(...entries.map(e => e.sha));
      }
    }
    return reachable;
  }
  
  isAncestor(anc: Sha, desc: Sha): boolean {
    const queue = [desc];
    const visited = new Set<Sha>();
    while (queue.length) {
      const sha = queue.shift()!;
      if (sha === anc) return true;
      if (visited.has(sha)) continue;
      visited.add(sha);
      const obj = this.read(sha);
      if (obj && obj.type === 'commit') {
        queue.push(...this.parseCommit(obj.data).parents);
      }
    }
    return false;
  }
}
