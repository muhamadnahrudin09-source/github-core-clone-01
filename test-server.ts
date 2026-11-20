import { createApp } from './app.ts';

const port = 3000;
const server = createApp();
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
server.on('error', (e) => {
  console.error('Server error:', e);
});
