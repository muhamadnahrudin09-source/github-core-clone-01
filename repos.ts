import { Store } from './gitcore.ts';
import { join } from 'node:path';

export interface RepoRecord {
  owner: string;
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
  repos: Map<string /*owner/name*/, RepoRecord> = new Map();
  nextCommentId: number = 1;

  createRepo(owner: string, name: string, description: string = '', privateFlag: boolean = false): RepoRecord {
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

  listRepos(owner: string): RepoRecord[] {
    return Array.from(this.repos.values())
      .filter(r => r.owner === owner)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}

export const registry = new Registry();
