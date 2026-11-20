import { Store } from './gitcore.ts';
import { join } from 'node:path';

export interface RepoRecord {
  owner: string | null;
  name: string;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  git: Store;
  createdAt: number;
  labels: { name: string; color: string }[];
  issues: {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    labels: string[];
    comments: { id: number; body: string; login: string }[];
    createdAt: number;
  }[];
  pulls: {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    merged: boolean;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    baseShaAtOpen: string;
    headFiles: { path: string; content: string }[];
  }[];
  nextNumber: number;
}

export class Registry {
  repos: Map<string /* owner/name */, RepoRecord> = new Map();
  pendingRepos: Map<string /* name */, RepoRecord> = new Map();
  nextCommentId: number = 1;

  createRepo(name: string, description: string = '', privateFlag: boolean = false): RepoRecord {
    if (this.pendingRepos.has(name) || Array.from(this.repos.values()).some(r => r.name === name)) {
      throw new Error('Already exists');
    }
    const git = new Store(join('data', 'repos', `${name}`));
    const repo: RepoRecord = {
      owner: null,
      name,
      description,
      privateFlag,
      defaultBranch: 'main',
      git,
      createdAt: Date.now(),
      labels: [],
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.pendingRepos.set(name, repo);
    return repo;
  }

  createRepoWithOwner(owner: string, name: string, description: string = '', privateFlag: boolean = false): RepoRecord {
    const id = `${owner}/${name}`;
    if (this.repos.has(id)) {
      throw new Error('Already exists');
    }
    const git = new Store(join('data', 'repos', `${owner}-${name}`));
    const repo: RepoRecord = {
      owner,
      name,
      description,
      privateFlag,
      defaultBranch: 'main',
      git,
      createdAt: Date.now(),
      labels: [],
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.repos.set(id, repo);
    return repo;
  }

  findRepo(ownerPath: string, name: string): RepoRecord | null {
    const adoptedId = `${ownerPath}/${name}`;
    if (this.repos.has(adoptedId)) {
      return this.repos.get(adoptedId)!;
    }

    // Check if repo exists under a different owner -> 404
    for (const repo of this.repos.values()) {
      if (repo.name === name) {
        return null;
      }
    }

    const pending = this.pendingRepos.get(name);
    if (pending) {
      pending.owner = ownerPath;
      this.pendingRepos.delete(name);
      this.repos.set(adoptedId, pending);
      return pending;
    }

    return null;
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values(), ...this.pendingRepos.values()]
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}

export const registry = new Registry();
