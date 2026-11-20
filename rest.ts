import { IncomingMessage, ServerResponse } from 'node:http';
import { Registry } from './repos.ts';
import { sendJson } from './http-utils.ts';
import { Store, type Sha, type GitObjectType } from './gitcore.ts';

function getPathContent(store: Store, treeSha: Sha, path: string): {mode: string, name: string, sha: Sha} | null {
  const parts = path.split('/').filter(p => p !== '');
  let currentTreeSha = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const obj = store.read(currentTreeSha);
    if (!obj || obj.type !== 'tree') return null;
    const entries = store.parseTree(obj.data);
    const entry = entries.find(e => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry;
    if (entry.mode !== '40000') return null; 
    currentTreeSha = entry.sha;
  }
  return { mode: '40000', name: '', sha: treeSha };
}

function updateTree(store: Store, treeSha: Sha, path: string, content: Buffer | null, mode: string = '100644'): Sha {
  const parts = path.split('/').filter(p => p !== '');
  if (parts.length === 0) throw new Error('Cannot update tree root');
  
  const part = parts[0];
  const obj = store.read(treeSha);
  if (!obj || obj.type !== 'tree') throw new Error('Not a tree');
  
  const entries = store.parseTree(obj.data);
  let entry = entries.find(e => e.name === part);
  
  if (parts.length === 1) {
    if (content === null) {
      if (!entry) throw new Error('File not found');
      const newEntries = entries.filter(e => e.name !== part);
      return store.write('tree', store.buildTree(newEntries));
    } else {
      const blobSha = store.write('blob', content);
      if (entry) {
        entry.sha = blobSha;
        entry.mode = mode;
      } else {
        entries.push({ name: part, sha: blobSha, mode: mode });
      }
      return store.write('tree', store.buildTree(entries));
    }
  } else {
    if (!entry || entry.mode !== '40000') {
        const newSubTree = store.write('tree', store.buildTree([]));
        entry = { name: part, sha: newSubTree, mode: '40000' };
        entries.push(entry);
    }
    const newSubTreeSha = updateTree(store, entry.sha, parts.slice(1).join('/'), content, mode);
    entry.sha = newSubTreeSha;
    return store.write('tree', store.buildTree(entries));
  }
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string, registry: Registry): Promise<boolean> {
  console.log('handleRest path:', path);
  const url = new URL(req.url!, 'http://entry');
  
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: 'http://api.github.com/user',
        current_user_authorizations_html_url: 'http://github.com/settings/connections/applications{/client_id}',
        authorizations_url: 'http://api.github.com/authorizations',
        code_search_url: 'http://api.github.com/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: 'http://api.github.com/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: 'http://api.github.com/user/emails',
        emojis_url: 'http://api.github.com/emojis',
        events_url: 'http://api.github.com/events',
        feeds_url: 'http://api.github.com/feeds',
        followers_url: 'http://api.github.com/user/followers',
        following_url: 'http://api.github.com/user/following{/target}',
        gists_url: 'http://api.github.com/gists{/gist_id}',
        hub_url: 'http://api.github.com/hub',
        issue_search_url: 'http://api.github.com/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: 'http://api.github.com/issues',
        keys_url: 'http://api.github.com/user/keys',
        notifications_url: 'http://api.github.com/notifications',
        organization_repositories_url: 'http://api.github.com/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_url: 'http://api.github.com/orgs/{org}',
        public_gists_url: 'http://api.github.com/gists/public',
        rate_limit_url: 'http://api.github.com/rate_limit',
        repository_url: 'http://api.github.com/repos/{owner}/{repo}',
        repository_search_url: 'http://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: 'http://api.github.com/user/repos{?type,page,per_page,sort}',
        starred_url: 'http://api.github.com/gists/starred',
        topics_url: 'http://api.github.com/topics/{topic}',
        user_url: 'http://api.github.com/user',
        user_organizations_url: 'http://api.github.com/user/orgs',
        user_repositories_url: 'http://api.github.com/user/repos{?type,page,per_page,sort}',
        user_search_url: 'http://api.github.com/search/users?q={query}{&page,per_page,sort,order}'
      }, {
        'X-OAuth-Scopes': 'repo,user'
      });
      return true;
    }
  }

  if (path === '/api/v3/meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }
  }

  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const perPage = parseInt(url.searchParams.get('per_page') ?? '30');
      const page = parseInt(url.searchParams.get('page') ?? '1');
      const allRepos = Array.from(registry.repos.values());
      const start = (page - 1) * perPage;
      const paginatedRepos = allRepos.slice(start, start + perPage);
      
      const linkHeaders: string[] = [];
      if (allRepos.length > start + perPage) {
        linkHeaders.push(`<http://api.github.com/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`);
      }
      
      sendJson(res, 200, paginatedRepos.map(r => ({ name: r.name, full_name: `${r.owner}/${r.name}`, private: r.privateFlag, default_branch: 'main' })), {
        'Link': linkHeaders.join(', ')
      });
      return true;
    }
    if (method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        if (!data.name) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
          return true;
        }
        const repo = registry.createRepo('user', data.name);
        repo.privateFlag = !!data.private;
        sendJson(res, 201, { name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.privateFlag, default_branch: repo.defaultBranch });
      } catch (e) {
        sendJson(res, 400, { message: 'Invalid JSON' });
      }
      return true;
    }
  }

  const reposMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
  if (reposMatch) {
    const [_, owner, repoName] = reposMatch;
    const repoRecord = registry.repos.get(`${owner}/${repoName}`);
    if (!repoRecord) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    
    if (method === 'GET') {
      sendJson(res, 200, {
        name: repoRecord.name,
        full_name: `${repoRecord.owner}/${repoRecord.name}`,
        private: repoRecord.privateFlag,
        default_branch: repoRecord.defaultBranch,
        description: repoRecord.description
      });
      return true;
    }
    if (method === 'PATCH') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        if (data.description !== undefined) repoRecord.description = data.description;
        sendJson(res, 200, {
          name: repoRecord.name,
          full_name: `${repoRecord.owner}/${repoRecord.name}`,
          private: repoRecord.privateFlag,
          default_branch: repoRecord.defaultBranch,
          description: repoRecord.description
        });
      } catch (e) {
        sendJson(res, 400, { message: 'Invalid JSON' });
      }
      return true;
    }
    if (method === 'DELETE') {
      registry.repos.delete(`${owner}/${repoName}`);
      res.writeHead(204);
      res.end();
      return true;
    }
  }
  
  const contentsMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/);
  if (contentsMatch) {
    const [_, owner, repoName, filePath] = contentsMatch;
    const repoRecord = registry.repos.get(`${owner}/${repoName}`);
    if (!repoRecord) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    
    const branch = url.searchParams.get('ref') ?? repoRecord.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const headSha = repoRecord.git.getRef(branchRef);
    if (!headSha) {
      sendJson(res, 404, { message: 'Branch not found' });
      return true;
    }
    const commitObj = repoRecord.git.parseCommit(repoRecord.git.read(headSha)!.data);
    
    if (method === 'GET') {
      const entry = getPathContent(repoRecord.git, commitObj.tree, filePath || '');
      if (!entry) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      
      const obj = repoRecord.git.read(entry.sha);
      if (obj?.type === 'tree') {
        const entries = repoRecord.git.parseTree(obj.data);
        sendJson(res, 200, entries.map(e => ({ name: e.name, path: filePath ? `${filePath}/${e.name}` : e.name, sha: e.sha, size: 0, type: e.mode === '40000' ? 'dir' : 'file' })));
      } else if (obj?.type === 'blob') {
        sendJson(res, 200, { encoding: 'base64', content: obj.data.toString('base64'), sha: entry.sha, size: obj.data.length });
      } else {
        sendJson(res, 404, { message: 'Not Found' });
      }
      return true;
    }
    
    if (method === 'PUT' || method === 'DELETE') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || '{}');
      
      const entry = getPathContent(repoRecord.git, commitObj.tree, filePath || '');
      if (method === 'PUT' && data.sha && entry && entry.sha !== data.sha) {
        sendJson(res, 409, { message: 'Stale SHA' });
        return true;
      }
      if (method === 'DELETE' && !entry) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'DELETE' && data.sha && entry && entry.sha !== data.sha) {
        sendJson(res, 409, { message: 'Stale SHA' });
        return true;
      }
      
      try {
        const content = method === 'PUT' ? Buffer.from(data.content, 'base64') : null;
        const newTreeSha = updateTree(repoRecord.git, commitObj.tree, filePath || '', content);
        
        const commit = repoRecord.git.write('commit', repoRecord.git.buildCommit({
          tree: newTreeSha,
          parents: [headSha],
          author: { name: 'User', email: 'user@example.com', timestamp: Date.now(), offset: 0 },
          committer: { name: 'User', email: 'user@example.com', timestamp: Date.now(), offset: 0 },
          message: data.message
        }));
        
        repoRecord.git.setRef(branchRef, commit);
        
        if (method === 'PUT') {
          const newEntry = getPathContent(repoRecord.git, newTreeSha, filePath || '');
          sendJson(res, 201, { content: { sha: newEntry?.sha, encoding: 'base64' }, commit: { sha: commit } });
        } else {
          sendJson(res, 200, { commit: { sha: commit } });
        }
      } catch (e: any) {
        sendJson(res, 400, { message: e.message });
      }
      return true;
    }
    
    return true;
  }
  return false;
}
