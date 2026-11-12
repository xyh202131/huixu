export const modelPresets = {
  openai: { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
  anthropic: { label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', keyHeader: 'x-api-key' },
  gemini: { label: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', thinking: { type: 'disabled' } },
  qwen: { label: '通义千问 · 百炼中国内地', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  minimax: { label: 'MiniMax 中国', protocol: 'anthropic', baseUrl: 'https://api.minimax.cn/anthropic', model: 'MiniMax-M3.1-Flash' },
};
