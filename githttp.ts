import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Store } from './gitcore.ts';
import { registry } from './repos.ts';

const pktLine = (str: string | Buffer) => {
  const buf = typeof str === 'string' ? Buffer.from(str) : str;
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len), buf]);
};

const flushPkt = Buffer.from('0000');
const delimPkt = Buffer.from('0001');
const responseEndPkt = Buffer.from('0002');

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parsePktLines(buf: Buffer): { type: 'data' | 'flush' | 'delim' | 'end', data?: Buffer }[] {
  const lines = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) break;
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (len === 0) {
      lines.push({ type: 'flush' });
      i += 4;
    } else if (len === 1) {
      lines.push({ type: 'delim' });
      i += 4;
    } else if (len === 2) {
      lines.push({ type: 'end' });
      i += 4;
    } else {
      if (i + len > buf.length) break;
      lines.push({ type: 'data', data: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return lines;
}

export async function handleGitHttp(
  repoId: string,
  subpath: string,
  service: string,
  req: IncomingMessage,
  res: ServerResponse,
  store: Store
) {
  const repo = registry.repos.get(repoId);
  if (!repo) {
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  const method = req.method ?? 'GET';
  const protocol = req.headers['git-protocol'] as string;

  if (method === 'GET' && subpath === 'info/refs') {
    if (service === 'git-upload-pack' && protocol === 'version=2') {
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
      res.write(pktLine('version 2\n'));
      res.write(pktLine('agent=forge/1\n'));
      res.write(pktLine('ls-refs=unborn\n'));
      res.write(pktLine('fetch=shallow wait-for-done\n'));
      res.write(flushPkt);
      res.end();
      return;
    } else {
      // v0
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
      res.write(pktLine(`# service=${service}\n`));
      res.write(flushPkt);
      
      const refs = store.listRefs().sort((a, b) => a.name < b.name ? -1 : 1);
      const caps = service === 'git-upload-pack' 
        ? 'multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta agent=forge/1 symref=HEAD:refs/heads/main'
        : 'report-status report-status-v2 side-band-64k delete-refs atomic agent=forge/1';

      if (refs.length === 0) {
        res.write(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`));
      } else {
        refs.forEach((ref, i) => {
          const line = i === 0 
            ? `${ref.sha} ${ref.name}\0${caps}\n`
            : `${ref.sha} ${ref.name}\n`;
          res.write(pktLine(line));
        });
      }
      res.write(flushPkt);
      res.end();
      return;
    }
  }

  // POST handling
  if (method === 'POST') {
    const body = await readBody(req);
    const lines = parsePktLines(body);
    
    if (subpath === 'git-upload-pack') {
      res.writeHead(200, { 'content-type': `application/x-${service}-result` });
      
      if (protocol === 'version=2') {
        for (const line of lines) {
          if (line.type !== 'data') continue;
          const str = line.data!.toString();
          if (str.startsWith('command=ls-refs')) {
            const refs = store.listRefs();
            for (const ref of refs) {
              res.write(pktLine(`${ref.sha} ${ref.name}\n`));
            }
            res.write(flushPkt);
          } else if (str.startsWith('command=fetch')) {
            res.write(pktLine('acknowledgments\n'));
            res.write(flushPkt);
            
            res.write(pktLine('packfile\n'));
            const pack = store.writePack([]);
            res.write(pack);
            res.write(flushPkt);
            
            res.write(responseEndPkt);
          }
        }
      } else {
        // v0 upload-pack: want/have parsing needed
        res.write(pktLine('NAK\n'));
      }
      res.end();
      return;
    } else if (subpath === 'git-receive-pack') {
      // Process commands
      const commands = [];
      for (const line of lines) {
        if (line.type !== 'data') continue;
        const str = line.data!.toString().trim();
        if (!str) continue;
        const [oldSha, newSha, refName] = str.split(' ');
        commands.push({ oldSha, newSha, refName });
      }
      
      const report = [];
      for (const cmd of commands) {
        const currentSha = store.getRef(cmd.refName) || '0000000000000000000000000000000000000000';
        
        if (cmd.oldSha !== '0000000000000000000000000000000000000000' && cmd.oldSha !== currentSha) {
          report.push(`ng ${cmd.refName} bad old value`);
          continue;
        }
        
        // Fast-forward check
        if (cmd.oldSha !== '0000000000000000000000000000000000000000' && 
            cmd.newSha !== '0000000000000000000000000000000000000000') {
          if (!store.isAncestor(cmd.oldSha, cmd.newSha)) {
            report.push(`ng ${cmd.refName} non-fast-forward`);
            continue;
          }
        }
        
        // Apply
        if (cmd.newSha === '0000000000000000000000000000000000000000') {
          store.deleteRef(cmd.refName);
        } else {
          store.setRef(cmd.refName, cmd.newSha);
        }
        report.push(`ok ${cmd.refName}`);
      }
      
      res.writeHead(200, { 'content-type': `application/x-${service}-result` });
      res.write(pktLine('unpack ok\n'));
      for (const r of report) {
        res.write(pktLine(`${r}\n`));
      }
      res.write(flushPkt);
      res.end();
      return;
    }
  }
}
