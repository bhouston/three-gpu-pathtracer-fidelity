import type { LiveRenderer } from '@pathtracer-fidelity/renderers';

/** A wavefront update advances a bounce; only completed paths count as samples. */
export async function renderUntilSamples(
  renderer: LiveRenderer,
  target: number,
  completed: number,
  animationFrame: () => void,
): Promise<number> {
  renderer.setSampleLimit?.(target);
  let updates = 0;
  while (completed < target) {
    animationFrame();
    renderer.render();
    await new Promise((resolve) => setImmediate(resolve));
    const next = renderer.getCompletedSamples ? await renderer.getCompletedSamples() : renderer.frames;
    if (!Number.isFinite(next) || next < completed) throw new Error('Invalid renderer sample count');
    completed = next;
    // The pinned tracer caps bounce/transparent chains. Invalid GPU work must not loop forever.
    if (++updates > target * 256 + 128) throw new Error('Renderer did not complete the requested samples');
  }
  return completed;
}
