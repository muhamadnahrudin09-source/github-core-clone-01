import { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry, RepoRecord } from './repos.ts';

export interface OrgRecord {
  id: number;
  login: string;
  node_id: string;
  url: string;
  repos_url: string;
  events_url: string;
  hooks_url: string;
  issues_url: string;
  members_url: string;
  public_members_url: string;
  avatar_url: string;
  description: string;
  name: string;
  company: string;
  blog: string;
  location: string;
  email: string;
  twitter_username: string;
  is_verified: boolean;
  has_organization_projects: boolean;
  has_repository_projects: boolean;
  public_repos: number;
  followers: number;
  following: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  type: string;
  members: Set<string>;
}

export class OrgRegistry {
  orgs: Map<string /* login */, OrgRecord> = new Map();
  nextOrgId: number = 1;

  createOrg(data: { login: string; description?: string; name?: string; company?: string; blog?: string; location?: string; email?: string }): OrgRecord {
    if (!data || !data.login) {
      throw new Error('Login is required');
    }
    const login = data.login;
    if (this.orgs.has(login.toLowerCase())) {
      throw new Error('Organization already exists');
    }
    const id = this.nextOrgId++;
    const now = new Date().toISOString();
    const org: OrgRecord = {
      id,
      login,
      node_id: 'MDEyOk9yZ2FuaXphdGlvbjE=',
      url: `http://localhost/api/v3/orgs/${login}`,
      repos_url: `http://localhost/api/v3/orgs/${login}/repos`,
      events_url: `http://localhost/api/v3/orgs/${login}/events`,
      hooks_url: `http://localhost/api/v3/orgs/${login}/hooks`,
      issues_url: `http://localhost/api/v3/orgs/${login}/issues`,
      members_url: `http://localhost/api/v3/orgs/${login}/members{/member}`,
      public_members_url: `http://localhost/api/v3/orgs/${login}/public_members{/member}`,
      avatar_url: `https://github.com/images/error/${login.toLowerCase()}_happy.gif`,
      description: data.description || '',
      name: data.name || login,
      company: data.company || '',
      blog: data.blog || '',
      location: data.location || '',
      email: data.email || '',
      twitter_username: '',
      is_verified: true,
      has_organization_projects: true,
      has_repository_projects: true,
      public_repos: 0,
      followers: 0,
      following: 0,
      html_url: `http://localhost/${login}`,
      created_at: now,
      updated_at: now,
      type: 'Organization',
      members: new Set()
    };
    this.orgs.set(login.toLowerCase(), org);
    return org;
  }

  findOrg(login: string): OrgRecord | null {
    return this.orgs.get(login.toLowerCase()) || null;
  }

  listOrgs(): OrgRecord[] {
    return Array.from(this.orgs.values());
  }
}

export const orgRegistry = new OrgRegistry();

export async function handleOrgs(
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

  // Expecting: api, v3, orgs, ...
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'orgs') {
    return false;
  }

  const sub = parts.slice(3);
  const method = req.method ?? 'GET';

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
    // GET /api/v3/orgs or POST /api/v3/orgs
    if (sub.length === 0) {
      if (method === 'GET') {
        return send(orgRegistry.listOrgs().map(o => formatOrg(host, o)));
      }
      if (method === 'POST') {
        const body = await getBody();
        if (!body || !body.login) {
          return error('Login is required');
        }
        try {
          const org = orgRegistry.createOrg(body);
          return send(formatOrg(host, org), 201);
        } catch (e: any) {
          return error(e.message || 'Organization already exists');
        }
      }
    }

    if (sub.length >= 1) {
      const orgLogin = sub[0];
      const org = orgRegistry.findOrg(orgLogin);

      if (!org) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
        return true;
      }

      // GET /api/v3/orgs/{org} or PATCH /api/v3/orgs/{org}
      if (sub.length === 1) {
        if (method === 'GET') {
          return send(formatOrg(host, org));
        }
        if (method === 'PATCH') {
          const body = await getBody();
          if (body.description !== undefined) org.description = body.description;
          if (body.name !== undefined) org.name = body.name;
          if (body.company !== undefined) org.company = body.company;
          if (body.blog !== undefined) org.blog = body.blog;
          if (body.location !== undefined) org.location = body.location;
          if (body.email !== undefined) org.email = body.email;
          org.updated_at = new Date().toISOString();
          return send(formatOrg(host, org));
        }
      }

      // GET /api/v3/orgs/{org}/members
      if (sub.length === 2 && sub[1] === 'members') {
        if (method === 'GET') {
          const members = Array.from(org.members).map(m => ({
            login: m,
            id: 1,
            node_id: 'MDQ6VXNlcjE=',
            avatar_url: `https://github.com/images/error/${m}_happy.gif`,
            html_url: `http://${host}/${m}`,
            type: 'User',
            site_admin: false
          }));
          return send(members);
        }
      }

      // PUT/DELETE /api/v3/orgs/{org}/members/{username}
      if (sub.length === 3 && sub[1] === 'members') {
        const username = sub[2];
        if (method === 'PUT') {
          org.members.add(username);
          res.statusCode = 204;
          res.end();
          return true;
        }
        if (method === 'DELETE') {
          org.members.delete(username);
          res.statusCode = 204;
          res.end();
          return true;
        }
      }

      // GET/POST /api/v3/orgs/{org}/repos
      if (sub.length === 2 && sub[1] === 'repos') {
        if (method === 'GET') {
          const orgRepos = repoRegistry.listRepos().filter(r => r.owner && r.owner.toLowerCase() === org.login.toLowerCase());
          return send(orgRepos.map(r => formatRepo(host, r)));
        }
        if (method === 'POST') {
          const body = await getBody();
          if (!body || !body.name) return error('Name is required');
          try {
            const repo = repoRegistry.createRepoWithOwner(org.login, body.name, body.description || '', body.private || false);
            return send(formatRepo(host, repo), 201);
          } catch (e) {
            return error('Repository already exists');
          }
        }
      }
    }

    return false;
  } catch (e: any) {
    if (e instanceof SyntaxError || /Malformed|JSON/.test(e.message || '')) {
      return error('Malformed JSON body', 400);
    }
    return error(e.message || 'Internal Server Error', 500);
  }
}

function formatOrg(host: string, o: OrgRecord) {
  return {
    login: o.login,
    id: o.id,
    node_id: o.node_id,
    url: `http://${host}/api/v3/orgs/${o.login}`,
    repos_url: `http://${host}/api/v3/orgs/${o.login}/repos`,
    events_url: `http://${host}/api/v3/orgs/${o.login}/events`,
    hooks_url: `http://${host}/api/v3/orgs/${o.login}/hooks`,
    issues_url: `http://${host}/api/v3/orgs/${o.login}/issues`,
    members_url: `http://${host}/api/v3/orgs/${o.login}/members{/member}`,
    public_members_url: `http://${host}/api/v3/orgs/${o.login}/public_members{/member}`,
    avatar_url: o.avatar_url,
    description: o.description,
    name: o.name,
    company: o.company,
    blog: o.blog,
    location: o.location,
    email: o.email,
    twitter_username: o.twitter_username,
    is_verified: o.is_verified,
    has_organization_projects: o.has_organization_projects,
    has_repository_projects: o.has_repository_projects,
    public_repos: o.public_repos,
    followers: o.followers,
    following: o.following,
    html_url: `http://${host}/${o.login}`,
    created_at: o.created_at,
    updated_at: o.updated_at,
    type: o.type
  };
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
