import { defineConfig, loadEnv } from 'vite';
import { publicRegistrationOrigin } from './server/registrationMail.js';
import { createWorkbench } from './server/workbench.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'HUIXU_');
  const publicOrigin = publicRegistrationOrigin(env.HUIXU_PUBLIC_ORIGIN);
  function mount(server) {
    const workbench = createWorkbench(server.config.root, env);
    for (const [path, handler] of Object.entries(workbench.routes)) server.middlewares.use(path, handler);
    server.httpServer?.once('close', workbench.close);
  }
  return {
    preview: { allowedHosts: publicOrigin ? [new URL(publicOrigin).hostname] : [] },
    esbuild: { jsx: 'automatic' },
    plugins: [{
      name: 'huixu-agent-api',
      configureServer: mount,
      configurePreviewServer: mount,
    }],
  };
});
