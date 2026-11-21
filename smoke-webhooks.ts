import { spawn } from 'node:child_process';
import { request } from 'node:http';

async function httpRequest(method: string, path: string, data: any = null, token: string = 'testtoken123'): Promise<{status: number, data: any}> {
    return new Promise((resolve, reject) => {
        const req = request(`http://localhost:3000${path}`, {
            method: method,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode!, data: body ? JSON.parse(body) : null }));
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function main() {
    const server = spawn('node', ['--experimental-strip-types', 'test-server.ts'], { 
        env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'testtoken123' },
        stdio: 'inherit'
    });
    
    // Give it a moment to boot
    await new Promise(resolve => setTimeout(resolve, 2000));

    let failed = false;

    function assert(condition: boolean, desc: string) {
        if (condition) {
            console.log(`PASS: ${desc}`);
        } else {
            console.error(`FAIL: ${desc}`);
            failed = true;
        }
    }

    try {
        // 1. Create Repo
        const createRepoRes = await httpRequest('POST', '/api/v3/user/repos', { name: 'webhooktestrepo' });
        assert(createRepoRes.status === 201, 'Create repo status 201');

        const repoPath = '/api/v3/repos/testtoken123/webhooktestrepo/hooks';

        // 2. Create hook validation error (missing config.url)
        const invalidHookRes = await httpRequest('POST', repoPath, { config: {} });
        assert(invalidHookRes.status === 422, 'Create hook without config.url returns 422');

        // 3. Create valid hook
        const createHookRes = await httpRequest('POST', repoPath, {
            config: { url: 'https://example.com/webhook', content_type: 'json' },
            events: ['push', 'issues']
        });
        assert(createHookRes.status === 201 && createHookRes.data.id, 'Create valid hook status 201 and has id');
        const hookId = createHookRes.data.id;
        assert(createHookRes.data.config.url === 'https://example.com/webhook', 'Hook config.url matches');
        assert(createHookRes.data.events.length === 2, 'Hook events match');

        // 4. List hooks
        const listRes = await httpRequest('GET', repoPath);
        assert(listRes.status === 200 && Array.isArray(listRes.data) && listRes.data.length === 1, 'List hooks returns array with 1 item');

        // 5. Get single hook
        const getRes = await httpRequest('GET', `${repoPath}/${hookId}`);
        assert(getRes.status === 200 && getRes.data.id === hookId, 'Get single hook returns correct hook');

        // 6. Update hook
        const patchRes = await httpRequest('PATCH', `${repoPath}/${hookId}`, {
            active: false,
            config: { url: 'https://example.com/updated' }
        });
        assert(patchRes.status === 200 && patchRes.data.active === false && patchRes.data.config.url === 'https://example.com/updated', 'Patch hook updates active and config.url');

        // 7. Ping hook
        const pingRes = await httpRequest('POST', `${repoPath}/${hookId}/pings`);
        assert(pingRes.status === 204, 'Ping hook returns 204 No Content');

        // 8. Verify ping delivery
        const getAfterPing = await httpRequest('GET', `${repoPath}/${hookId}`);
        assert(getAfterPing.status === 200 && getAfterPing.data.ping_deliveries.length === 1, 'Get hook shows 1 ping delivery');

        // 9. Delete hook
        const deleteRes = await httpRequest('DELETE', `${repoPath}/${hookId}`);
        assert(deleteRes.status === 204, 'Delete hook returns 204 No Content');

        // 10. Get unknown / deleted hook returns 404
        const getDeletedRes = await httpRequest('GET', `${repoPath}/${hookId}`);
        assert(getDeletedRes.status === 404, 'Get deleted hook returns 404');

    } catch (e) {
        console.error('Exception during smoke test:', e);
        failed = true;
    } finally {
        server.kill();
    }

    if (failed) {
        console.error('SMOKE TESTS FAILED');
        process.exit(1);
    } else {
        console.log('ALL SMOKE TESTS PASSED');
    }
}

main();
