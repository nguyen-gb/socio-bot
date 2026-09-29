import { z } from 'zod';

export const FACEBOOK_MAX_IMAGES = 10;
export const FACEBOOK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FACEBOOK_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const facebookMediaIdsSchema = z.array(z.uuid()).max(FACEBOOK_MAX_IMAGES)
  .refine(ids => new Set(ids).size === ids.length, 'Không chọn ảnh trùng lặp').default([]);

export function imageContentType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
