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
    
    // 1. Create Repo
    const createRes = await httpRequest('POST', '/api/v3/user/repos', { name: 'testrepo' });
    console.log('CREATE repo:', createRes.status, createRes.data);
    
    // 2. PUT file
    const putRes = await httpRequest('PUT', '/api/v3/repos/testtoken123/testrepo/contents/test.txt', {
        message: 'Add test.txt',
        content: Buffer.from('hello').toString('base64')
    });
    console.log('PUT test.txt:', putRes.status);
    
    // 3. GET file
    const getRes = await httpRequest('GET', '/api/v3/repos/testtoken123/testrepo/contents/test.txt');
    console.log('GET test.txt:', getRes.status, getRes.data.content);
    
    // 4. DELETE file
    const deleteRes = await httpRequest('DELETE', '/api/v3/repos/testtoken123/testrepo/contents/test.txt', {
        message: 'Delete test.txt',
        sha: getRes.data.sha
    });
    console.log('DELETE test.txt:', deleteRes.status);
    
    server.kill();
}

main();
