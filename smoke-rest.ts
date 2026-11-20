import { createApp } from './app.ts';
import { IncomingMessage, ServerResponse } from 'node:http';

async function run() {
    const server = createApp();
    const port = await new Promise<number>(resolve => {
        server.listen(0, () => resolve((server.address() as any).port));
    });
    console.log(`Server listening on port ${port}`);

    // Test 1: Health check
    const res1 = await fetch(`http://localhost:${port}/healthz`);
    console.log('Health:', res1.status, await res1.json());

    // Test 2: API root (unauth)
    const res2 = await fetch(`http://localhost:${port}/api/v3`);
    console.log('API root (unauth):', res2.status, await res2.json());

    // Test 3: API root (auth)
    const res3 = await fetch(`http://localhost:${port}/api/v3`, { headers: { 'Authorization': 'Bearer testtoken123' } });
    console.log('API root (auth):', res3.status, await res3.json());
    console.log('Scopes:', res3.headers.get('x-oauth-scopes'));

    server.close();
}
run();
