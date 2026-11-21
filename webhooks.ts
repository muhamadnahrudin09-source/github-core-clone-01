import { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from './repos.ts';

export async function handleWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  registry: Registry
): Promise<boolean> {
  res.setHeader('content-type', 'application/json');

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // Expecting: api, v3, repos, {owner}, {repo}, hooks, [hook_id], [action]
  if (parts.length < 6 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'hooks') {
    return false;
  }

  const owner = parts[3];
  const repoName = parts[4];
  const method = req.method ?? 'GET';

  const repo = registry.findRepo(owner, repoName);
  if (!repo) {
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
    return true;
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
    // GET /api/v3/repos/{owner}/{repo}/hooks
    if (parts.length === 6) {
      if (method === 'GET') {
        return send(repo.hooks);
      }
      if (method === 'POST') {
        const body = await getBody();
        if (!body || !body.config || !body.config.url) {
          return error('config.url is required', 422);
        }
        const hookId = repo.nextHookId++;
        const now = new Date().toISOString();
        const newHook = {
          id: hookId,
          name: body.name || 'web',
          active: body.active !== undefined ? body.active : true,
          events: body.events || ['push'],
          config: {
            url: body.config.url,
            content_type: body.config.content_type || 'json'
          },
          created_at: now,
          updated_at: now,
          ping_deliveries: []
        };
        repo.hooks.push(newHook);
        return send(newHook, 201);
      }
    }

    // /api/v3/repos/{owner}/{repo}/hooks/{hook_id}
    if (parts.length >= 7) {
      const hookId = parseInt(parts[6], 10);
      const hook = repo.hooks.find(h => h.id === hookId);
      if (!hook) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
        return true;
      }

      if (parts.length === 7) {
        if (method === 'GET') {
          return send(hook);
        }
        if (method === 'PATCH') {
          const body = await getBody();
          if (body.active !== undefined) hook.active = body.active;
          if (body.events !== undefined) hook.events = body.events;
          if (body.config) {
            if (body.config.url !== undefined) hook.config.url = body.config.url;
            if (body.config.content_type !== undefined) hook.config.content_type = body.config.content_type;
          }
          hook.updated_at = new Date().toISOString();
          return send(hook);
        }
        if (method === 'DELETE') {
          repo.hooks = repo.hooks.filter(h => h.id !== hookId);
          res.statusCode = 204;
          res.end();
          return true;
        }
      }

      // POST /api/v3/repos/{owner}/{repo}/hooks/{hook_id}/pings
      if (parts.length === 8 && parts[7] === 'pings') {
        if (method === 'POST') {
          const deliveryId = hook.ping_deliveries.length ? Math.max(...hook.ping_deliveries.map(d => d.id)) + 1 : 1;
          hook.ping_deliveries.push({
            id: deliveryId,
            created_at: new Date().toISOString()
          });
          hook.updated_at = new Date().toISOString();
          res.statusCode = 204;
          res.end();
          return true;
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
