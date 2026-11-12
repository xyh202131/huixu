import { defineConfig, loadEnv } from 'vite';
import { createAgentHandler } from './server/agent.js';
import { createWorkbenchAuth } from './server/auth.js';
import { createMemoryHandler } from './server/memoryApi.js';
import { createOrganizationHandler } from './server/organizationApi.js';
import { createProjectMemory } from './server/projectMemory.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'HUIXU_');
  function mount(server) {
    const memory = createProjectMemory(server.config.root, env.HUIXU_MEMORY_DB);
    const auth = createWorkbenchAuth(server.config.root, env.HUIXU_AUTH_DB);
    server.middlewares.use('/api/auth', auth.handle);
    server.middlewares.use('/api/workbench-session', auth.session);
    server.middlewares.use('/api/agent', auth.requireSession(createAgentHandler(env, memory)));
    server.middlewares.use('/api/project-memory', auth.requireSession(createMemoryHandler(memory)));
    server.middlewares.use('/api/project-organization', auth.requireSession(createOrganizationHandler(env, memory)));
    server.httpServer?.once('close', () => { memory.close(); auth.close(); });
  }
  return {
    esbuild: { jsx: 'automatic' },
    plugins: [{
      name: 'huixu-agent-api',
      configureServer: mount,
      configurePreviewServer: mount,
    }],
  };
});
