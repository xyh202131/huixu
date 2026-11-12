import { useEffect, useRef } from 'react';

const textures = { ice: '/marble-ice.png', spectrum: '/marble-spectrum.png' };
const frameInterval = 1000 / 30;
const flowCycleSeconds = 18;

const vertexSource = `
  attribute vec2 position;
  varying vec2 point;

  void main() {
    point = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const fragmentSource = `
  precision mediump float;
  varying vec2 point;
  uniform sampler2D marble;
  uniform vec2 extent;
  uniform vec2 crop;
  uniform vec2 origin;
  uniform float phase;
  uniform float strength;

  void main() {
    vec2 p = point * extent / 190.0;
    vec2 current = vec2(
      sin(1.2 * p.x + 2.1 * p.y - phase + 0.55 * sin(1.9 * p.x + phase)),
      cos(1.8 * p.x - 1.4 * p.y - phase + 0.48 * sin(2.6 * p.y + phase))
    );
    vec2 ripple = vec2(sin(4.3 * (p.x + p.y) - 2.0 * phase), cos(4.8 * p.y - 2.6 * p.x + 2.0 * phase));
    vec2 edge = min(point, 1.0 - point) * extent;
    float taper = smoothstep(0.0, 12.0, min(edge.x, edge.y));
    vec2 offset = (current * vec2(6.0, 4.5) + ripple * 1.25) * strength * taper / extent;
    vec3 stone = texture2D(marble, origin + (point + offset) * crop).rgb;
    float light = 0.5 + 0.5 * cos(0.9 * p.x + 2.0 * p.y - phase + 0.36 * current.x);
    gl_FragColor = vec4(mix(stone, vec3(1.0, 0.99, 0.97), pow(light, 4.0) * 0.075 * strength), 1.0);
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createRenderer(canvas, image, strength) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  if (!gl || gl.isContextLost()) return null;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();

  function dispose() {
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    gl.deleteTexture(texture);
  }

  if (vertex && fragment && program) {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!vertex || !fragment || !program || !buffer || !texture || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    dispose();
    return null;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  if (gl.getError() !== gl.NO_ERROR) {
    dispose();
    return null;
  }

  const extent = gl.getUniformLocation(program, 'extent');
  const crop = gl.getUniformLocation(program, 'crop');
  const origin = gl.getUniformLocation(program, 'origin');
  const phase = gl.getUniformLocation(program, 'phase');
  gl.uniform1i(gl.getUniformLocation(program, 'marble'), 0);
  gl.uniform1f(gl.getUniformLocation(program, 'strength'), strength);

  return {
    resize(width, height) {
      const density = Math.min(window.devicePixelRatio || 1, 1.35, Math.sqrt(380000 / (width * height)));
      canvas.width = Math.max(1, Math.round(width * density));
      canvas.height = Math.max(1, Math.round(height * density));
      gl.viewport(0, 0, canvas.width, canvas.height);

      // 使用和静态底图相同的 cover 裁切，切换时纹脉位置保持连续。
      const fit = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const visibleX = width / (fit * image.naturalWidth);
      const visibleY = height / (fit * image.naturalHeight);
      const style = getComputedStyle(canvas);
      const anchorX = Number.parseFloat(style.getPropertyValue('--marble-x') || '50') / 100;
      const anchorY = Number.parseFloat(style.getPropertyValue('--marble-y') || '50') / 100;
      gl.uniform2f(extent, width, height);
      gl.uniform2f(crop, visibleX, visibleY);
      gl.uniform2f(origin, (1 - visibleX) * anchorX, (1 - visibleY) * anchorY);
    },
    draw(seconds) {
      gl.uniform1f(phase, (seconds % flowCycleSeconds) * 2 * Math.PI / flowCycleSeconds);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose,
  };
}

export function MarbleFlow({ variant = 'ice', strength = 1 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!('IntersectionObserver' in window) || !('ResizeObserver' in window)) return;
    const canvas = canvasRef.current;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const image = new Image();
    let visible = false;
    let unavailable = false;
    let renderer;
    let frame = 0;
    let lastDraw;
    let seconds = 0;

    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      lastDraw = undefined;
    }

    function resize() {
      if (!renderer) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (width > 0 && height > 0) renderer.resize(width, height);
    }

    function draw(now) {
      if (lastDraw === undefined || now - lastDraw >= frameInterval - 1) {
        if (lastDraw !== undefined) seconds += Math.min(now - lastDraw, 80) / 1000;
        renderer.draw(seconds);
        if (!canvas.hasAttribute('data-flowing')) canvas.setAttribute('data-flowing', '');
        lastDraw = now;
      }
      frame = requestAnimationFrame(draw);
    }

    function sync() {
      if (reducedMotion.matches) canvas.removeAttribute('data-flowing');
      if (!visible || document.hidden || reducedMotion.matches || unavailable) {
        stop();
        return;
      }
      if (!renderer && image.naturalWidth) {
        renderer = createRenderer(canvas, image, strength);
        unavailable = !renderer;
        resize();
      }
      if (renderer && !frame) frame = requestAnimationFrame(draw);
    }

    function loseContext(event) {
      event.preventDefault();
      stop();
      renderer = undefined;
      unavailable = true;
      canvas.removeAttribute('data-flowing');
    }

    function restoreContext() {
      unavailable = false;
      sync();
    }

    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    const dimensions = new ResizeObserver(resize);
    intersection.observe(canvas);
    dimensions.observe(canvas);
    reducedMotion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    canvas.addEventListener('webglcontextlost', loseContext);
    canvas.addEventListener('webglcontextrestored', restoreContext);
    image.onload = sync;
    image.src = textures[variant];

    return () => {
      stop();
      renderer?.dispose();
      canvas.removeAttribute('data-flowing');
      image.onload = null;
      intersection.disconnect();
      dimensions.disconnect();
      reducedMotion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
      canvas.removeEventListener('webglcontextlost', loseContext);
      canvas.removeEventListener('webglcontextrestored', restoreContext);
    };
  }, [variant, strength]);

  return <div className={`marble-flow marble-flow-${variant}`} aria-hidden="true"><canvas ref={canvasRef} /></div>;
}
