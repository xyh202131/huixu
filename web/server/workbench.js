import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createAgentHandler } from './agent.js';
import { createWorkbenchAuth } from './auth.js';
import { createBrowserModelTest } from './browserModelApi.js';
import { isWorkbenchRequest, sendJson } from './localApi.js';
import { createMemoryHandler } from './memoryApi.js';
import { createPlatformModel } from './modelProvider.js';
import { createModelSettings } from './modelSettings.js';
import { createOrganizationHandler } from './organizationApi.js';
import { createProjectMemory } from './projectMemory.js';
import { registrationOwnerApi, registrationPublicApi } from './registrationApi.js';
import { createRegistrationMail } from './registrationMail.js';
import { createRegistrationStore } from './registrationStore.js';
import { createTopicPlanHandler } from './topicPlanApi.js';
import { localDatabasePath } from './localData.js';
import { createWorkspaceStore } from './workspaceStore.js';

export function createWorkbench(root, env, publicOrigin) {
  const authDb = localDatabasePath(root, env.HUIXU_AUTH_DB, 'auth.sqlite');
  const auth = createWorkbenchAuth(root, authDb, {
    publicOrigin, ownerEmail: env.HUIXU_OWNER_EMAIL, ownerPassword: env.HUIXU_OWNER_PASSWORD, signupCode: env.HUIXU_SIGNUP_CODE,
  });
  const registrations = createRegistrationStore(root, env.HUIXU_REGISTRATION_DB);
  const mail = createRegistrationMail(registrations, env);
  const platformModel = createPlatformModel(env);
  const accounts = new Map();

  function accountRoute(service) {
    const bindAccount = ['models', 'agent', 'topic', 'organization'].includes(service);
    return auth.requireSession((request, response, user) => {
      if (!accounts.has(user.id)) {
        const key = createHash('sha256').update(user.id).digest('hex');
        const directory = join(dirname(authDb), 'accounts', key);
        const memory = createProjectMemory(root, user.legacyWorkspace ? env.HUIXU_MEMORY_DB : join(directory, 'memory.sqlite'));
        const models = createModelSettings(root, user.legacyWorkspace ? env : { HUIXU_MODEL_DB: join(directory, 'models.sqlite') },
          auth.modelStorageKey(user.id), platformModel);
        const workspace = createWorkspaceStore(localDatabasePath(root, join(directory, 'workspace.sqlite'), 'workspace.sqlite'));
        accounts.set(user.id, {
          workspace: workspace.handle, models: models.handle, memory: createMemoryHandler(memory),
          agent: createAgentHandler(models.getConfig, memory, { platformModel, getPersonalModel: models.getPersonalConfig }),
          topic: createTopicPlanHandler(models.getConfig),
          organization: createOrganizationHandler(models.getOrganizationConfig, memory),
          close() { workspace.close(); models.close(); memory.close(); },
        });
      }
      return accounts.get(user.id)[service](request, response, user);
    }, { bindAccount });
  }

  const routes = {
    '/api/auth': auth.handle,
    '/api/workbench-session': auth.session,
    '/api/workspace': accountRoute('workspace'),
    '/api/model-settings': accountRoute('models'),
    '/api/platform-model': (request, response) => {
      if (!isWorkbenchRequest(request)) return sendJson(response, 403, { error: '请从会序工作台访问。' });
      if (request.method !== 'GET') return sendJson(response, 405, { error: '此接口仅接受 GET。' });
      return sendJson(response, 200, { platform: platformModel ? { model: platformModel.model } : null });
    },
    '/api/browser-model-test': createBrowserModelTest(),
    '/api/browser-agent': createAgentHandler(() => platformModel, null, { platformModel, getPersonalModel: () => null }),
    '/api/browser-topic-plan': createTopicPlanHandler(() => platformModel),
    '/api/agent': accountRoute('agent'),
    '/api/topic-plan': accountRoute('topic'),
    '/api/registration': auth.requireSession(registrationOwnerApi(registrations, mail, user => user.legacyWorkspace === true)),
    '/api/registration-public': registrationPublicApi(registrations, mail.origin),
    '/api/project-memory': accountRoute('memory'),
    '/api/project-organization': accountRoute('organization'),
  };
  return { routes, close() {
    for (const account of accounts.values()) account.close();
    accounts.clear();
    auth.close();
    registrations.close();
  } };
}
