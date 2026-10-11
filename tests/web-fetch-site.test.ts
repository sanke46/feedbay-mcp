import { describe, expect, it } from 'vitest';
import {
  assertPublicHttps,
  isPrivateAddress,
  normalizeSiteUrl,
  UnsafeUrlError,
  type ResolvedAddress,
} from '../src/web/fetch-site.js';

/** Подставной разрешитель имени: зависимость передаётся явно, модуль не мокается. */
const resolves = (...addresses: ResolvedAddress[]) => async () => addresses;
const fails = () => async (): Promise<ResolvedAddress[]> => {
  throw new Error('ENOTFOUND');
};

/**
 * Защита от SSRF.
 *
 * ЭТО САМОЕ ОПАСНОЕ МЕСТО ВО ВСЁМ БЛОКЕ B. Адрес вводит человек, а запрос
 * уходит С НАШЕГО СЕРВЕРА — изнутри сети, где стоят Postgres, Redis, ClickHouse
 * и MinIO, ни один из которых наружу не смотрит. Поле «website URL» без этих
 * проверок означает буквально «сходи вот на этот внутренний адрес и покажи,
 * что там».
 */
describe('приватные адреса', () => {
  it('закрывает диапазоны, в которых живут наши же сервисы', () => {
    // Ровно те, что в docker-compose: postgres, redis, clickhouse, minio.
    expect(isPrivateAddress('127.0.0.1', 4)).toBe(true);
    expect(isPrivateAddress('10.0.0.5', 4)).toBe(true);
    expect(isPrivateAddress('172.17.0.2', 4)).toBe(true);
    expect(isPrivateAddress('192.168.1.1', 4)).toBe(true);
  });

  // Адрес метаданных облака — классическая цель SSRF: по нему отдаются ключи.
  it('закрывает link-local, включая метаданные облака', () => {
    expect(isPrivateAddress('169.254.169.254', 4)).toBe(true);
  });

  it('закрывает то, о чём забывают', () => {
    expect(isPrivateAddress('0.0.0.0', 4)).toBe(true);
    expect(isPrivateAddress('100.64.0.1', 4)).toBe(true); // CGNAT
    expect(isPrivateAddress('198.18.0.1', 4)).toBe(true); // benchmark
    expect(isPrivateAddress('224.0.0.1', 4)).toBe(true); // multicast
    expect(isPrivateAddress('192.0.0.1', 4)).toBe(true);
  });

  it('закрывает IPv6, в том числе отображённый IPv4', () => {
    expect(isPrivateAddress('::1', 6)).toBe(true);
    expect(isPrivateAddress('fc00::1', 6)).toBe(true);
    expect(isPrivateAddress('fe80::1', 6)).toBe(true);
    // Без разбора отображения ::ffff:10.0.0.1 прошёл бы как «какой-то IPv6».
    expect(isPrivateAddress('::ffff:10.0.0.1', 6)).toBe(true);
  });

  it('пропускает публичные', () => {
    expect(isPrivateAddress('93.184.216.34', 4)).toBe(false);
    expect(isPrivateAddress('8.8.8.8', 4)).toBe(false);
    expect(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946', 6)).toBe(false);
  });

  it('неразобранный адрес считается опасным, а не безопасным', () => {
    expect(isPrivateAddress('не-адрес', 4)).toBe(true);
    expect(isPrivateAddress('999.1.1.1', 4)).toBe(true);
  });
});

describe('проверка адреса перед запросом', () => {
  it('пропускает публичный https', async () => {
    await expect(
      assertPublicHttps('https://example.com/x', resolves({ address: '93.184.216.34', family: 4 })),
    ).resolves.toBeInstanceOf(URL);
  });

  it('отвергает всё, что не https', async () => {
    for (const bad of ['http://example.com', 'file:///etc/passwd', 'ftp://example.com']) {
      await expect(assertPublicHttps(bad)).rejects.toMatchObject({ code: 'NOT_HTTPS' });
    }
  });

  it('отвергает мусор вместо адреса', async () => {
    await expect(assertPublicHttps('не адрес')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('отвергает имя, указывающее внутрь сети', async () => {
    await expect(
      assertPublicHttps(
        'https://metadata.example.com',
        resolves({ address: '169.254.169.254', family: 4 }),
      ),
    ).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
  });

  // ВСЕ адреса имени, а не первый: имя может отдавать публичный и частный
  // вперемешку, и какой из них возьмёт сокет — от нас не зависит.
  it('отвергает имя, у которого хотя бы один адрес внутренний', async () => {
    await expect(
      assertPublicHttps(
        'https://mixed.example.com',
        resolves({ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }),
      ),
    ).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
  });

  it('неразрешимое имя — отказ, а не попытка сходить', async () => {
    await expect(assertPublicHttps('https://nope.example', fails())).rejects.toMatchObject({
      code: 'DNS_FAILED',
    });
  });

  it('ошибка остаётся опознаваемой по типу', async () => {
    await expect(
      assertPublicHttps('https://localhost.example', resolves({ address: '127.0.0.1', family: 4 })),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

// Trello MoggvCGt (25.09): голый домен падал INVALID_URL — и в блоке, и в чате.
describe('normalizeSiteUrl', () => {
  it.each([
    ['company.com', 'https://company.com'],
    ['  www.company.com/about ', 'https://www.company.com/about'],
    ['http://company.com', 'https://company.com'],
    ['https://company.com', 'https://company.com'],
    ['//company.com', 'https://company.com'],
    ['company.com:8443/x', 'https://company.com:8443/x'],
    ['ftp://company.com', 'ftp://company.com'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeSiteUrl(raw)).toBe(expected);
  });
});
