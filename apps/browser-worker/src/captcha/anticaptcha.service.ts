import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Page } from 'playwright';
import type { WorkerEnvironment } from '../config/environment';

export interface AntiCaptchaSolveResult {
  attempted: boolean;
  solved: boolean;
  reason?: string;
}

@Injectable()
export class AntiCaptchaService {
  private readonly logger = new Logger(AntiCaptchaService.name);
  private readonly apiKey?: string;
  private readonly recognitionUrl: string;
  private readonly resultUrl: string;
  private readonly autoSolve: boolean;
  private readonly timeoutMs: number;
  private readonly tikTokRotateInvert: boolean;
  private readonly attemptedPages = new WeakSet<object>();

  constructor(private readonly config: ConfigService<WorkerEnvironment, true>) {
    this.apiKey = config.get('anticaptchaApiKey', { infer: true });
    this.recognitionUrl = config.get('anticaptchaRecognitionUrl', { infer: true }) ?? 'https://anticaptcha.top/in.php';
    this.resultUrl = config.get('anticaptchaResultUrl', { infer: true }) ?? 'https://anticaptcha.top/res.php';
    this.autoSolve = config.get('anticaptchaAutoSolve', { infer: true });
    this.timeoutMs = config.get('anticaptchaTimeoutMs', { infer: true });
    this.tikTokRotateInvert = config.get('anticaptchaTikTokRotateInvert', { infer: true });
  }

  get enabled(): boolean {
    return this.autoSolve && Boolean(this.apiKey);
  }

  /**
   * AntiCaptcha.top's recognition API is asynchronous. Submit the two image
   * bodies to /in.php, then poll /res.php until it returns coordinates. The
   * current TikTok web response is `coordinates:x=0,y=170`.
   */
  async solveTikTokRotate(imageBase64s: readonly [string, string]): Promise<number> {
    this.logger.log('Submitting TikTok rotate CAPTCHA to AntiCaptcha.top');
    try {
      const taskId = await this.submitTikTokRecognition(imageBase64s);
      const result = await this.pollRecognitionResult(taskId);
      const ratio = normalizeTikTokRecognitionResult(result);
      return this.tikTokRotateInvert ? (ratio === 0 ? 0 : 1 - ratio) : ratio;
    } catch (error) {
      this.logger.warn(`AntiCaptcha.top TikTok rotate request failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Best-effort integration for standard reCAPTCHA token widgets. TikTok's
   * BDTuring/image challenges use solveTikTokRotate above instead.
   */
  async trySolveVisibleRecaptcha(page: Page): Promise<AntiCaptchaSolveResult> {
    if (!this.enabled) return { attempted: false, solved: false, reason: 'disabled' };
    if (this.attemptedPages.has(page)) return { attempted: true, solved: false, reason: 'already attempted for this page' };
    this.attemptedPages.add(page);

    let challenge: { siteKey?: string; action?: string; version: 'v2' | 'v3'; websiteURL: string };
    try {
      challenge = await page.evaluate(() => {
        const visible = (element: Element) => {
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const siteKeyElement = [...document.querySelectorAll<HTMLElement>('[data-sitekey], .g-recaptcha')]
          .find(visible);
        let siteKey = siteKeyElement?.getAttribute('data-sitekey') ?? undefined;
        const v2Iframe = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="recaptcha" i]')]
          .find(visible);
        if (!siteKey && v2Iframe) {
          try { siteKey = new URL(v2Iframe.src, window.location.href).searchParams.get('k') ?? undefined; }
          catch { /* A transient iframe URL is not a usable site key. */ }
        }
        if (!siteKey) {
          const script = [...document.scripts].find(item => /recaptcha\/api\.js/i.test(item.src));
          if (script) {
            try { siteKey = new URL(script.src, window.location.href).searchParams.get('render') ?? undefined; }
            catch { /* A malformed script URL is not a usable site key. */ }
          }
        }
        const action = document.querySelector<HTMLElement>('[data-action]')?.getAttribute('data-action') ?? undefined;
        return {
          siteKey,
          action,
          version: siteKeyElement || v2Iframe ? 'v2' : 'v3',
          websiteURL: window.location.href,
        };
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { attempted: true, solved: false, reason: `Could not inspect reCAPTCHA: ${reason}` };
    }

    const siteKey = challenge.siteKey;
    if (!siteKey) return { attempted: false, solved: false, reason: 'reCAPTCHA site key was not found' };

    try {
      const taskId = await this.submitTokenRecognition({ ...challenge, siteKey });
      const token = (await this.pollRecognitionResult(taskId)).trim();
      if (!token) return { attempted: true, solved: false, reason: 'AntiCaptcha.top returned no reCAPTCHA token' };

      const injectedFields = await page.evaluate((value) => {
        const fields = [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
          'textarea[name="g-recaptcha-response"],input[name="g-recaptcha-response"]',
        )];
        if (fields.length === 0 && document.body) {
          const field = document.createElement('textarea');
          field.name = 'g-recaptcha-response';
          field.style.display = 'none';
          document.body.append(field);
          fields.push(field);
        }
        for (const field of fields) {
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const clients = (window as unknown as {
          ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
        }).___grecaptcha_cfg?.clients;
        const seen = new Set<object>();
        const invokeCallback = (candidate: unknown): boolean => {
          if (!candidate || typeof candidate !== 'object') return false;
          if (seen.has(candidate)) return false;
          seen.add(candidate);
          for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
            if (/callback/i.test(key) && typeof nested === 'function') {
              (nested as (response: string) => void)(value);
              return true;
            }
            if (invokeCallback(nested)) return true;
          }
          return false;
        };
        invokeCallback(clients);
        return fields.length;
      }, token);

      return injectedFields > 0
        ? { attempted: true, solved: true }
        : { attempted: true, solved: false, reason: 'No reCAPTCHA response field was available' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AntiCaptcha.top auto-solve failed: ${reason}`);
      return { attempted: true, solved: false, reason };
    }
  }

  private async submitTikTokRecognition(imageBase64s: readonly [string, string]): Promise<string> {
    const response = await this.fetchJson(this.recognitionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        key: this.apiKey,
        method: 'base64',
        textinstructions: 'koleso',
        click: 'geetest',
        body0: imageBase64s[0],
        body1: imageBase64s[1],
        json: 1,
      }),
    });
    if (response.status !== 1 || typeof response.request !== 'string' || response.request.length === 0) {
      throw new Error(`AntiCaptcha.top submit failed: ${response.request ?? 'unknown error'}`);
    }
    return response.request;
  }

  private async submitTokenRecognition(challenge: {
    siteKey: string;
    action?: string;
    version: 'v2' | 'v3';
    websiteURL: string;
  }): Promise<string> {
    const response = await this.fetchJson(this.recognitionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        key: this.apiKey,
        method: 'userrecaptcha',
        ...(challenge.version === 'v3' ? { version: 'v3', action: challenge.action ?? 'validate_captcha' } : {}),
        googlekey: challenge.siteKey,
        pageurl: challenge.websiteURL,
        json: 1,
      }),
    });
    if (response.status !== 1 || typeof response.request !== 'string' || response.request.length === 0) {
      throw new Error(`AntiCaptcha.top reCAPTCHA submit failed: ${response.request ?? 'unknown error'}`);
    }
    return response.request;
  }

  private async pollRecognitionResult(taskId: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const url = new URL(this.resultUrl);
      url.searchParams.set('key', this.apiKey ?? '');
      url.searchParams.set('id', taskId);
      url.searchParams.set('json', '1');
      const response = await this.fetchJson(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 1 && typeof response.request === 'string' && response.request.length > 0) {
        return response.request;
      }
      if (response.status !== 0 || response.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`AntiCaptcha.top result failed: ${response.request ?? 'unknown error'}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    throw new Error('AntiCaptcha.top recognition timed out');
  }

  private async fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new Error(`AntiCaptcha.top request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error(`AntiCaptcha.top returned invalid JSON (HTTP ${response.status.toString()})`); }
    if (!response.ok || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error(`AntiCaptcha.top HTTP ${response.status.toString()}`);
    }
    return payload as Record<string, unknown>;
  }
}

function normalizeTikTokRecognitionResult(value: string): number {
  const coordinateMatch = value.match(/coordinates\s*:\s*x\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*=\s*(-?\d+(?:\.\d+)?)/i);
  if (coordinateMatch) {
    const x = Number(coordinateMatch[1]);
    const y = Number(coordinateMatch[2]);
    // docs2 uses y/271 for the current TikTok web response. Keep x/180 as a
    // compatibility fallback for the alternate coordinate form documented
    // by the same endpoint.
    const ratio = y !== 0 ? y / 271 : x / 180;
    if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) return ratio;
  }
  const legacyRotate = Number(value);
  if (Number.isFinite(legacyRotate) && legacyRotate >= 0 && legacyRotate <= 180) return legacyRotate / 180;
  throw new Error(`AntiCaptcha.top returned an invalid TikTok coordinate result: ${value}`);
}
