import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArchiveName, sourceAccept } from '../src/sourceFormats.js';

export { isSupportedSource } from '../src/sourceFormats.js';

const parser = fileURLToPath(new URL('./extractSource.py', import.meta.url));
const textFormats = new Set(['.md', '.txt', '.json']);
const maxChunkChars = 1200;
const maxChunks = 2500;

function plainSections(buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (text.includes('\0')) throw new Error('不是纯文本');
  const sections = [];
  let heading = '';
  let paragraph = [];
  let firstLine = 1;
  const clipped = text.slice(0, 450000);
  const lines = clipped.split(/\r\n|\n|\r/);
  function flush(lastLine) {
    if (!paragraph.length) return;
    const location = `第 ${firstLine}${lastLine === firstLine ? '' : `–${lastLine}`} 行`;
    sections.push({ location: heading ? `${location} · ${heading}` : location, text: paragraph.join('\n') });
    paragraph = [];
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || /^#{1,6}\s/.test(line)) {
      flush(index);
      if (line) {
        heading = line.replace(/^#{1,6}\s+/, '').slice(0, 100);
        sections.push({ location: `第 ${index + 1} 行`, text: line });
      }
    } else {
      if (!paragraph.length) firstLine = index + 1;
      paragraph.push(line);
    }
  }
  flush(lines.length);
  return { sections, partial: clipped.length < text.length };
}

function pythonExtract(buffer, name) {
  return new Promise(resolve => {
    const child = spawn(process.env.HUIXU_MEMORY_PYTHON || 'python', [parser, name, sourceAccept], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let problem = '';
    const timer = setTimeout(() => {
      problem = '本机解析超时';
      child.kill();
    }, isArchiveName(name) ? 90000 : 45000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      if (output.length + part.length > 2200000) {
        problem = '解析结果超出大小限制';
        child.kill();
        return;
      }
      output += part;
    });
    child.stdin.on('error', () => { /* 解析器退出时由 close 统一返回状态。 */ });
    child.on('error', () => { problem = '本机 Python 解析器不可用'; });
    child.on('close', code => {
      clearTimeout(timer);
      if (problem || code !== 0) return resolve({ error: problem || '本机解析器未能完成解析' });
      try { resolve(JSON.parse(output)); } catch { resolve({ error: '本机解析器返回异常' }); }
    });
    child.stdin.end(buffer);
  });
}

export async function parseSource(name, buffer) {
  let result;
  if (textFormats.has(extname(name).toLowerCase())) {
    try {
      const { sections, partial } = plainSections(buffer);
      result = { sections, state: partial ? '部分已索引' : '已索引', note: partial ? '达到文字索引上限' : '' };
    } catch { /* 继续尝试本机解析器支持的其他文本编码。 */ }
  }
  result ??= await pythonExtract(buffer, name);
  if (result.error) return { chunks: [], state: '待处理', note: result.error };

  const chunks = [];
  let chunkLimitReached = false;
  parseSections: for (const { location, text, entryIndex } of result.sections) {
    for (let offset = 0; offset < text.length; offset += maxChunkChars) {
      const part = text.slice(offset, offset + maxChunkChars).trim();
      if (!part) continue;
      if (chunks.length === maxChunks) {
        chunkLimitReached = true;
        break parseSections;
      }
      chunks.push({ location: text.length > maxChunkChars ? `${location} · 片段 ${offset / maxChunkChars + 1}` : location, text: part, entryIndex });
    }
  }
  let { state, note, entries } = result;
  if (chunkLimitReached) {
    state = '部分已索引';
    note = [note, '达到本机索引上限'].filter(Boolean).join('，');
  }
  if (!chunks.length && state === '已索引') {
    state = '无可检索内容';
    note = '原文件已保存，未提取到可检索文字。';
  }
  return { chunks, state, note, entries };
}
