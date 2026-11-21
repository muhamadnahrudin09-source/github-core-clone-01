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
        const orgLogin = 'mytestorg';
        const orgPath = `/api/v3/orgs/${orgLogin}`;

        // 1. Create Organization (POST /api/v3/orgs)
        const createOrgRes = await httpRequest('POST', '/api/v3/orgs', {
            login: orgLogin,
            description: 'A test organization',
            name: 'My Test Org'
        });
        assert(createOrgRes.status === 201 && createOrgRes.data.login === orgLogin, 'Create organization status 201 and login matches');

        // 2. Get Organization (GET /api/v3/orgs/{org})
        const getOrgRes = await httpRequest('GET', orgPath);
        assert(getOrgRes.status === 200 && getOrgRes.data.description === 'A test organization', 'Get organization status 200 and description matches');

        // 3. Update Organization (PATCH /api/v3/orgs/{org})
        const patchOrgRes = await httpRequest('PATCH', orgPath, {
            description: 'Updated test organization description'
        });
        assert(patchOrgRes.status === 200 && patchOrgRes.data.description === 'Updated test organization description', 'Patch organization updates description');

        // 4. List Organizations (GET /api/v3/orgs)
        const listOrgsRes = await httpRequest('GET', '/api/v3/orgs');
        assert(listOrgsRes.status === 200 && Array.isArray(listOrgsRes.data) && listOrgsRes.data.some((o: any) => o.login === orgLogin), 'List organizations returns array containing new org');

        // 5. Add Member (PUT /api/v3/orgs/{org}/members/{username})
        const username = 'testuser1';
        const memberPath = `${orgPath}/members/${username}`;
        const addMemberRes = await httpRequest('PUT', memberPath);
        assert(addMemberRes.status === 204, 'Add member returns 204 No Content');

        // 6. List Members (GET /api/v3/orgs/{org}/members)
        const listMembersRes = await httpRequest('GET', `${orgPath}/members`);
        assert(listMembersRes.status === 200 && Array.isArray(listMembersRes.data) && listMembersRes.data.some((m: any) => m.login === username), 'List members returns added member');

        // 7. Remove Member (DELETE /api/v3/orgs/{org}/members/{username})
        const removeMemberRes = await httpRequest('DELETE', memberPath);
        assert(removeMemberRes.status === 204, 'Remove member returns 204 No Content');

        // 8. Create Repository in Org (POST /api/v3/orgs/{org}/repos)
        const repoName = 'orgtestrepo';
        const createRepoRes = await httpRequest('POST', `${orgPath}/repos`, {
            name: repoName,
            description: 'Repository inside org'
        });
        assert(createRepoRes.status === 201 && createRepoRes.data.name === repoName && createRepoRes.data.owner.login === orgLogin, 'Create repo in org status 201 and owner matches');

        // 9. List Repos of Org (GET /api/v3/orgs/{org}/repos)
        const listReposRes = await httpRequest('GET', `${orgPath}/repos`);
        assert(listReposRes.status === 200 && Array.isArray(listReposRes.data) && listReposRes.data.some((r: any) => r.name === repoName), 'List org repos returns created repo');

        // 10. Search Repositories (GET /api/v3/search/repositories?q=orgtestrepo)
        const searchReposRes = await httpRequest('GET', '/api/v3/search/repositories?q=orgtestrepo');
        assert(searchReposRes.status === 200 && searchReposRes.data.total_count >= 1 && searchReposRes.data.items.some((r: any) => r.name === repoName), 'Search repositories finds created repo');

        // 11. Search Issues (GET /api/v3/search/issues?q=...)
        const searchIssuesRes = await httpRequest('GET', '/api/v3/search/issues?q=test');
        assert(searchIssuesRes.status === 200 && typeof searchIssuesRes.data.total_count === 'number', 'Search issues returns valid response structure');

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
