import { defineConfig, loadEnv } from 'vite';
import { createAgentHandler } from './server/agent.js';
import { createWorkbenchAuth } from './server/auth.js';
import { createMemoryHandler } from './server/memoryApi.js';
import { createModelSettings } from './server/modelSettings.js';
import { createOrganizationHandler } from './server/organizationApi.js';
import { createProjectMemory } from './server/projectMemory.js';
import { createTopicPlanHandler } from './server/topicPlanApi.js';
import { registrationOwnerApi, registrationPublicApi } from './server/registrationApi.js';
import { createRegistrationMail, publicRegistrationOrigin } from './server/registrationMail.js';
import { createRegistrationStore } from './server/registrationStore.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'HUIXU_');
  const publicOrigin = publicRegistrationOrigin(env.HUIXU_PUBLIC_ORIGIN);
  function mount(server) {
    const memory = createProjectMemory(server.config.root, env.HUIXU_MEMORY_DB);
    const auth = createWorkbenchAuth(server.config.root, env.HUIXU_AUTH_DB);
    const models = createModelSettings(server.config.root, env);
    const registrations = createRegistrationStore(server.config.root, env.HUIXU_REGISTRATION_DB);
    const mail = createRegistrationMail(registrations, env);
    server.middlewares.use('/api/auth', auth.handle);
    server.middlewares.use('/api/workbench-session', auth.session);
    server.middlewares.use('/api/model-settings', auth.requireSession(models.handle));
    server.middlewares.use('/api/agent', auth.requireSession(createAgentHandler(models.getConfig, memory)));
    server.middlewares.use('/api/topic-plan', auth.requireSession(createTopicPlanHandler(models.getConfig)));
    server.middlewares.use('/api/registration', auth.requireSession(registrationOwnerApi(registrations, mail)));
    server.middlewares.use('/api/registration-public', registrationPublicApi(registrations, mail.origin));
    server.middlewares.use('/api/project-memory', auth.requireSession(createMemoryHandler(memory)));
    server.middlewares.use('/api/project-organization', auth.requireSession(createOrganizationHandler(models.getOrganizationConfig, memory)));
    server.httpServer?.once('close', () => { memory.close(); auth.close(); models.close(); registrations.close(); });
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
