import { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry, RepoRecord } from './repos.ts';
import type { OrgRegistry } from './orgs.ts';

export async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  orgRegistry: OrgRegistry,
  repoRegistry: Registry
): Promise<boolean> {
  res.setHeader('content-type', 'application/json');

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // Accept /api/v3/search/... or /search/...
  let sub: string[] = [];
  if (parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'search') {
    sub = parts.slice(3);
  } else if (parts[0] === 'search') {
    sub = parts.slice(1);
  } else {
    return false;
  }

  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    return false;
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

  const q = url.searchParams.get('q');
  if (!q) {
    return error('Validation Failed');
  }

  // Parse query q into tokens and qualifiers
  const tokens: string[] = [];
  const qualifiers: { [key: string]: string } = {};

  const partsQuery = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const p of partsQuery) {
    const clean = p.replace(/^"|"$/g, '');
    const colonIdx = clean.indexOf(':');
    if (colonIdx > 0 && !clean.startsWith('http')) {
      const key = clean.slice(0, colonIdx).toLowerCase();
      const val = clean.slice(colonIdx + 1);
      qualifiers[key] = val;
    } else {
      tokens.push(clean.toLowerCase());
    }
  }

  // GET /search/repositories
  if (sub.length === 1 && sub[0] === 'repositories') {
    const allRepos = repoRegistry.listRepos();
    const matched: RepoRecord[] = [];

    for (const repo of allRepos) {
      let matches = true;

      // Check qualifiers
      if (qualifiers['repo']) {
        const full = `${repo.owner || ''}/${repo.name}`.toLowerCase();
        if (full !== qualifiers['repo'].toLowerCase()) {
          matches = false;
        }
      }
      if (qualifiers['org'] || qualifiers['user']) {
        const target = (qualifiers['org'] || qualifiers['user']).toLowerCase();
        if (!repo.owner || repo.owner.toLowerCase() !== target) {
          matches = false;
        }
      }

      // Check free-form tokens
      if (matches && tokens.length > 0) {
        const nameText = repo.name.toLowerCase();
        const descText = (repo.description || '').toLowerCase();
        for (const t of tokens) {
          if (!nameText.includes(t) && !descText.includes(t)) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        matched.push(repo);
      }
    }

    const items = matched.map(r => formatRepo(host, r));
    return send({
      total_count: items.length,
      incomplete_results: false,
      items
    });
  }

  // GET /search/issues
  if (sub.length === 1 && sub[0] === 'issues') {
    const allRepos = repoRegistry.listRepos();
    const matchedIssues: any[] = [];

    for (const repo of allRepos) {
      if (qualifiers['repo']) {
        const full = `${repo.owner || ''}/${repo.name}`.toLowerCase();
        if (full !== qualifiers['repo'].toLowerCase()) continue;
      }
      if (qualifiers['org'] || qualifiers['user']) {
        const target = (qualifiers['org'] || qualifiers['user']).toLowerCase();
        if (!repo.owner || repo.owner.toLowerCase() !== target) continue;
      }

      for (const issue of repo.issues) {
        let matches = true;
        const titleText = issue.title.toLowerCase();
        const bodyText = (issue.body || '').toLowerCase();

        for (const t of tokens) {
          if (!titleText.includes(t) && !bodyText.includes(t)) {
            matches = false;
            break;
          }
        }

        if (matches) {
          matchedIssues.push(formatIssue(host, repo, issue));
        }
      }
    }

    return send({
      total_count: matchedIssues.length,
      incomplete_results: false,
      items: matchedIssues
    });
  }

  return false;
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
    repository_url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `http://${host}/repos/${repo.owner}/${repo.name}/issues/${i.number}`
  };
}
