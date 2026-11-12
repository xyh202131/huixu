export function readModelConfig(env) {
  const protocol = env.HUIXU_LLM_PROTOCOL || 'openai';
  if (!['openai', 'anthropic'].includes(protocol) || !env.HUIXU_LLM_MODEL) return null;
  let url;
  try { url = new URL(env.HUIXU_LLM_BASE_URL); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) return null;

  const basePath = url.pathname.replace(/\/+$/, '');
  if (protocol === 'anthropic') url.pathname = basePath.endsWith('/v1') ? `${basePath}/messages` : `${basePath}/v1/messages`;
  else url.pathname = `${basePath}/chat/completions`;
  return { protocol, url, model: env.HUIXU_LLM_MODEL, key: env.HUIXU_LLM_API_KEY };
}

function modelError(status) {
  if (status === 401 || status === 403) return '模型服务拒绝鉴权，请检查会序的模型配置。';
  if (status === 429) return '模型服务请求受限，请稍后重试。';
  return '模型服务未能处理请求，请检查模型名称与工具调用支持。';
}

function parseArguments(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function requestModel(config, { system, messages, tools, final, signal }) {
  const anthropic = config.protocol === 'anthropic';
  const body = anthropic ? {
    model: config.model, system, messages, max_tokens: 4096,
    ...(!final && { tools: tools.map(({ function: definition }) => ({
      name: definition.name, description: definition.description, input_schema: definition.parameters,
    })) }),
  } : {
    model: config.model, messages: [{ role: 'system', content: system }, ...messages], tools, tool_choice: final ? 'none' : 'auto',
  };
  const response = await fetch(config.url, {
    method: 'POST', signal, redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(anthropic && { 'anthropic-version': '2023-06-01' }),
      ...(config.key && { Authorization: `Bearer ${config.key}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { error: modelError(response.status) };
  const data = await response.json();
  if (anthropic) {
    if (!Array.isArray(data.content)) return null;
    return {
      answer: data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      calls: data.content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, args: block.input })),
      // Messages 要求在回传工具结果时保留模型原始内容块，包括思考签名。
      assistant: { role: 'assistant', content: data.content },
      model: data.model,
    };
  }

  const message = data.choices?.[0]?.message;
  if (!message || (message.tool_calls && !Array.isArray(message.tool_calls))) return null;
  return {
    answer: message.content,
    calls: (message.tool_calls ?? []).map(call => ({ id: call?.id, name: call?.function?.name, args: parseArguments(call?.function?.arguments) })),
    assistant: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls },
    model: data.model,
  };
}

export function toolMessages(protocol, results) {
  if (protocol === 'anthropic') {
    return [{ role: 'user', content: results.map(({ id, result }) => ({
      type: 'tool_result', tool_use_id: id, content: JSON.stringify(result), is_error: Boolean(result.error),
    })) }];
  }
  return results.map(({ id, result }) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) }));
}
