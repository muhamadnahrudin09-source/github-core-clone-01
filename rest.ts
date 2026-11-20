import { IncomingMessage, ServerResponse } from 'node:http';
import { Registry } from './repos.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': '1234567890',
    ...headers
  });
  res.end(text);
}

async function getJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  registry: Registry,
  token: string
): Promise<boolean> {
  if (!path.startsWith('/api/v3/')) return false;

  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  try {
    // Top-level
    if (path === '/api/v3/' || path === '/api/v3') {
        sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo' });
        return true;
    }
    
    // Repository routes
    const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (repoMatch) {
      const owner = repoMatch[1];
      const repoName = repoMatch[2];
      const subpath = repoMatch[3];
      const repoId = `${owner}/${repoName}`;
      const repo = registry.repos.get(repoId);

      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      
      if (!subpath) {
        if (method === 'GET') {
          sendJson(res, 200, { owner: repo.owner, name: repo.name, description: repo.description });
          return true;
        }
      } else if (subpath === 'branches') {
         if (method === 'GET') {
             const refs = repo.git.listRefs();
             sendJson(res, 200, refs.filter(r => r.name.startsWith('refs/heads/')).map(r => ({ name: r.name.replace('refs/heads/', '') })));
             return true;
         }
      }
    }
    
    // Fallback
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (e) {
    if (e instanceof SyntaxError) {
      sendJson(res, 400, { message: 'Malformed JSON' });
      return true;
    }
    throw e;
  }
}
