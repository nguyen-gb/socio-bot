/**
 * Conservative classification of an interactive verification screen.
 * A post that merely *mentions* CAPTCHA, robots or verification is not a
 * challenge. Never use this result to solve or bypass a site challenge.
 */
export type ChallengeSignal = 'url' | 'visible_widget' | 'page_title' | 'foreground_message' | 'short_interstitial';

export interface ChallengePageSignals {
  url: string;
  visibleWidget?: boolean;
  title?: string;
  foregroundText?: string;
  /** Text collected from a platform-specific visible challenge node. */
  visibleChallengeText?: string;
  bodyText?: string;
}

const challengeRoute = /^\/(?:checkpoint|challenge|captcha)(?:\/|$)/i;
const specificChallenge = /(?:captcha|recaptcha|hcaptcha|turnstile|security verification|security check|verify (?:to continue|your (?:identity|account)|you(?:'re| are) (?:a )?human)|confirm (?:that )?you(?:'re| are) (?:a )?human|unusual traffic|suspicious (?:activity|traffic)|xác minh (?:bảo mật|danh tính|để tiếp tục)|kiểm tra bảo mật|lưu lượng truy cập bất thường)/i;
const interstitialChallenge = /(?:captcha|recaptcha|hcaptcha|turnstile|security verification|verify to continue|verify (?:that )?you(?:'re| are) human|unusual traffic|xác minh (?:bảo mật|để tiếp tục)|kiểm tra bảo mật)/i;

export function classifyChallengePage(input: ChallengePageSignals): ChallengeSignal | null {
  try {
    if (challengeRoute.test(new URL(input.url).pathname)) return 'url';
  } catch { /* about:blank, malformed or transitional navigation */ }
  if (input.visibleWidget) return 'visible_widget';
  if (input.title && specificChallenge.test(input.title)) return 'page_title';
  // Headings/dialogs/alerts are primary UI; incidental page copy is not.
  if (input.foregroundText && specificChallenge.test(input.foregroundText.slice(0, 1200))) return 'foreground_message';
  if (input.visibleChallengeText && specificChallenge.test(input.visibleChallengeText.slice(0, 1200))) return 'foreground_message';
  const body = input.bodyText?.trim();
  // Only recognize text-only challenge interstitials, not normal content feeds.
  if (body && body.length <= 400 && interstitialChallenge.test(body)) return 'short_interstitial';
  return null;
}
