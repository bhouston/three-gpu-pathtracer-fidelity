import { describe, expect, it } from 'vitest';
import { jobLanes, runOnLanes } from './queues.js';
import type { Lane } from './queues.js';

interface Job {
  id: string;
  lanes: Lane[];
  ms: number;
}

/** Runs jobs that take `ms` each; records which lane ran what, and the most jobs any lane ran at once. */
async function simulate(jobs: Job[]) {
  const ran: Record<Lane, string[]> = { cpu: [], gpu: [] };
  const active: Record<Lane, number> = { cpu: 0, gpu: 0 };
  let maxPerLane = 0;
  let maxTotal = 0;
  await runOnLanes(
    jobs,
    (job) => job.lanes,
    async (job, lane) => {
      active[lane]++;
      maxPerLane = Math.max(maxPerLane, active[lane]);
      maxTotal = Math.max(maxTotal, active.cpu + active.gpu);
      ran[lane].push(job.id);
      await new Promise((resolve) => setTimeout(resolve, job.ms));
      active[lane]--;
    },
  );
  return { ran, maxPerLane, maxTotal };
}

describe('runOnLanes', () => {
  it('runs the lanes concurrently, one job per lane at a time', async () => {
    const { ran, maxPerLane, maxTotal } = await simulate([
      { id: 'g1', lanes: ['gpu'], ms: 5 },
      { id: 'g2', lanes: ['gpu'], ms: 5 },
      { id: 'c1', lanes: ['cpu'], ms: 5 },
    ]);
    expect(ran).toEqual({ cpu: ['c1'], gpu: ['g1', 'g2'] });
    expect(maxPerLane).toBe(1);
    expect(maxTotal).toBe(2);
  });

  it('gives shared jobs to whichever lane is free, after its exclusive jobs', async () => {
    const { ran } = await simulate([
      { id: 'b1', lanes: ['cpu', 'gpu'], ms: 30 },
      { id: 'b2', lanes: ['cpu', 'gpu'], ms: 30 },
      { id: 'b3', lanes: ['cpu', 'gpu'], ms: 30 },
      { id: 'g1', lanes: ['gpu'], ms: 1 },
    ]);
    // the GPU lane runs its own job first, then takes shared jobs alongside the CPU lane
    expect(ran.gpu[0]).toBe('g1');
    expect(ran.cpu[0]).toBe('b1');
    expect([...ran.cpu, ...ran.gpu].toSorted()).toEqual(['b1', 'b2', 'b3', 'g1']);
    expect(ran.gpu.length).toBeGreaterThan(1);
  });

  it('rejects a job without lanes', async () => {
    await expect(
      runOnLanes(
        [1],
        () => [],
        async () => {},
      ),
    ).rejects.toThrow(/at least one lane/);
  });
});

describe('jobLanes', () => {
  it('puts path tracers on the GPU, and Blender where its device allows', () => {
    expect(jobLanes('webgl-legacy', 'cpu')).toEqual(['gpu']);
    expect(jobLanes('webgpu-new', 'auto')).toEqual(['gpu']);
    expect(jobLanes('blender', 'cpu')).toEqual(['cpu']);
    expect(jobLanes('blender', 'gpu')).toEqual(['gpu']);
    expect(jobLanes('blender', 'auto')).toEqual(['cpu', 'gpu']);
  });
});
