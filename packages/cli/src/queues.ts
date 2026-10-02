// Render jobs run on two concurrent lanes, CPU and GPU. Each lane runs one job at a time: GPU jobs never share GPU
// memory, and a CPU render keeps every core. A job that can run on either lane (Blender with `--blender-device auto`)
// goes to whichever lane is free first, and each lane takes its exclusive jobs before shared ones.

import type { RenderJob } from './render-process.js';

export const lanes = ['cpu', 'gpu'] as const;
export type Lane = (typeof lanes)[number];

/** Lanes a job may run on. Blender on `auto` can use either: the CPU lane renders it on CPU, the GPU lane on GPU. */
export function jobLanes(renderer: RenderJob['renderer'], blenderDevice: 'auto' | 'cpu' | 'gpu'): Lane[] {
  if (renderer !== 'blender') return ['gpu'];
  return blenderDevice === 'auto' ? ['cpu', 'gpu'] : [blenderDevice];
}

/**
 * Runs every job on one of its lanes, with the lanes working concurrently. `lanesOf` must return at least one lane per
 * job. Resolves when all jobs have run; `run` should report its own failures rather than reject.
 */
export async function runOnLanes<T>(
  jobs: readonly T[],
  lanesOf: (job: T) => readonly Lane[],
  run: (job: T, lane: Lane) => Promise<void>,
): Promise<void> {
  const pending = jobs.map((job) => ({ job, lanes: lanesOf(job) }));
  for (const entry of pending) if (entry.lanes.length === 0) throw new Error('Every job needs at least one lane');

  // jobs are taken synchronously, so the lanes never pick the same job
  function take(lane: Lane): T | undefined {
    let index = pending.findIndex((entry) => entry.lanes.length === 1 && entry.lanes[0] === lane);
    if (index < 0) index = pending.findIndex((entry) => entry.lanes.includes(lane));
    return index < 0 ? undefined : pending.splice(index, 1)[0]!.job;
  }

  async function work(lane: Lane): Promise<void> {
    for (let job = take(lane); job !== undefined; job = take(lane)) await run(job, lane);
  }

  await Promise.all(lanes.map(work));
}
