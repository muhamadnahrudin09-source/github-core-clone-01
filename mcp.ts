// MCP agent surface: POST /mcp — JSON-RPC 2.0, both eras (server/discover 2026-07-28 and the
// legacy initialize handshake). Six github-mcp-server tools driving the same Registry as rest.ts.
import { IncomingMessage, ServerResponse } from 'node:http';
import { registry } from './repos.ts';
import { getTreeFiles, updateTree } from './rest.ts';
import type { RepoRecord } from './repos.ts';
import type { Sha } from './gitcore.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

const toolSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user',
    inputSchema: toolSchema({ name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get metadata for one repository',
    inputSchema: toolSchema({ owner: { type: 'string' }, repo: { type: 'string' } }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: toolSchema({ owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: toolSchema({ owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from head to base',
    inputSchema: toolSchema({ owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request',
    inputSchema: toolSchema({ owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, ['owner', 'repo', 'pull_number']),
  },
];

const text = (s: string): unknown => ({ content: [{ type: 'text', text: s }], isError: false });
const toolError = (s: string): unknown => ({ content: [{ type: 'text', text: s }], isError: true });

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

async function runTool(name: string, a: Record<string, unknown>): Promise<unknown> {
  const owner = typeof a.owner === 'string' ? a.owner : undefined;
  const repoName = typeof a.repo === 'string' ? a.repo : undefined;
  switch (name) {
    case 'create_repo': {
      const n = a.name;
      if (typeof n !== 'string' || n === '') return toolError('missing required argument: name');
      const repo = registry.createRepo(n, typeof a.description === 'string' ? a.description : '', a.private === true);
      return text(JSON.stringify({ id: repo.id, databaseId: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: 'main' }));
    }
    case 'get_repo': {
      if (!owner || !repoName) return toolError('missing required arguments: owner, repo');
      const repo = registry.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return text(JSON.stringify({ id: repo.id, databaseId: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: 'main' }));
    }
    case 'create_issue': {
      if (!owner || !repoName) return toolError('missing required arguments: owner, repo');
      const repo = registry.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      if (typeof a.title !== 'string' || a.title === '') return toolError('missing required argument: title');
      const issue = {
        number: repo.nextNumber++,
        title: a.title,
        body: typeof a.body === 'string' ? a.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as { id: number; body: string; login: string }[],
        createdAt: Date.now(),
      };
      repo.issues.push(issue);
      return text(JSON.stringify({ number: issue.number, id: issue.number * 100 + repo.id, title: issue.title, body: issue.body, state: 'open', repository_url: `${owner}/${repoName}` }));
    }
    case 'list_issues': {
      if (!owner || !repoName) return toolError('missing required arguments: owner, repo');
      const repo = registry.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'open';
      const list = repo.issues
        .filter((i) => (state === 'all' ? true : state === 'closed' ? i.state === 'closed' : i.state === 'open'))
        .map((i) => ({ number: i.number, id: i.number * 100 + repo.id, title: i.title, body: i.body, state: i.state === 'closed' ? 'closed' : 'open' }));
      return text(JSON.stringify(list));
    }
    case 'create_pull_request': {
      if (!owner || !repoName) return toolError('missing required arguments: owner, repo');
      const repo = registry.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      if (typeof a.title !== 'string' || typeof a.head !== 'string' || typeof a.base !== 'string') return toolError('missing required arguments: title, head, base');
      const headRefName = a.head.startsWith('refs/') ? a.head : `refs/heads/${a.head}`;
      const baseRefName = a.base.startsWith('refs/') ? a.base : `refs/heads/${a.base}`;
      const headRef = repo.git.getRef(headRefName);
      const baseRef = repo.git.getRef(baseRefName);
      if (!headRef) return toolError(`head ref ${a.head} missing`);
      if (!baseRef) return toolError(`base ref ${a.base} missing`);
      const pull = {
        number: repo.nextNumber++,
        title: a.title,
        body: typeof a.body === 'string' ? a.body : '',
        state: 'open' as const,
        head: { ref: a.head, sha: headRef },
        base: { ref: a.base, sha: baseRef },
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        baseShaAtOpen: baseRef,
        headFiles: await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(headRef as Sha)!.data).tree),
      };
      repo.pulls.push(pull);
      return text(JSON.stringify({ number: pull.number, title: pull.title, state: 'open', head: { ref: pull.head.ref, sha: pull.head.sha }, base: { ref: pull.base.ref, sha: pull.base.sha }, merged: false }));
    }
    case 'merge_pull_request': {
      if (!owner || !repoName) return toolError('missing required arguments: owner, repo');
      const repo = registry.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const number = num(a.pull_number);
      if (number === null) return toolError('missing required argument: pull_number');
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolError(`pull request #${number} not found`);
      if (pull.merged || pull.state === 'closed') return toolError('pull request is closed or already merged');
      const baseRefName = `refs/heads/${pull.base.ref}`;
      const currentBaseSha = repo.git.getRef(baseRefName);
      if (!currentBaseSha || currentBaseSha !== pull.base.sha) return toolError('pull request is not mergeable');
      let treeSha = repo.git.parseCommit(repo.git.read(pull.base.sha as Sha)!.data).tree;
      const headFiles = await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(pull.head.sha as Sha)!.data).tree);
      for (const f of headFiles) {
        const blobSha = repo.git.write('blob', Buffer.from(f.content));
        treeSha = await updateTree(repo.git, treeSha, f.path.split('/'), blobSha);
      }
      const author = { name: 'Forge', email: 'forge@local', timestamp: Math.floor(Date.now() / 1000), offset: '+0000' };
      const mergeSha = repo.git.write('commit', repo.git.buildCommit({
        tree: treeSha,
        parents: [currentBaseSha],
        author, committer: author, message: `Merge pull request #${pull.number} from ${pull.head.ref}`,
      }));
      repo.git.setRef(baseRefName, mergeSha);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = mergeSha;
      return text(JSON.stringify({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }));
    }
    default:
      return null;
  }
}

function issueJson(repo: RepoRecord, i: { number: number; title: string; body: string; state: string; createdAt: number }): unknown {
  return {
    number: i.number,
    id: i.number * 100 + repo.id,
    title: i.title,
    body: i.body,
    state: i.state === 'closed' ? 'closed' : 'open',
    repository_url: `${repo.owner}/${repo.name}`,
  };
}

async function handleRpc(body: Record<string, unknown>, token: string): Promise<{ status: number; body: unknown }> {
  const method = body.method;
  const id = body.id ?? null;
  const reply = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const jerr = (code: number, message: string, data?: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } } });
  const isNotification = id === null || id === undefined;

  switch (method) {
    case 'server/discover': {
      const meta = (body.params as Record<string, unknown> | undefined)?._meta as Record<string, unknown> | undefined;
      const asked = meta?.['io.modelcontextprotocol/protocolVersion'];
      if (typeof asked === 'string' && !REVISIONS.includes(asked)) {
        return jerr(-32004, `unsupported protocol version ${asked}`, { supported: REVISIONS });
      }
      return reply({
        protocolVersion: REVISIONS[0],
        supportedVersions: REVISIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'initialize': {
      const asked = (body.params as Record<string, unknown> | undefined)?.protocolVersion;
      const chosen = typeof asked === 'string' && REVISIONS.includes(asked) ? asked : '2025-11-25';
      const res = reply({
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions: 'GitHub-compatible forge tools over the local Registry',
      });
      const b = res.body as Record<string, unknown>;
      (b as { result: Record<string, unknown> }).result._meta = { 'io.modelcontextprotocol/protocolVersion': chosen };
      return res;
    }
    case 'notifications/initialized':
      return { status: 202, body: null };
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map((t) => ({ ...t, inputSchema: { ...t.inputSchema } })) });
    case 'tools/call': {
      const params = (body.params ?? {}) as Record<string, unknown>;
      const name = params.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
        return jerr(-32602, `Unknown tool: ${String(name)}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await runTool(name, args);
      if (result === null) return jerr(-32602, `Unknown tool: ${name}`);
      return reply({ content: (result as { content: unknown }).content, isError: (result as { isError: boolean }).isError, structuredContent: result });
    }
    default:
      return jerr(-32601, `Method not found: ${String(method)}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, token: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/mcp') return false;
  const send = (status: number, body: unknown): void => {
    if (body === null) { res.writeHead(status); res.end(); return; }
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  };
  if (req.method !== 'POST') { send(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'POST only' } }); return true; }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }

  const auth = req.headers.authorization;
  const expect = `Bearer ${token}`;
  const notificationOnly = Array.isArray(parsed)
    ? parsed.every((p) => (p as { id?: unknown }).id === undefined)
    : (parsed as { id?: unknown }).id === undefined;
  if (!notificationOnly && auth !== expect) {
    send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } });
    return true;
  }

  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const r = await handleRpc(entry as Record<string, unknown>, token);
      if (r.status !== 202) answers.push(r.body);
    }
    send(200, answers);
    return true;
  }
  const r = await handleRpc(parsed as Record<string, unknown>, token);
  send(r.status, r.body);
  return true;
}
