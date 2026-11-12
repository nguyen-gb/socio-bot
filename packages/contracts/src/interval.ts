import { z } from 'zod';

export interface IntervalRangeInput {
  intervalSeconds?: number;
  intervalMinSeconds?: number;
  intervalMaxSeconds?: number;
}

export function intervalRangeFields(max: number) {
  const seconds = z.number().int().min(5).max(max);
  return {
    // Kept for old campaigns and API clients. New forms submit the two range
    // fields and runtime code gives those fields priority.
    intervalSeconds: seconds.default(10),
    intervalMinSeconds: seconds.optional(),
    intervalMaxSeconds: seconds.optional(),
  };
}

export function refineIntervalRange(input: IntervalRangeInput, context: z.RefinementCtx): void {
  const [minimum, maximum] = normalizeIntervalRange(input);
  if (maximum < minimum) {
    context.addIssue({
      code: 'custom',
      path: ['intervalMaxSeconds'],
      message: 'Thời gian tối đa phải lớn hơn hoặc bằng thời gian tối thiểu',
    });
  }
}

export function normalizeIntervalRange(input: IntervalRangeInput, fallback = 10): [number, number] {
  const legacy = positiveInteger(input.intervalSeconds) ?? fallback;
  const minimum = positiveInteger(input.intervalMinSeconds) ?? legacy;
  const maximum = positiveInteger(input.intervalMaxSeconds) ?? minimum;
  return [minimum, maximum];
}

export function randomIntervalSeconds(input: IntervalRangeInput, random = Math.random): number {
  const [minimum, maximum] = normalizeIntervalRange(input);
  if (maximum <= minimum) return minimum;
  const boundedRandom = Math.min(Math.max(random(), 0), 0.9999999999999999);
  return minimum + Math.floor(boundedRandom * (maximum - minimum + 1));
}

export function maximumIntervalSeconds(input: IntervalRangeInput, fallback = 10): number {
  return normalizeIntervalRange(input, fallback)[1];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
