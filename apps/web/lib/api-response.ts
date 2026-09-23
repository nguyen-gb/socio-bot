// Never expose a JSON parser exception (or the contents of an HTML error page).
export async function readApiJson<T>(response: Response, endpoint: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const html = response.headers.get('content-type')?.includes('text/html')
      || /^\s*(?:<!doctype\s+html|<html)/i.test(text);
    throw new Error(`API ${endpoint} trả về ${html ? 'HTML thay vì JSON' : 'dữ liệu không phải JSON'} (HTTP ${response.status}). Hãy kiểm tra kết nối và dịch vụ API.`);
  }
}
