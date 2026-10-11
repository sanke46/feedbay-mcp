import { describe, expect, it } from 'vitest';
import { colorToHex, extractSignals, signalsAsText } from '../src/web/signals.js';

/**
 * Trello UoJ7SfQx (25.09): модели шёл плоский список hex из инлайнового CSS,
 * без чёрного и белого и без того, где цвет стоит, — ролей из этого не
 * вывести. Теперь цвета сгруппированы по месту и берутся из файлов стилей.
 */
const HTML = `<!doctype html><html><head>
<title>Brand</title>
<link rel="stylesheet" href="/wp-content/themes/brand/style.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope">
<style>:root{--wp--preset--color--primary:#B2DE01;--text-color:rgb(23,23,23)}</style>
</head><body style="color:#171717"></body></html>`;

const CSS = `
body { background-color: #FFFFFF; color: #171717; }
h1, h2 { color: #171717; }
a { color: hsl(221, 83%, 53%); }
.wp-block-button__link { background: #b2de01; color: #171717; }
.btn-primary { background-color: #B2DE01; }
.card { background: #F2F4F7; border-color: #E4E7EC; }
.shadow { box-shadow: 0 1px 2px rgba(0,0,0,0.1); background: rgba(0,0,0,0.05); }
`;

describe('extractSignals: цвета по месту', () => {
  const signals = extractSignals(HTML, 'https://brand.example/', CSS);

  it('находит файлы стилей сайта, но не шрифтовые', () => {
    expect(extractSignals(HTML, 'https://brand.example/').stylesheets).toEqual([
      'https://brand.example/wp-content/themes/brand/style.css',
    ]);
  });

  it('раскладывает цвета по месту, включая чёрный и белый', () => {
    expect(signals.colorGroups['page background']).toEqual(['#ffffff']);
    expect(signals.colorGroups.text[0]).toBe('#171717');
    expect(signals.colorGroups.buttons[0]).toBe('#b2de01');
    expect(signals.colorGroups.links[0]).toBe('#2463eb');
    expect(signals.colorGroups.surfaces).toContain('#f2f4f7');
    expect(signals.colorGroups.variables).toContain('--wp--preset--color--primary: #b2de01');
  });

  it('полупрозрачные тени не считаются цветом бренда', () => {
    expect(signals.colors).not.toContain('#000000');
  });

  it('модель получает группы строками', () => {
    const text = signalsAsText(signals, 'https://brand.example/');
    expect(text).toContain('Colours used for buttons: #b2de01');
    expect(text).toContain('Colours used for page background: #ffffff');
  });
});

describe('colorToHex', () => {
  it.each([
    ['#fff', '#ffffff'],
    ['#B2DE01', '#b2de01'],
    ['rgb(23, 23, 23)', '#171717'],
    ['rgba(178 222 1 / 1)', '#b2de01'],
    ['hsl(0, 0%, 100%)', '#ffffff'],
    ['rgba(0,0,0,0.1)', null],
    ['transparent', null],
  ])('%s → %s', (raw, expected) => {
    expect(colorToHex(raw)).toBe(expected);
  });
});
