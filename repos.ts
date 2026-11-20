import { Store } from './gitcore.ts';
import { join } from 'node:path';

export interface RepoRecord {
  owner: string;
  name: string;
  description: string;
  privateFlag: boolean;
  git: Store;
  labels: Map<string, { name: string; color: string }>;
  issues: { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[] }[];
  pulls: {
    number: number;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    state: 'open' | 'closed';
    mergeable: boolean;
  }[];
  counter: number;
}

export class Registry {
  repos: Map<string /*owner/name*/, RepoRecord> = new Map();

  createRepo(owner: string, name: string): RepoRecord {
    const id = `${owner}/${name}`;
    const git = new Store(join('data', 'repos', `${owner}-${name}`));
    const repo: RepoRecord = {
      owner,
      name,
      description: '',
      privateFlag: false,
      git,
      labels: new Map(),
      issues: [],
      pulls: [],
      counter: 1,
    };
    this.repos.set(id, repo);
    return repo;
  }
}

export const registry = new Registry();
