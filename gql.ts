// GraphQL v4 surface: POST /api/graphql. A small executor for the document subset gh and
// github-mcp-server send (see checks-graphql.ts). Mutates the same Registry records as rest.ts.
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { registry, type RepoRecord } from './repos.ts';
import { getTreeFiles, updateTree } from './rest.ts';
import type { Sha } from './gitcore.ts';

const VIEWER_FALLBACK = 'adaiversen'; // deterministic scenario viewer (constant seed)

// ---------------------------------------------------------------- global ids

let dbCounter = 0;
const dbIdOf = (repo: RepoRecord): number => {
  const r = repo as RepoRecord & { dbId?: number };
  if (r.dbId === undefined) r.dbId = ++dbCounter;
  return r.dbId;
};
const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const dec = (s: string): string => Buffer.from(s, 'base64').toString('utf8');
const repoGid = (repo: RepoRecord) => enc(`Repository:${dbIdOf(repo)}`);
const issueGid = (repo: RepoRecord, n: number) => enc(`Issue:${dbIdOf(repo)}:${n}`);
const pullGid = (repo: RepoRecord, n: number) => enc(`PullRequest:${dbIdOf(repo)}:${n}`);
const commentGid = (repo: RepoRecord, n: number, cid: number) => enc(`IssueComment:${dbIdOf(repo)}:${n}:${cid}`);

function repoByDbId(id: number): RepoRecord | null {
  return registry.listRepos().find((r) => dbIdOf(r) === id) ?? null;
}

function decodeGid(gid: unknown): { kind: string; repo: RepoRecord | null; n?: number; cid?: number } | null {
  if (typeof gid !== 'string' || gid === '') return null;
  let raw: string;
  try { raw = dec(gid); } catch { return null; }
  const [kind, idStr, nStr, cidStr] = raw.split(':');
  if (!kind || idStr === undefined) return null;
  return {
    kind,
    repo: repoByDbId(Number(idStr)),
    n: nStr !== undefined ? Number(nStr) : undefined,
    cid: cidStr !== undefined ? Number(cidStr) : undefined,
  };
}

// ---------------------------------------------------------------- parser

interface Field { alias: string | null; name: string; args: Record<string, unknown>; selection: Field[] }
interface Operation { type: 'query' | 'mutation'; name: string | null; vars: Record<string, string | null>; selection: Field[] }

class ParseError extends Error {}

const ENUM = Symbol('enum');
function parseDocument(text: string, provided: Readonly<Record<string, unknown>> = {}): Operation[] {
  const ops: Operation[] = [];
  let i = 0;
  const skipWs = (): void => { while (i < text.length && /[\s,]/.test(text[i]!)) i++; };
  const readName = (): string => {
    skipWs();
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i));
    if (!m) throw new ParseError(`expected a name at offset ${i}`);
    i += m[0].length;
    return m[0];
  };
  const readValue = (vars: Record<string, string | null>): unknown => {
    skipWs();
    const c = text[i];
    if (c === '$') { i++; const name = readName(); if (!(name in vars)) throw new ParseError(`undefined variable $${name}`); return vars[name]!; }
    if (c === '"') {
      i++;
      let out = '';
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { i++; out += text[i] === 'n' ? '\n' : text[i]!; i++; }
        else out += text[i++]!;
      }
      if (text[i] !== '"') throw new ParseError('unterminated string');
      i++;
      return out;
    }
    if (c === '[') {
      i++;
      const list: unknown[] = [];
      for (;;) {
        skipWs();
        if (text[i] === ']') { i++; return list; }
        if (i >= text.length) throw new ParseError('unterminated list');
        list.push(readValue(vars));
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        skipWs();
        if (text[i] === '}') { i++; return obj; }
        if (i >= text.length) throw new ParseError('unterminated input object');
        const key = readName();
        skipWs();
        if (text[i] !== ':') throw new ParseError(`expected : after input field ${key}`);
        i++;
        obj[key] = readValue(vars);
      }
    }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    return { [ENUM]: readName() }; // bareword: an enum value
  };
  const isTrue = (v: unknown): boolean => v === true || (typeof v === 'object' && v !== null && (v as Record<string, unknown>)[ENUM] === 'true');
  const readArguments = (vars: Record<string, string | null>): Record<string, unknown> => {
    skipWs();
    if (text[i] !== '(') return {};
    i++;
    const args: Record<string, unknown> = {};
    for (;;) {
      skipWs();
      if (text[i] === ')') { i++; return args; }
      if (i >= text.length) throw new ParseError('unterminated arguments');
      const name = readName();
      skipWs();
      if (text[i] !== ':') throw new ParseError('expected : in arguments');
      i++;
      let v = readValue(vars);
      skipWs();
      while (text[i] === '@') { // directives: only @include/@skip(if:) matter
        i++;
        const dname = readName();
        const dargs = readArguments(vars);
        const cond = dargs.if === undefined ? true : isTrue(dargs.if);
        if ((dname === 'skip' && cond) || (dname === 'include' && !cond)) v = undefined;
        skipWs();
      }
      if (v !== undefined) args[name] = v;
    }
  };
  const readSelectionSet = (vars: Record<string, string | null>): Field[] => {
    skipWs();
    if (text[i] !== '{') throw new ParseError('expected {');
    i++;
    const fields: Field[] = [];
    for (;;) {
      skipWs();
      if (text[i] === '}') { i++; return fields; }
      if (i >= text.length) throw new ParseError('unterminated selection set');
      if (text.startsWith('...', i)) {
        i += 3;
        skipWs();
        if (text.startsWith('on ', i)) { i += 3; readName(); }
        fields.push(...readSelectionSet(vars));
        continue;
      }
      const first = readName();
      skipWs();
      let alias: string | null = null;
      let name = first;
      if (text[i] === ':') { i++; alias = first; name = readName(); skipWs(); }
      const args = readArguments(vars);
      skipWs();
      let selection: Field[] = [];
      if (text[i] === '{') selection = readSelectionSet(vars);
      fields.push({ alias, name, args, selection });
    }
  };
  const readOperation = (): Operation => {
    skipWs();
    if (text[i] === '{') return { type: 'query', name: null, vars: { ...provided }, selection: readSelectionSet({ ...provided }) };
    let type: 'query' | 'mutation' = 'query';
    if (text.startsWith('mutation', i)) { type = 'mutation'; i += 8; }
    else if (text.startsWith('query', i)) { i += 5; }
    skipWs();
    let name: string | null = null;
    if (text[i] !== undefined && /[_A-Za-z]/.test(text[i]!)) name = readName();
    skipWs();
    const vars: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(provided)) vars[k] = v as string | null;
    if (text[i] === '(') {
      i++;
      for (;;) {
        skipWs();
        if (text[i] === ')') { i++; break; }
        if (i >= text.length) throw new ParseError('unterminated variable definitions');
        if (text[i] !== '$') throw new ParseError('expected $ in variable definitions');
        i++;
        const vname = readName();
        skipWs();
        if (text[i] !== ':') throw new ParseError('expected : in variable definition');
        i++;
        skipWs();
        readName(); // named type
        skipWs();
        if (text[i] === '!') i++;
        skipWs();
        if (text[i] === '[') { // list type, e.g. [IssueState!]
          i++;
          for (;;) {
            skipWs();
            if (text[i] === ']') { i++; break; }
            readName(); skipWs();
            if (text[i] === '!') i++; skipWs();
          }
          skipWs();
          if (text[i] === '!') i++;
          skipWs();
        }
        if (text[i] === '=') {
          i++;
          vars[vname] = readValue(vars) as string | null;
        } else if (!(vname in vars)) {
          vars[vname] = null;
        }
      }
    }
    const selection = readSelectionSet(vars);
    return { type, name, vars, selection };
  };
  for (;;) {
    skipWs();
    if (i >= text.length) break;
    if (text.startsWith('fragment', i)) {
      i += 8;
      readName(); skipWs();
      if (text.startsWith('on ', i)) { i += 3; readName(); }
      readSelectionSet({});
      continue;
    }
    ops.push(readOperation());
  }
  return ops;
}

export const __parse = parseDocument;

// ---------------------------------------------------------------- executor

const sub = (fields: Field[], name: string): Field[] => (fields.find((x) => x.name === name)?.selection) ?? [];

class Exec {
  errors: { message: string }[] = [];
  vars: Record<string, unknown>;
  owner: string;
  constructor(vars: Record<string, unknown>, owner: string) { this.vars = vars; this.owner = owner; }

  cant(field: string, typeName: string): null {
    this.errors.push({ message: `Cannot query field "${field}" on type "${typeName}"` });
    return null;
  }

  /** Build one object from a selection set against a resolver map (resolvers may be async). */
  async object(fields: Field[], typeName: string, resolvers: Record<string, () => unknown | Promise<unknown>>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const key = f.alias ?? f.name;
      const r = resolvers[f.name];
      if (r === undefined) {
        this.cant(f.name, typeName);
        out[key] = null;
        continue;
      }
      out[key] = await r();
    }
    return out;
  }

  pageInfoObject(fields: Field[], hasNextPage: boolean, endCursor: string): Promise<Record<string, unknown>> {
    return this.object(fields, 'PageInfo', { hasNextPage: () => hasNextPage, endCursor: () => endCursor, hasPreviousPage: () => false, startCursor: () => null });
  }

  async issueObject(repo: RepoRecord, issue: any, fields: Field[]): Promise<Record<string, unknown>> {
    return this.object(fields, 'Issue', {
      id: () => issueGid(repo, issue.number),
      number: () => issue.number,
      title: () => issue.title,
      state: () => (issue.state === 'open' ? 'OPEN' : 'CLOSED'),
      body: () => issue.body,
      createdAt: () => new Date(issue.createdAt).toISOString(),
      comments: () => this.commentConnection(repo, issue, sub(fields, 'comments')),
    });
  }

  commentConnection(repo: RepoRecord, issue: any, sel: Field[]): Promise<Record<string, unknown>> {
    const nodesSel = sub(sel, 'nodes');
    const first = 100;
    return this.object(sel, 'IssueCommentsConnection', {
      nodes: () => Promise.all(issue.comments.slice(0, first).map(async (c: any) => this.commentObject(repo, issue.number, c, nodesSel))),
      totalCount: () => issue.comments.length,
      pageInfo: () => this.pageInfoObject(sub(sel, 'pageInfo'), false, ''),
    });
  }

  commentObject(repo: RepoRecord, issueNumber: number, c: any, fields: Field[]): Promise<Record<string, unknown>> {
    return this.object(fields, 'IssueComment', {
      id: () => commentGid(repo, issueNumber, c.id),
      body: () => c.body,
      author: () => this.object(sub(fields, 'author'), 'User', { login: () => c.login }),
      createdAt: () => new Date().toISOString(),
    });
  }

  async issueConnection(repo: RepoRecord, f: Field): Promise<Record<string, unknown>> {
    const first = f.args.first !== undefined ? Number(f.args.first) : 30;
    const states = Array.isArray(f.args.states)
      ? (f.args.states as Array<Record<string, unknown>>).map((s) => String((s as Record<string, unknown>)[ENUM] ?? s))
      : null;
    let list = repo.issues.filter((i) => (states ? states.includes(i.state.toUpperCase()) : true));
    const order = (f.args.orderBy ?? {}) as Record<string, unknown>;
    const field = typeof order.field === 'object' && order.field !== null ? String((order.field as Record<string, unknown>)[ENUM]) : 'CREATED_AT';
    const direction = typeof order.direction === 'object' && order.direction !== null ? String((order.direction as Record<string, unknown>)[ENUM]) : 'ASC';
    list = [...list].sort((a, b) => {
      let res: number;
      if (field === 'COMMENTS') res = a.comments.length - b.comments.length;
      else if (field === 'UPDATED_AT') res = (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt);
      else res = a.createdAt - b.createdAt;
      if (res === 0) res = a.number - b.number;
      return direction === 'DESC' ? -res : res;
    });
    let offset = 0;
    const after = f.args.after;
    if (typeof after === 'string' && after !== '') {
      try {
        const raw = dec(after);
        if (raw.startsWith('cursor:')) offset = Math.max(0, Number(raw.slice(7)));
      } catch { /* opaque garbage: start over */ }
    }
    const page = list.slice(offset, offset + first);
    const hasNextPage = offset + page.length < list.length;
    const endCursor = enc(`cursor:${offset + page.length}`);
    return this.object(f.selection, 'IssueConnection', {
      nodes: () => Promise.all(page.map(async (i) => this.issueObject(repo, i, sub(f.selection, 'nodes')))),
      totalCount: () => list.length,
      pageInfo: () => this.pageInfoObject(sub(f.selection, 'pageInfo'), hasNextPage, endCursor),
    });
  }

  async pullObject(repo: RepoRecord, pull: any, fields: Field[]): Promise<Record<string, unknown>> {
    const state = pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
    let filesConnection: Promise<Record<string, unknown>> | null = null;
    const filesField = fields.find((x) => x.name === 'files');
    if (filesField) {
      filesConnection = (async () => {
        const baseFiles = await getTreeFiles(repo.git, pull.baseShaAtOpen);
        const headFiles = await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(pull.head.sha as Sha)!.data).tree);
        const baseMap = new Map(baseFiles.map((x) => [x.path, x.content]));
        const headMap = new Map(headFiles.map((x) => [x.path, x.content]));
        const changed: string[] = [];
        for (const [p, content] of headMap) if (!baseMap.has(p) || baseMap.get(p) !== content) changed.push(p);
        for (const p of baseMap.keys()) if (!headMap.has(p)) changed.push(p);
        const nodesSel = sub(filesField.selection, 'nodes');
        return this.object(filesField.selection, 'PullRequestFilesConnection', {
          nodes: () => Promise.all(changed.map(async (path) => this.object(nodesSel, 'PullRequestChangedFile', { path: () => path }))),
          totalCount: () => changed.length,
          pageInfo: () => this.pageInfoObject(sub(filesField.selection, 'pageInfo'), false, ''),
        });
      })();
    }
    return this.object(fields, 'PullRequest', {
      id: () => pullGid(repo, pull.number),
      number: () => pull.number,
      title: () => pull.title,
      state: () => state,
      merged: () => pull.merged === true,
      headRefName: () => pull.head.ref,
      baseRefName: () => pull.base.ref,
      mergeable: () => 'MERGEABLE',
      body: () => pull.body,
      files: () => filesConnection,
      additions: () => 0,
      deletions: () => 0,
    });
  }

  async pullConnection(repo: RepoRecord, f: Field): Promise<Record<string, unknown>> {
    const first = f.args.first !== undefined ? Number(f.args.first) : 30;
    const list = repo.pulls.filter((p) => p.state === 'open' && !p.merged).slice(0, first);
    return this.object(f.selection, 'PullRequestConnection', {
      nodes: () => Promise.all(list.map(async (p) => this.pullObject(repo, p, sub(f.selection, 'nodes')))),
      totalCount: () => list.length,
      pageInfo: () => this.pageInfoObject(sub(f.selection, 'pageInfo'), false, ''),
    });
  }

  async repoObject(repo: RepoRecord, fields: Field[]): Promise<Record<string, unknown>> {
    return this.object(fields, 'Repository', {
      id: () => repoGid(repo),
      databaseId: () => dbIdOf(repo),
      name: () => repo.name,
      nameWithOwner: () => `${repo.owner ?? this.owner}/${repo.name}`,
      owner: () => this.object(sub(fields, 'owner'), 'User', { login: () => repo.owner ?? this.owner }),
      defaultBranchRef: () => this.object(sub(fields, 'defaultBranchRef'), 'Ref', { name: () => repo.defaultBranch }),
      viewerPermission: () => 'ADMIN',
      hasIssuesEnabled: () => true,
      isPrivate: () => repo.privateFlag,
      description: () => repo.description,
      issue: () => {
        const sf = fields.find((x) => x.name === 'issue')!;
        const issue = repo.issues.find((i) => i.number === Number(sf.args.number));
        return issue ? this.issueObject(repo, issue, sf.selection) : null;
      },
      issues: () => this.issueConnection(repo, fields.find((x) => x.name === 'issues')!),
      pullRequest: () => {
        const sf = fields.find((x) => x.name === 'pullRequest')!;
        const pull = repo.pulls.find((p) => p.number === Number(sf.args.number));
        return pull ? this.pullObject(repo, pull, sf.selection) : null;
      },
      pullRequests: () => this.pullConnection(repo, fields.find((x) => x.name === 'pullRequests')!),
    });
  }

  introspectionType(name: string, selection: Field[]): Record<string, unknown> | null {
    const spec = SCHEMA_TYPES[name];
    if (!spec) return null;
    const fieldsSpec = spec.fields;
    return this.object(selection, '__Type', {
      name: () => name,
      kind: () => spec.kind,
      description: () => null,
      ofType: () => null,
      inputFields: () => null,
      interfaces: () => null,
      possibleTypes: () => null,
      fields: () => {
        const f = selection.find((x) => x.name === 'fields');
        if (!f || !fieldsSpec) return null;
        return Promise.all(Object.keys(fieldsSpec).map(async (n) =>
          this.object(f.selection, '__Field', { name: () => n, description: () => null, isDeprecated: () => false, deprecationReason: () => null, args: () => [] })));
      },
      enumValues: () => {
        const f = selection.find((x) => x.name === 'enumValues');
        if (!f) return null;
        return Promise.all((spec.enumValues ?? []).map(async (n) =>
          this.object(f.selection, '__EnumValue', { name: () => n, isDeprecated: () => false, deprecationReason: () => null })));
      },
    });
  }

  schemaOf(fields: Field[]): Record<string, unknown> {
    return this.object(fields, '__Schema', {
      queryType: () => this.object(sub(fields, 'queryType'), '__Type', { name: () => 'Query', kind: () => 'OBJECT' }),
      mutationType: () => {
        const mf = fields.find((x) => x.name === 'mutationType');
        if (!mf) return null;
        return this.object(mf.selection, '__Type', { name: () => 'Mutation', kind: () => 'OBJECT' });
      },
      types: () => {
        const tf = fields.find((x) => x.name === 'types');
        if (!tf) return null;
        return Promise.all(Object.keys(SCHEMA_TYPES).map(async (n) => this.introspectionType(n, tf.selection)));
      },
      directives: () => [],
    });
  }
}

interface TypeSpec { kind: string; fields?: Record<string, true>; enumValues?: string[] }
const SCHEMA_TYPES: Record<string, TypeSpec> = {
  Query: { kind: 'OBJECT', fields: { viewer: true, repository: true, node: true, __schema: true, __type: true } },
  Mutation: { kind: 'OBJECT', fields: { createIssue: true, closeIssue: true, createPullRequest: true, mergePullRequest: true, addComment: true } },
  Repository: { kind: 'OBJECT', fields: { id: true, databaseId: true, name: true, nameWithOwner: true, owner: true, defaultBranchRef: true, viewerPermission: true, hasIssuesEnabled: true, issue: true, issues: true, pullRequest: true, pullRequests: true, createdAt: true, description: true, isPrivate: true } },
  Issue: { kind: 'OBJECT', fields: { id: true, number: true, title: true, state: true, body: true, author: true, createdAt: true, comments: true } },
  IssueConnection: { kind: 'OBJECT', fields: { nodes: true, pageInfo: true, totalCount: true } },
  IssueCommentsConnection: { kind: 'OBJECT', fields: { nodes: true, totalCount: true, pageInfo: true } },
  IssueComment: { kind: 'OBJECT', fields: { id: true, body: true, author: true, createdAt: true } },
  PullRequest: { kind: 'OBJECT', fields: { id: true, number: true, title: true, state: true, merged: true, headRefName: true, baseRefName: true, mergeable: true, body: true, files: true, additions: true, deletions: true } },
  PullRequestConnection: { kind: 'OBJECT', fields: { nodes: true, pageInfo: true, totalCount: true } },
  PullRequestFilesConnection: { kind: 'OBJECT', fields: { nodes: true, totalCount: true, pageInfo: true } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: true } },
  Ref: { kind: 'OBJECT', fields: { name: true, target: true } },
  User: { kind: 'OBJECT', fields: { login: true } },
  PageInfo: { kind: 'OBJECT', fields: { hasNextPage: true, endCursor: true, hasPreviousPage: true, startCursor: true } },
  Node: { kind: 'INTERFACE', fields: { id: true } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  __Type: { kind: 'OBJECT', fields: { name: true, kind: true, fields: true, enumValues: true, ofType: true, description: true, inputFields: true, interfaces: true, possibleTypes: true } },
  __Schema: { kind: 'OBJECT', fields: { queryType: true, mutationType: true, types: true, directives: true } },
  __Field: { kind: 'OBJECT', fields: { name: true, description: true, isDeprecated: true, deprecationReason: true, args: true } },
  __EnumValue: { kind: 'OBJECT', fields: { name: true, isDeprecated: true, deprecationReason: true } },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------- driver

function viewerLogin(): string {
  for (const repo of registry.listRepos()) {
    if (repo.owner) return repo.owner;
  }
  return VIEWER_FALLBACK;
}

const INVALID_ID = 'Could not resolve to a node with the global id';

async function executeOperation(op: Operation, token: string): Promise<{ data: Record<string, unknown> | null; errors: { message: string }[] }> {
  const ex = new Exec(op.vars as Record<string, unknown>, viewerLogin());
  const data: Record<string, unknown> = {};
  for (const f of op.selection) {
    const key = f.alias ?? f.name;
    if (op.type === 'mutation') {
      data[key] = await runMutation(ex, f, token);
      continue;
    }
    switch (f.name) {
      case 'viewer':
        data[key] = await ex.object(f.selection, 'User', { login: () => ex.owner });
        break;
      case 'repository': {
        const { owner, name } = f.args;
        if (typeof owner !== 'string' || typeof name !== 'string') { ex.cant('repository', 'Query'); data[key] = null; break; }
        const repo = registry.findRepo(owner, name);
        data[key] = repo ? await ex.repoObject(repo, f.selection) : null;
        break;
      }
      case 'node': {
        const d = decodeGid(f.args.id);
        if (!d || !d.repo) { data[key] = null; break; }
        data[key] = await ex.repoObject(d.repo, f.selection);
        break;
      }
      case '__type': {
        const name = f.args.name;
        data[key] = typeof name === 'string' ? await ex.introspectionType(name, f.selection) : null;
        break;
      }
      case '__schema':
        data[key] = await ex.schemaOf(f.selection);
        break;
      default:
        ex.cant(f.name, 'Query');
        data[key] = null;
    }
  }
  return { data, errors: ex.errors };
}

async function runMutation(ex: Exec, f: Field, token: string): Promise<unknown> {
  const input = (f.args.input ?? {}) as Record<string, unknown>;
  const payloadSel = (f.selection.find((x) => x.name === f.name)?.selection) ?? f.selection;
  const gidError = (value: unknown): void => {
    ex.errors.push({ message: `${INVALID_ID} of '${String(value)}'` });
  };
  switch (f.name) {
    case 'createIssue': {
      const d = decodeGid(input.repositoryId);
      if (!d || !d.repo || d.kind !== 'Repository') { gidError(input.repositoryId); return null; }
      const repo = d.repo;
      const issue = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as { id: number; body: string; login: string }[],
        createdAt: Date.now(),
      };
      repo.issues.push(issue);
      return ex.object(payloadSel, 'CreateIssuePayload', {
        issue: () => ex.issueObject(repo, issue, sub(payloadSel, 'issue')),
      });
    }
    case 'closeIssue': {
      const d = decodeGid(input.issueId);
      if (!d || !d.repo || d.kind !== 'Issue' || d.n === undefined) { gidError(input.issueId); return null; }
      const repo = d.repo;
      const issue = repo.issues.find((i) => i.number === d.n);
      if (!issue) { gidError(input.issueId); return null; }
      issue.state = 'closed';
      return ex.object(payloadSel, 'CloseIssuePayload', {
        issue: () => ex.issueObject(repo, issue, sub(payloadSel, 'issue')),
      });
    }
    case 'createPullRequest': {
      const d = decodeGid(input.repositoryId);
      if (!d || !d.repo || d.kind !== 'Repository') { gidError(input.repositoryId); return null; }
      const repo = d.repo;
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      const headRef = repo.git.getRef(`refs/heads/${headRefName}`);
      const baseRef = repo.git.getRef(`refs/heads/${baseRefName}`);
      if (!headRef || !baseRef) { ex.errors.push({ message: 'Head branch does not exist' }); return null; }
      const baseCommit = repo.git.parseCommit(repo.git.read(baseRef)!.data);
      const pull = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: '',
        state: 'open' as const,
        head: { ref: headRefName, sha: headRef },
        base: { ref: baseRefName, sha: baseRef },
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as Sha | null,
        baseShaAtOpen: baseCommit.tree,
        headFiles: await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(headRef)!.data).tree),
      };
      repo.pulls.push(pull);
      return ex.object(payloadSel, 'CreatePullRequestPayload', {
        pullRequest: () => ex.pullObject(repo, pull, sub(payloadSel, 'pullRequest')),
      });
    }
    case 'mergePullRequest': {
      const d = decodeGid(input.pullRequestId);
      if (!d || !d.repo || d.kind !== 'PullRequest' || d.n === undefined) { gidError(input.pullRequestId); return null; }
      const repo = d.repo;
      const pull = repo.pulls.find((p) => p.number === d.n);
      if (!pull) { gidError(input.pullRequestId); return null; }
      if (!pull.merged && pull.state === 'open') {
        const baseRefName = `refs/heads/${pull.base.ref}`;
        const currentBaseSha = repo.git.getRef(baseRefName);
        if (currentBaseSha === pull.base.sha) {
          let treeSha: Sha = pull.baseShaAtOpen;
          const headFiles = await getTreeFiles(repo.git, repo.git.parseCommit(repo.git.read(pull.head.sha as Sha)!.data).tree);
          for (const file of headFiles) {
            const blobSha = repo.git.write('blob', Buffer.from(file.content));
            treeSha = await updateTree(repo.git, treeSha, file.path.split('/'), blobSha);
          }
          const author = { name: 'Forge', email: 'forge@local', timestamp: Math.floor(Date.now() / 1000), offset: '+0000' };
          const mergeSha = repo.git.write('commit', repo.git.buildCommit({
            tree: treeSha,
            parents: [currentBaseSha!],
            author, committer: author,
            message: `Merge pull request #${pull.number} from ${pull.head.ref}`,
          }));
          repo.git.setRef(baseRefName, mergeSha);
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = new Date().toISOString();
          pull.mergeCommitSha = mergeSha;
        }
      }
      return ex.object(payloadSel, 'MergePullRequestPayload', {
        pullRequest: () => ex.pullObject(repo, pull, sub(payloadSel, 'pullRequest')),
      });
    }
    case 'addComment': {
      const d = decodeGid(input.subjectId);
      if (!d || !d.repo || d.kind !== 'Issue' || d.n === undefined) { gidError(input.subjectId); return null; }
      const repo = d.repo;
      const issue = repo.issues.find((i) => i.number === d.n);
      if (!issue) { gidError(input.subjectId); return null; }
      const comment = { id: registry.nextCommentId++, body: String(input.body ?? ''), login: repo.owner ?? ex.owner };
      issue.comments.push(comment);
      const edgeSel = sub(payloadSel, 'commentEdge');
      return ex.object(payloadSel, 'AddCommentPayload', {
        commentEdge: () => ex.object(edgeSel, 'CommentEdge', {
          node: () => ex.commentObject(repo, issue.number, comment, sub(edgeSel, 'node')),
        }),
      });
    }
    default:
      ex.cant(f.name, 'Mutation');
      return null;
  }
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, _registry: unknown, token: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/graphql') return false;
  const send = (status: number, body: unknown): void => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  };
  const auth = req.headers.authorization;
  if (token === '' || auth !== `Bearer ${token}`) {
    send(401, { message: 'Requires authentication' });
    return true;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { send(400, { message: 'Problems parsing JSON' }); return true; }
  const runOne = async (entry: unknown): Promise<{ status: number; body: unknown }> => {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { query?: unknown }).query !== 'string') {
      return { status: 200, body: { errors: [{ message: 'A query attribute must be specified and must be a string' }] } };
    }
    let ops: Operation[];
    try {
      ops = parseDocument((entry as { query: string }).query, ((entry as { variables?: Record<string, unknown> }).variables ?? {}));
    } catch (err) {
      return { status: 200, body: { errors: [{ message: `Syntax error in query: ${(err as Error).message}` }] } };
    }
    let op = ops[0];
    const wanted = (entry as { operationName?: unknown }).operationName;
    if (typeof wanted === 'string') op = ops.find((o) => o.name === wanted) ?? op;
    if (!op) return { status: 200, body: { errors: [{ message: 'No operation found' }] } };
    const { data, errors } = await executeOperation(op, token);
    return { status: 200, body: errors.length ? { data, errors } : { data } };
  };
  if (Array.isArray(parsed)) {
    const bodies: unknown[] = [];
    let status = 200;
    for (const entry of parsed) {
      const r = await runOne(entry);
      status = Math.max(status, r.status);
      bodies.push(r.body);
    }
    send(status, bodies);
    return true;
  }
  const r = await runOne(parsed);
  send(r.status, r.body);
  return true;
}
