import { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry, RepoRecord } from './repos.ts';
import type { Sha } from './gitcore.ts';

let requestIdCounter = 0;

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  registry: Registry,
  token: string
): Promise<boolean> {
  const requestId = `${++requestIdCounter}-${Date.now()}`;
  res.setHeader('x-github-request-id', requestId);
  res.setHeader('content-type', 'application/json');

  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }

  const send = (data: any, code = 200) => {
    res.statusCode = code;
    res.end(JSON.stringify(data));
    return true;
  };

  const error = (msg: string, code = 422) => {
    res.statusCode = code;
    res.end(JSON.stringify({ message: msg }));
    return true;
  };

  const getBody = (): Promise<any> => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Malformed JSON body'));
        }
      });
    });
  };

  try {
    const host = req.headers.host || 'localhost';
    const url = new URL(path, `http://${host}`);
    const parts = url.pathname.split('/').filter(Boolean); // api, v3, ...

    if (parts[0] !== 'api' || parts[1] !== 'v3') return false;

    const sub = parts.slice(2);

    // GET /api/v3/
    if (sub.length === 0 && method === 'GET') {
      res.setHeader('x-oauth-scopes', 'repo, read:org');
      send({ current_user_url: `http://${host}/api/v3/user` });
      return true;
    }

    // GET /api/v3/meta
    if (sub[0] === 'meta' && method === 'GET') {
      send({ installed_version: '1.0.0-forge' });
      return true;
    }

    // /api/v3/user/repos
    if (sub[0] === 'user' && sub[1] === 'repos') {
      if (method === 'GET') {
        const perPage = parseInt(url.searchParams.get('per_page') || '30', 10);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const all = registry.listRepos();
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        if (all.length > start + perPage) {
          const nextUrl = new URL(url.toString());
          nextUrl.searchParams.set('page', (page + 1).toString());
          res.setHeader('link', `<${nextUrl.toString()}>; rel="next"`);
        }
        send(slice.map(r => formatRepo(host, r)));
        return true;
      }
      if (method === 'POST') {
        const body = await getBody();
        if (!body || !body.name) return error('Name is required');
        try {
          const repo = registry.createRepo(body.name, body.description || "", body.private || false);
          send(formatRepo(host, repo), 201);
        } catch (e) {
          return error('Repository already exists');
        }
        return true;
      }
    }

    // /api/v3/repos/{o}/{r}
    if (sub[0] === 'repos' && sub[1] && sub[2]) {
      const owner = sub[1];
      const name = sub[2];
      let repo = registry.findRepo(owner, name);

      // If PUT contents and repo doesn't exist, create it (unborn repo accepted)
      if (!repo && sub[3] === 'contents' && method === 'PUT') {
        try {
          registry.createRepo(name);
          repo = registry.findRepo(owner, name);
        } catch (e) {
          repo = registry.findRepo(owner, name);
        }
      }

      if (!repo) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
        return true;
      }

      if (sub.length === 3) {
        if (method === 'GET') return send(formatRepo(host, repo));
        if (method === 'PATCH') {
          const body = await getBody();
          if (body.description !== undefined) repo.description = body.description;
          if (body.private !== undefined) repo.privateFlag = body.private;
          return send(formatRepo(host, repo));
        }
        if (method === 'DELETE') {
          if (repo.owner !== owner) {
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'Not Found' }));
            return true;
          }
          registry.repos.delete(`${owner}/${name}`);
          registry.pendingRepos.delete(name);
          res.statusCode = 204;
          res.end();
          return true;
        }
      }

      if (sub[3] === 'branches' && method === 'GET') {
        const refs = repo.git.listRefs().filter(r => r.name.startsWith('refs/heads/'));
        return send(refs.map(r => ({ name: r.name.replace('refs/heads/', ''), commit: { sha: r.sha } })));
      }

      if (sub[3] === 'git' && sub[4] === 'refs') {
        if (method === 'POST') {
          const body = await getBody();
          if (!body.ref || !body.sha) return error('Ref and sha required');
          if (repo.git.getRef(body.ref)) return error('Reference already exists');
          repo.git.setRef(body.ref, body.sha);
          return send({ ref: body.ref, object: { sha: body.sha } }, 201);
        }
      }

      if (sub[3] === 'commits' && method === 'GET') {
        const branch = url.searchParams.get('sha') || repo.defaultBranch;
        const refName = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
        let sha = repo.git.getRef(refName) || (branch.length === 40 ? branch : null);
        if (!sha) return send([]);
        const commits = [];
        const seen = new Set<Sha>();
        const stack = [sha];
        while (stack.length) {
          const s = stack.shift()!;
          if (seen.has(s)) continue;
          seen.add(s);
          const obj = repo.git.read(s);
          if (obj && obj.type === 'commit') {
            const parsed = repo.git.parseCommit(obj.data);
            const authorName = parsed.author ? parsed.author.split(' <')[0] : 'Forge';
            commits.push({
              sha: s,
              commit: { message: parsed.message },
              author: { name: authorName },
              html_url: `http://${host}/repos/${owner}/${name}/commit/${s}`
            });
            if (parsed.parents) {
              stack.push(...parsed.parents);
            }
          }
        }
        return send(commits);
      }

      if (sub[3] === 'contents') {
        const pathParts = sub.slice(4);
        const filePath = pathParts.join('/');
        const branch = url.searchParams.get('ref') || url.searchParams.get('branch') || repo.defaultBranch;
        const refName = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
        const tipSha = repo.git.getRef(refName);

        if (method === 'GET') {
          if (!tipSha) return error('Not Found', 404);
          const commitObj = repo.git.read(tipSha);
          if (!commitObj) return error('Not Found', 404);
          const commit = repo.git.parseCommit(commitObj.data);
          const entry = await resolvePath(repo.git, commit.tree, pathParts);
          if (!entry) return error('Not Found', 404);

          if (entry.mode !== '40000') {
            const blob = repo.git.read(entry.sha);
            if (!blob) return error('Not Found', 404);
            return send({
              type: 'file',
              name: entry.name,
              path: filePath,
              sha: entry.sha,
              size: blob.data.length,
              encoding: 'base64',
              content: blob.data.toString('base64'),
              _links: {}
            });
          } else {
            const tree = repo.git.read(entry.sha);
            if (!tree) return error('Not Found', 404);
            const entries = repo.git.parseTree(tree.data);
            return send(entries.map(e => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: filePath ? `${filePath}/${e.name}` : e.name,
              sha: e.sha
            })));
          }
        }

        if (method === 'PUT') {
          const body = await getBody();
          if (!body || typeof body.content !== 'string' || !body.message) {
            return error('Invalid request body');
          }
          const content = Buffer.from(body.content, 'base64');
          const message = body.message;
          const targetBranch = body.branch || repo.defaultBranch;
          const targetRef = targetBranch.startsWith('refs/') ? targetBranch : `refs/heads/${targetBranch}`;
          const currentTip = repo.git.getRef(targetRef);
          let currentTree = '';
          if (currentTip) {
            const c = repo.git.parseCommit(repo.git.read(currentTip)!.data);
            currentTree = c.tree;
          }

          const existingEntry = currentTree && pathParts.length > 0 ? await resolvePath(repo.git, currentTree, pathParts) : null;
          if (body.sha && (!existingEntry || existingEntry.sha !== body.sha)) return error('Conflict: file sha mismatch', 409);
          if (!body.sha && existingEntry) return error('Conflict: file already exists', 409);

          const blobSha = repo.git.write('blob', content);
          const newTreeSha = await updateTree(repo.git, currentTree, pathParts, blobSha);

          const author = { name: 'Forge', email: 'forge@local', timestamp: Math.floor(Date.now()/1000), offset: '+0000' };
          const commitData = repo.git.buildCommit({
            tree: newTreeSha,
            parents: currentTip ? [currentTip] : [],
            author,
            committer: author,
            message
          });
          const commitSha = repo.git.write('commit', commitData);
          repo.git.setRef(targetRef, commitSha);

          const fileName = pathParts[pathParts.length - 1] || '';
          return send({
            content: { name: fileName, path: filePath, sha: blobSha, size: content.length, encoding: 'base64', content: body.content },
            commit: { sha: commitSha, message, author: { name: author.name, email: author.email }, committer: { name: author.name, email: author.email }, html_url: `http://${host}/repos/${owner}/${name}/commit/${commitSha}`, url: `http://${host}/api/v3/repos/${owner}/${name}/git/commits/${commitSha}` }
          }, existingEntry ? 200 : 201);
        }

        if (method === 'DELETE') {
          const body = await getBody();
          const targetBranch = body.branch || repo.defaultBranch;
          const targetRef = targetBranch.startsWith('refs/') ? targetBranch : `refs/heads/${targetBranch}`;
          const currentTip = repo.git.getRef(targetRef);
          if (!currentTip) return error('Not Found', 404);
          const c = repo.git.parseCommit(repo.git.read(currentTip)!.data);
          
          const existingEntry = await resolvePath(repo.git, c.tree, pathParts);
          if (!existingEntry || existingEntry.sha !== body.sha) return error('Conflict', 409);

          const newTreeSha = await updateTree(repo.git, c.tree, pathParts, null);
          const author = { name: 'Forge', email: 'forge@local', timestamp: Math.floor(Date.now()/1000), offset: '+0000' };
          const commitSha = repo.git.write('commit', repo.git.buildCommit({
            tree: newTreeSha,
            parents: [currentTip],
            author, committer: author, message: body.message || 'Delete file'
          }));
          repo.git.setRef(targetRef, commitSha);
          return send({ content: null, commit: { sha: commitSha } });
        }
      }

      if (sub[3] === 'labels') {
        if (method === 'POST') {
          const body = await getBody();
          if (!body || !body.name) return error('Label name required');
          if (repo.labels.find(l => l.name === body.name)) return error('Label already exists');
          const label = { name: body.name, color: body.color || 'ededed' };
          repo.labels.push(label);
          return send(label, 201);
        }
      }

      if (sub[3] === 'issues') {
        if (sub.length === 4) {
          if (method === 'POST') {
            const body = await getBody();
            if (!body || !body.title) return error('Issue title required');
            const labels = body.labels || [];
            for (const l of labels) {
              const labelName = typeof l === 'string' ? l : l.name;
              if (!repo.labels.find(rl => rl.name === labelName)) return error(`Label ${labelName} not found`);
            }
            const issue = {
              number: repo.nextNumber++,
              title: body.title,
              body: body.body || '',
              state: 'open' as const,
              labels: labels.map((l: any) => typeof l === 'string' ? l : l.name),
              comments: [],
              createdAt: Date.now()
            };
            repo.issues.push(issue);
            return send(formatIssue(host, repo, issue), 201);
          }
          if (method === 'GET') {
            const state = url.searchParams.get('state') || 'open';
            const sort = url.searchParams.get('sort') || 'created';
            const direction = url.searchParams.get('direction') || 'desc';
            let list = repo.issues.filter(i => state === 'all' || i.state === state);
            list.sort((a, b) => {
              const res = a.createdAt - b.createdAt;
              return direction === 'desc' ? -res : res;
            });
            return send(list.map(i => formatIssue(host, repo, i)));
          }
        } else {
          const num = parseInt(sub[4], 10);
          const issue = repo.issues.find(i => i.number === num);
          if (!issue) return error('Not Found', 404);

          if (sub.length === 5) {
            if (method === 'GET') return send(formatIssue(host, repo, issue));
            if (method === 'PATCH') {
              const body = await getBody();
              if (body && body.state) issue.state = body.state;
              return send(formatIssue(host, repo, issue));
            }
          }
          if (sub[5] === 'comments') {
            if (method === 'POST') {
              const body = await getBody();
              if (!body || !body.body) return error('Comment body required');
              const comment = { id: registry.nextCommentId++, body: body.body, login: token };
              issue.comments.push(comment);
              return send({ id: comment.id, body: comment.body, user: { login: token } }, 201);
            }
            if (method === 'GET') {
              return send(issue.comments.map(c => ({ id: c.id, body: c.body, user: { login: c.login } })));
            }
          }
        }
      }

      if (sub[3] === 'pulls') {
        if (sub.length === 4) {
          if (method === 'POST') {
            const body = await getBody();
            if (!body || !body.head || !body.base || !body.title) return error('Title, head, and base required');
            const headRefName = body.head.startsWith('refs/') ? body.head : `refs/heads/${body.head}`;
            const baseRefName = body.base.startsWith('refs/') ? body.base : `refs/heads/${body.base}`;
            const headRef = repo.git.getRef(headRefName);
            const baseRef = repo.git.getRef(baseRefName);
            if (!headRef) return error('Head ref missing');
            if (!baseRef) return error('Base ref missing');

            const baseCommit = repo.git.parseCommit(repo.git.read(baseRef)!.data);

            const pull = {
              number: repo.nextNumber++,
              title: body.title,
              body: body.body || '',
              state: 'open' as const,
              head: { ref: body.head, sha: headRef },
              base: { ref: body.base, sha: baseRef },
              merged: false,
              mergedAt: null,
              mergeCommitSha: null,
              baseShaAtOpen: baseCommit.tree,
              headFiles: await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(headRef)!.data).tree)
            };
            repo.pulls.push(pull);
            return send(formatPull(host, repo, pull), 201);
          }
          if (method === 'GET') {
            const state = url.searchParams.get('state') || 'open';
            const list = repo.pulls.filter(p => {
              if (state === 'all') return true;
              if (state === 'closed') return p.state === 'closed' || p.merged;
              return p.state === state && !p.merged;
            });
            return send(list.map(p => formatPull(host, repo, p)));
          }
        } else {
          const num = parseInt(sub[4], 10);
          const pull = repo.pulls.find(p => p.number === num);
          if (!pull) return error('Not Found', 404);

          if (sub.length === 5) {
            if (method === 'GET') return send(formatPull(host, repo, pull));
          }
          if (sub[5] === 'files' && method === 'GET') {
            const headFiles = await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(pull.head.sha)!.data).tree);
            const baseFiles = await getTreeFiles(repo.git, pull.baseShaAtOpen);
            const allPaths = Array.from(new Set([...headFiles.map(f => f.path), ...baseFiles.map(f => f.path)]));
            const result = [];
            for (const p of allPaths) {
              const h = headFiles.find(f => f.path === p);
              const b = baseFiles.find(f => f.path === p);
              if (h && b && h.content === b.content) continue;
              const status = !b ? 'added' : 'modified';
              const hLines = h ? h.content.split('\n') : [];
              const bLines = b ? b.content.split('\n') : [];
              let additions = 0, deletions = 0;
              if (!b) {
                additions = hLines.length || 1;
              } else {
                additions = Math.max(1, hLines.length);
                deletions = Math.max(0, bLines.length);
              }
              result.push({ filename: p, status, additions, deletions, changes: additions + deletions });
            }
            return send(result);
          }
          if (sub[5] === 'merge' && method === 'PUT') {
            if (pull.merged || pull.state === 'closed') return error('Pull Request is closed or merged', 405);
            const baseRefName = `refs/heads/${pull.base.ref}`;
            const currentBaseSha = repo.git.getRef(baseRefName);
            if (currentBaseSha !== pull.base.sha) return error('Pull Request is not mergeable', 405);

            let treeSha = pull.baseShaAtOpen;
            const headFiles = await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(pull.head.sha)!.data).tree);
            for (const f of headFiles) {
              const blobSha = repo.git.write('blob', Buffer.from(f.content));
              treeSha = await updateTree(repo.git, treeSha, f.path.split('/'), blobSha);
            }

            const author = { name: 'Forge', email: 'forge@local', timestamp: Math.floor(Date.now()/1000), offset: '+0000' };
            const mergeSha = repo.git.write('commit', repo.git.buildCommit({
              tree: treeSha,
              parents: [currentBaseSha!],
              author, committer: author, message: `Merge pull request #${pull.number} from ${pull.head.ref}`
            }));
            repo.git.setRef(baseRefName, mergeSha);
            pull.merged = true;
            pull.state = 'closed';
            pull.mergedAt = new Date().toISOString();
            pull.mergeCommitSha = mergeSha;
            return send({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
          }
        }
      }
    }

    error('Not Found', 404);
    return true;
  } catch (e: any) {
    console.error(e);
    error(e.message || 'Internal Server Error', 500);
    return true;
  }
}

function formatRepo(host: string, r: RepoRecord) {
  return {
    id: 1,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner },
    private: r.privateFlag,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: new Date(r.createdAt).toISOString(),
    html_url: `http://${host}/${r.owner}/${r.name}`
  };
}

function formatIssue(host: string, repo: RepoRecord, i: any) {
  return {
    id: i.number,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l: string) => ({ name: l })),
    user: { login: repo.owner },
    created_at: new Date(i.createdAt).toISOString(),
    comments: i.comments.length,
    html_url: `http://${host}/repos/${repo.owner}/${repo.name}/issues/${i.number}`
  };
}

function formatPull(host: string, repo: RepoRecord, p: any) {
  return {
    id: p.number,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    head: { ref: p.head.ref, sha: p.head.sha },
    base: { ref: p.base.ref, sha: p.base.sha },
    merged: p.merged,
    merged_at: p.mergedAt,
    mergeable: true,
    html_url: `http://${host}/repos/${repo.owner}/${repo.name}/pull/${p.number}`
  };
}

async function resolvePath(git: any, treeSha: Sha, parts: string[]): Promise<any> {
  let currentTreeSha = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const obj = git.read(currentTreeSha);
    if (!obj || obj.type !== 'tree') return null;
    const entries = git.parseTree(obj.data);
    const entry = entries.find((e: any) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    currentTreeSha = entry.sha;
  }
  return { mode: '40000', name: '', sha: treeSha };
}

async function updateTree(git: any, treeSha: Sha, parts: string[], blobSha: Sha | null): Promise<Sha> {
  if (parts.length === 0) return blobSha || '';

  const entries = treeSha ? git.parseTree(git.read(treeSha)!.data) : [];
  const name = parts[0];

  if (parts.length === 1) {
    const filtered = entries.filter((e: any) => e.name !== name);
    if (blobSha) {
      filtered.push({ mode: '100644', name, sha: blobSha });
    }
    return git.write('tree', git.buildTree(filtered));
  } else {
    const existing = entries.find((e: any) => e.name === name);
    const subTreeSha = existing && existing.mode === '40000' ? existing.sha : '';
    const newSubTreeSha = await updateTree(git, subTreeSha, parts.slice(1), blobSha);
    
    const filtered = entries.filter((e: any) => e.name !== name);
    if (newSubTreeSha) {
      filtered.push({ mode: '40000', name, sha: newSubTreeSha });
    }
    return git.write('tree', git.buildTree(filtered));
  }
}

async function getTreeFiles(git: any, treeSha: Sha, prefix = ''): Promise<{ path: string, content: string }[]> {
  if (!treeSha) return [];
  const obj = git.read(treeSha);
  if (!obj || obj.type !== 'tree') return [];
  const entries = git.parseTree(obj.data);
  let files: { path: string, content: string }[] = [];
  for (const e of entries) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      files = files.concat(await getTreeFiles(git, e.sha, p));
    } else {
      const blob = git.read(e.sha);
      files.push({ path: p, content: blob ? blob.data.toString() : '' });
    }
  }
  return files;
}
