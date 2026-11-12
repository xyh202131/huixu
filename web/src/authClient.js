export const sessionExpired = 'huixu:session-expired';

export async function authRequest(path, input) {
  const options = input === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  };
  const response = await fetch(path, options);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本机账号服务不可用。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '账号操作失败。');
  return result;
}
