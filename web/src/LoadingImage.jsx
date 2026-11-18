// 复用 rengong LoadingPhoto 的加载、失败和重试状态。
// Lucian UX/UI Prompt #079 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#079
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { sessionExpired } from './authClient';

function retryUrl(src, attempt) {
  if (!attempt || /^(blob:|data:)/.test(src)) return src;
  const url = new URL(src, location.href);
  url.searchParams.set('image-retry', attempt);
  return url.href;
}

export function LoadingImage({ src, alt, width, height, srcSet, sizes, loading, fetchPriority, mediaType, className = '' }) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('loading');
  const [objectUrl, setObjectUrl] = useState('');
  const image = useRef(null);
  const source = mediaType ? objectUrl : retryUrl(src, attempt);

  useEffect(() => {
    setStatus('loading');
    if (!mediaType) return;
    const controller = new AbortController();
    let allocated = '';
    setObjectUrl('');
    async function load() {
      try {
        const response = await fetch(src, { signal: controller.signal, cache: 'no-store' });
        if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
        if (!response.ok) throw new Error('图片读取失败');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        allocated = URL.createObjectURL(new Blob([blob], { type: mediaType }));
        setObjectUrl(allocated);
      } catch {
        if (!controller.signal.aborted) setStatus('failed');
      }
    }
    void load();
    return () => { controller.abort(); if (allocated) URL.revokeObjectURL(allocated); };
  }, [src, mediaType, attempt]);

  useEffect(() => {
    const current = image.current;
    if (current?.complete && current.getAttribute('src')) setStatus(current.naturalWidth ? 'loaded' : 'failed');
  }, [source]);

  return <div className={'loading-image ' + className} data-state={status} style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}>
    {source && <img key={src + ':' + attempt} ref={image} src={source} alt={alt} width={width} height={height}
      srcSet={srcSet?.split(',').map(candidate => {
        const [path, size] = candidate.trim().split(/\s+/);
        return retryUrl(path, attempt) + ' ' + size;
      }).join(', ')} sizes={sizes} loading={loading} fetchPriority={fetchPriority}
      onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} />}
    {status === 'loading' && <span className="image-loading-label">正在加载图片</span>}
    {status === 'failed' && <div className="image-retry" role="status"><span>图片加载失败</span>
      <button type="button" className="button small" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />重新加载图片</button>
    </div>}
  </div>;
}
