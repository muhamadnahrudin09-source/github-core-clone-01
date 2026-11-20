import { createApp } from './app.ts';
import { registry } from './repos.ts';
import http from 'node:http';

const pktLine = (str: string) => {
  const buf = Buffer.from(str);
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len), buf]);
};

const server = createApp();
server.listen(0, async () => {
  const port = (server.address() as any).port;
  const repo = registry.createRepo('owner', 'repo');
  
  // Set a base commit
  const commitSha = repo.git.write('commit', Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\ninitial commit'));
  repo.git.setRef('refs/heads/main', commitSha);
  
  console.log(`Server listening on port ${port}`);
  
  const request = (path: string, method: string, headers: any, body?: Buffer): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port, path, method, headers }, (res) => {
        let data = Buffer.alloc(0);
        res.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };

  try {
    // 1. Test v0 info/refs
    const v0Refs = await request('/owner/repo.git/info/refs?service=git-upload-pack', 'GET', {});
    if (!v0Refs.toString().includes('service=git-upload-pack')) throw new Error('v0 info/refs failed');
    console.log('v0 info/refs ok');

    // 2. Test v2 info/refs
    const v2Refs = await request('/owner/repo.git/info/refs?service=git-upload-pack', 'GET', { 'Git-Protocol': 'version=2' });
    if (!v2Refs.toString().includes('version 2')) throw new Error('v2 info/refs failed');
    console.log('v2 info/refs ok');

    // 3. Test v2 ls-refs
    const lsRefsRes = await request('/owner/repo.git/git-upload-pack', 'POST', { 'Git-Protocol': 'version=2' }, Buffer.concat([pktLine('command=ls-refs\n'), Buffer.from('0000')]));
    if (!lsRefsRes.toString().includes('refs/heads/main')) throw new Error('v2 ls-refs failed');
    console.log('v2 ls-refs ok');

    // 4. Test v2 fetch
    const fetchRes = await request('/owner/repo.git/git-upload-pack', 'POST', { 'Git-Protocol': 'version=2' }, Buffer.concat([pktLine('command=fetch\n'), pktLine(`want ${commitSha}\n`), Buffer.from('0000')]));
    if (!fetchRes.toString().includes('acknowledgments')) throw new Error('v2 fetch failed');
    console.log('v2 fetch ok');

    // 5. Test receive-pack (push)
    const newCommitSha = repo.git.write('commit', Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ' + commitSha + '\n\nsecond commit'));
    const cmd = `0000000000000000000000000000000000000000 ${newCommitSha} refs/heads/feature\n`;
    const pushRes = await request('/owner/repo.git/git-receive-pack', 'POST', {}, Buffer.concat([pktLine(cmd), Buffer.from('0000')]));
    if (!pushRes.toString().includes('ok refs/heads/feature')) throw new Error('receive-pack failed');
    console.log('receive-pack ok');

    // 6. Test missing repo 404
    const res404 = await request('/owner/nonexistent.git/info/refs?service=git-upload-pack', 'GET', {});
    if (res404.toString().indexOf('Not Found') === -1) throw new Error('404 check failed');
    console.log('404 check ok');

    // 7. Test v0 upload-pack POST
    const v0FetchRes = await request('/owner/repo.git/git-upload-pack', 'POST', {}, Buffer.concat([pktLine(`want ${commitSha}\n`), Buffer.from('0000')]));
    if (v0FetchRes.toString().indexOf('NAK') === -1) throw new Error('v0 upload-pack POST failed');
    console.log('v0 upload-pack POST ok');

    console.log('All tests passed');
    server.close();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
});
