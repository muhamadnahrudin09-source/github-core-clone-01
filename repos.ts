import { Store } from './gitcore.ts';
import { join } from 'node:path';

export interface RepoRecord {
  owner: string;
  name: string;
  description: string;
  privateFlag: boolean;
  git: Store;
}

export class Registry {
  repos: Map<string /*owner/name*/, RepoRecord> = new Map();

  createRepo(owner: string, name: string): RepoRecord {
    const id = `${owner}/${name}`;
    const git = new Store(join('data', 'repos', `${owner}-${name}`));
    const repo: RepoRecord = { owner, name, description: '', privateFlag: false, git };
    this.repos.set(id, repo);
    return repo;
  }
}

export const registry = new Registry();
