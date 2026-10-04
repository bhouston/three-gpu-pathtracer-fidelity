import { execFileSync } from 'node:child_process';

// Separate processes match the suite: Dawn and EGL do not reliably share globals.
for (const source of [
  `import { create } from 'webgpu';
   const gpu = create(['backend=vulkan', 'enable-dawn-features=allow_unsafe_apis']);
   const adapter = await gpu.requestAdapter();
   if (!adapter) throw new Error('No software WebGPU adapter');
   const info = JSON.stringify(Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(key => [key, adapter.info[key]])));
   console.log('Dawn:', info);
   if (!/llvmpipe|lavapipe/i.test(info)) throw new Error('Expected Mesa software WebGPU');
   process.exit(0);`,
  `import { createCanvas } from '@onirenaud/node-webgl';
   const canvas = createCanvas(16, 16);
   const gl = canvas.getContext('webgl2');
   const ext = gl.getExtension('WEBGL_debug_renderer_info');
   const info = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
   console.log('WebGL:', info);
   if (!/llvmpipe|softpipe/i.test(info)) throw new Error('Expected Mesa software WebGL');
   process.exit(0);`,
]) {
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'inherit',
    cwd: new URL('../packages/cli/', import.meta.url),
  });
}
