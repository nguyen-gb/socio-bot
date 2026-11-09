import { z } from 'zod';

const localeValue = z.string().trim().min(2).max(32);
const timezoneValue = z.string().trim().min(1).max(80);
const nonEmptyValue = z.string().trim().min(1).max(512);
const smallInteger = z.number().int().min(0).max(255);

const clientHintBrand = z.object({
  brand: nonEmptyValue,
  version: z.string().trim().min(1).max(32),
});

/** Supported coherent locale bundles shown by the dashboard. */
export const BROWSER_FINGERPRINT_PRESETS = [
  // Keep the default browser language list native-like: locale plus its base
  // language. English is not an implicit fallback for non-English profiles;
  // it should only be present when explicitly configured by the user.
  { locale: 'vi-VN', languages: ['vi-VN', 'vi'], timezones: ['Asia/Ho_Chi_Minh'] },
  { locale: 'en-US', languages: ['en-US', 'en'], timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] },
  { locale: 'en-GB', languages: ['en-GB', 'en'], timezones: ['Europe/London'] },
  { locale: 'ja-JP', languages: ['ja-JP', 'ja'], timezones: ['Asia/Tokyo'] },
  { locale: 'ko-KR', languages: ['ko-KR', 'ko'], timezones: ['Asia/Seoul'] },
  { locale: 'th-TH', languages: ['th-TH', 'th'], timezones: ['Asia/Bangkok'] },
  { locale: 'id-ID', languages: ['id-ID', 'id'], timezones: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] },
  { locale: 'zh-CN', languages: ['zh-CN', 'zh'], timezones: ['Asia/Shanghai'] },
  { locale: 'zh-TW', languages: ['zh-TW', 'zh'], timezones: ['Asia/Taipei'] },
  { locale: 'de-DE', languages: ['de-DE', 'de'], timezones: ['Europe/Berlin'] },
  { locale: 'fr-FR', languages: ['fr-FR', 'fr'], timezones: ['Europe/Paris'] },
  { locale: 'es-ES', languages: ['es-ES', 'es'], timezones: ['Europe/Madrid'] },
] as const;

const browserFingerprintCoreSchema = z.object({
  locale: localeValue,
  languages: z.array(localeValue).min(1).max(8),
  timezoneId: timezoneValue,
});

const browserFingerprintDeviceFields = {
  viewport: z.object({
    width: z.number().int().min(320).max(7680),
    height: z.number().int().min(240).max(4320),
  }),
  colorScheme: z.enum(['light', 'dark', 'no-preference']),
  deviceScaleFactor: z.number().min(0.5).max(3),
  features: z.object({
    canvas: z.boolean(),
    webgl: z.boolean(),
    gpu: z.boolean(),
    userAgent: z.boolean(),
    clientHints: z.boolean(),
  }).optional(),
  canvas: z.object({
    signature: nonEmptyValue.max(128),
    noise: z.tuple([smallInteger, smallInteger, smallInteger]),
  }),
  webgl: z.object({
    vendor: nonEmptyValue,
    renderer: nonEmptyValue,
  }),
  gpu: z.object({
    vendor: nonEmptyValue.max(80),
    architecture: nonEmptyValue.max(80),
    device: nonEmptyValue.max(120),
    description: nonEmptyValue.max(512),
  }),
  userAgent: nonEmptyValue.max(512),
  clientHints: z.object({
    brands: z.array(clientHintBrand).min(1).max(8),
    fullVersionList: z.array(clientHintBrand).min(1).max(8),
    mobile: z.literal(false),
    platform: z.enum(['Windows', 'Linux', 'macOS']),
    platformVersion: nonEmptyValue.max(80),
    architecture: nonEmptyValue.max(80),
    bitness: nonEmptyValue.max(16),
    model: z.string().max(120),
    uaFullVersion: nonEmptyValue.max(32),
  }),
} as const;

/** User-facing settings. Device details are generated and maintained by the runtime. */
const browserFingerprintAutoSchema = browserFingerprintCoreSchema.extend({
  mode: z.enum(['auto', 'native']),
  localeMode: z.enum(['auto', 'configured', 'native']),
});

/** Explicit full device settings retained for advanced/legacy profiles. */
const browserFingerprintCustomSchema = browserFingerprintCoreSchema.extend({
  mode: z.literal('custom'),
  ...browserFingerprintDeviceFields,
});

/** Profiles created by older versions of the dashboard. */
const browserFingerprintLegacySchema = browserFingerprintCoreSchema.extend(browserFingerprintDeviceFields);

function validateFingerprintCoherence(
  value: z.infer<typeof browserFingerprintCoreSchema>,
  context: z.RefinementCtx,
) {
  try { Intl.getCanonicalLocales(value.locale); }
  catch { context.addIssue({ code: 'custom', path: ['locale'], message: 'Invalid locale' }); }
  for (const [index, language] of value.languages.entries()) {
    try { Intl.getCanonicalLocales(language); }
    catch { context.addIssue({ code: 'custom', path: ['languages', index], message: 'Invalid language tag' }); }
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezoneId }); }
  catch { context.addIssue({ code: 'custom', path: ['timezoneId'], message: 'Invalid timezone' }); }
  const preset = BROWSER_FINGERPRINT_PRESETS.find((item) => item.locale === value.locale);
  if (preset) {
    const allowedLanguages = new Set<string>(preset.languages);
    for (const [index, language] of value.languages.entries()) {
      if (!allowedLanguages.has(language)) {
        context.addIssue({ code: 'custom', path: ['languages', index], message: `Language is not coherent with ${value.locale}` });
      }
    }
    if (!preset.timezones.some((timezone) => timezone === value.timezoneId)) {
      context.addIssue({ code: 'custom', path: ['timezoneId'], message: `Timezone is not coherent with ${value.locale}` });
    }
  }
}

/**
 * New profiles persist only the small `mode: auto` settings object. Full
 * device bundles remain accepted for backwards compatibility and advanced
 * profiles, but are no longer required from the dashboard.
 */
export const browserFingerprintSchema = z
  .union([browserFingerprintCustomSchema, browserFingerprintLegacySchema, browserFingerprintAutoSchema])
  .superRefine(validateFingerprintCoherence);

export type BrowserFingerprintSettings = z.infer<typeof browserFingerprintAutoSchema>;

export type BrowserFingerprintConfig = z.infer<typeof browserFingerprintSchema>;
