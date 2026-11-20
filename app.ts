// The starter's HTTP surface, exactly as it ships: a health probe and an API root, and a JSON 404
// for everything else. The contest's real surface — git smart HTTP, REST v3 resources, GraphQL v4 and
// the MCP endpoint — is what you add (README.md names it, and the rules link below says what scores).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { registry } from './repos.ts';
import { handleGitHttp } from './githttp.ts';
import { handleRest } from './rest.ts';
import { sendJson } from './http-utils.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'testtoken123';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path.startsWith('/api/v3')) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${TOKEN}`) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (await handleRest(req, res, path, method, registry)) {
        return;
      }
    }

    // Git routes
    const repoMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
    if (repoMatch) {
      const [_, owner, repo, subpath] = repoMatch;
      const repoId = `${owner}/${repo}`;
      const repoRecord = registry.repos.get(repoId);
      if (repoRecord) {
        const service = req.url?.includes('service=git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack';
        await handleGitHttp(repoId, subpath, service, req, res, repoRecord.git);
        return;
      }
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
