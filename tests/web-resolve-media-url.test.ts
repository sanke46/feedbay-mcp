import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMediaUrl } from '../src/web/resolve-media-url.js';

/**
 * Trello QXZI4KJu (25.09): ссылка на страницу Unsplash встала в вопрос как
 * «картинка», и в опросе оказалось не то. Ссылка проверяется сервером.
 */

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function answer(body: BodyInit | null, headers: Record<string, string>, status = 200) {
  return new Response(body, { status, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveMediaUrl', () => {
  it('картинка скачивается с настоящим размером и именем', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' })));
    const found = await resolveMediaUrl('https://cdn.example.com/a/panel.png', publicResolver);
    expect(found).toMatchObject({ kind: 'image', name: 'panel.png', mimeType: 'image/png' });
    expect(found.kind === 'image' && found.bytes.byteLength).toBe(3);
  });

  it('страница отдаёт свою картинку-превью (og:image)', async () => {
    const fetchMock = vi.fn(async (url: URL | string) =>
      String(url).includes('photos')
        ? answer('<html><head><meta property="og:image" content="https://images.example.com/p.jpg"></head></html>', {
            'content-type': 'text/html; charset=utf-8',
          })
        : answer(new Uint8Array(10), { 'content-type': 'image/jpeg' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const found = await resolveMediaUrl('https://unsplash.example.com/photos/abc', publicResolver);
    expect(found).toMatchObject({ kind: 'image', url: 'https://images.example.com/p.jpg', name: 'p.jpg' });
  });

  it('адрес превью декодируется из HTML (&amp; у Unsplash)', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string) => {
        seen.push(String(url));
        return String(url).includes('/photos/')
          ? answer('<meta property="og:image" content="https://images.example.com/photo-1?w=1200&amp;q=60"/>', { 'content-type': 'text/html' })
          : answer(new Uint8Array(4), { 'content-type': 'image/jpeg' });
      }),
    );
    await resolveMediaUrl('https://unsplash.example.com/photos/x', publicResolver);
    expect(seen[1]).toBe('https://images.example.com/photo-1?w=1200&q=60');
  });

  it('страница без превью — понятный отказ', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('<html><head></head></html>', { 'content-type': 'text/html' })));
    await expect(resolveMediaUrl('https://example.com/page', publicResolver)).rejects.toThrow(/web page, not a picture/);
  });

  it('видео не скачивается, размер берётся из ответа', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer('x', { 'content-type': 'video/mp4', 'content-length': '5242880' })),
    );
    const found = await resolveMediaUrl('https://cdn.example.com/demo.mp4', publicResolver);
    expect(found).toEqual({
      kind: 'video',
      url: 'https://cdn.example.com/demo.mp4',
      name: 'demo.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5242880,
    });
  });

  it('внутренний адрес не запрашивается вовсе', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      resolveMediaUrl('https://intranet.example.com/a.png', async () => [{ address: '10.0.0.5', family: 4 }]),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pdf — не медиа', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('x', { 'content-type': 'application/pdf' })));
    await expect(resolveMediaUrl('https://example.com/a.pdf', publicResolver)).rejects.toThrow(/not an image, video or audio/);
  });
});
